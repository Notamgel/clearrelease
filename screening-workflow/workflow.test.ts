import { describe, expect } from 'bun:test'
import { getNetwork } from '@chainlink/cre-sdk'
import {
  addContractMock,
  EvmMock,
  HttpActionsMock,
  newTestRuntime,
  REPORT_METADATA_HEADER_LENGTH,
  test,
} from '@chainlink/cre-sdk/test'
import { type Address, bytesToHex, decodeAbiParameters, encodeFunctionResult, parseAbi, parseAbiParameters } from 'viem'
import { ClearReleaseEscrowABI } from './bindings/ClearReleaseEscrow'
import { configSchema, initWorkflow, onAdHocScreening, onPeriodicScreening, onScreeningRequested } from './workflow'

// ─── fixtures ────────────────────────────────────────────────────────────────
const ESCROW = '0x00000000000000000000000000000000000e5c20' as Address
const PAYER = '0x1111111111111111111111111111111111111111' as Address
const PAYEE = '0x2222222222222222222222222222222222222222' as Address
const SDN_ADDR = '0x0330070FD38Ec3bB94F58FA55D40368271E9e54A' as Address // on the OFAC list AND in the oracle
const LIST_ONLY = '0x038989cbb1710c72b9920dc4fa529158f463e72c' as Address // on the OFAC list, NOT in the oracle
const COMMIT = '9f'.repeat(20)
const NOW_MS = 1_793_000_000_000

const SEPOLIA = getNetwork({ chainFamily: 'evm', chainSelectorName: 'ethereum-testnet-sepolia' })!.chainSelector.selector
const MAINNET = getNetwork({ chainFamily: 'evm', chainSelectorName: 'ethereum-mainnet' })!.chainSelector.selector

const config = configSchema.parse({
  escrow: { chainSelectorName: 'ethereum-testnet-sepolia', address: ESCROW },
  sanctionsList: {},
  oracle: {},
})

const MULTICALL = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const ORACLE = parseAbi(['function isSanctioned(address addr) view returns (bool)'])

/** Mocks the HTTP capability: GitHub ref lookup + raw list at that commit. */
function mockHttp(opts: { list?: string[]; failList?: boolean } = {}) {
  const http = HttpActionsMock.testInstance()
  const calls: string[] = []
  http.sendRequest = (req) => {
    calls.push(req.url)
    const body = (o: unknown) => ({ statusCode: 200, body: Buffer.from(JSON.stringify(o)).toString('base64') })
    if (req.url.includes('/git/ref/heads/lists')) return body({ object: { sha: COMMIT } })
    if (req.url.includes(`/${COMMIT}/sanctioned_addresses_ETH.json`)) {
      if (opts.failList) return { statusCode: 503, body: '' }
      return body(opts.list ?? [SDN_ADDR, LIST_ONLY])
    }
    return { statusCode: 404, body: '' }
  }
  return calls
}

/** Mocks the Chainalysis oracle (via Multicall3) on mainnet. */
function mockOracle(sanctioned: string[], opts: { fail?: boolean } = {}) {
  const evm = EvmMock.testInstance(MAINNET)
  const mc = addContractMock(evm, { address: config.oracle.multicall3 as Address, abi: MULTICALL }) as any
  const set = new Set(sanctioned.map((a) => a.toLowerCase()))
  mc.aggregate3 = (calls: readonly { callData: `0x${string}` }[]) => {
    if (opts.fail) throw new Error('rpc down')
    return calls.map((c) => {
      const addr = `0x${c.callData.slice(-40)}`.toLowerCase()
      return { success: true, returnData: encodeFunctionResult({ abi: ORACLE, functionName: 'isSanctioned', result: set.has(addr) }) }
    })
  }
}

/** Mocks the escrow on Sepolia and captures every signed report. */
function mockEscrow(open?: { ids: bigint[]; payers: Address[]; payees: Address[]; statuses: number[] }) {
  const evm = EvmMock.testInstance(SEPOLIA)
  const escrow = addContractMock(evm, { address: ESCROW, abi: ClearReleaseEscrowABI }) as any
  const reports: { checkedAt: bigint; evidence: string; ids: readonly bigint[]; verdicts: readonly number[] }[] = []
  if (open) escrow.listOpen = () => [open.ids, open.payers, open.payees, open.statuses]
  escrow.writeReport = (input: { report: { rawReport: Uint8Array } }) => {
    const payload = bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))
    const [checkedAt, evidence, ids, verdicts] = decodeAbiParameters(
      parseAbiParameters('uint64, bytes32, uint256[], uint8[]'),
      payload,
    )
    reports.push({ checkedAt, evidence, ids, verdicts })
    return { txStatus: 'TX_STATUS_SUCCESS', txHash: Buffer.from('ab'.repeat(32), 'hex').toString('base64') }
  }
  return reports
}

const runtime = () => newTestRuntime(null, { timeProvider: () => NOW_MS }, config) as any
const event = (payer: Address, payee: Address, id = 7n, purpose = 2) =>
  ({ data: { id, purpose, payer, payee } }) as any

// ─── tests ───────────────────────────────────────────────────────────────────
describe('initWorkflow', () => {
  test('registers HTTP, log and cron handlers in that order', () => {
    const handlers = initWorkflow(config)
    expect(handlers).toHaveLength(3)
    expect(handlers[0].fn).toBe(onAdHocScreening)
    expect(handlers[1].fn).toBe(onScreeningRequested)
    expect(handlers[2].fn).toBe(onPeriodicScreening)
  })
})

describe('onScreeningRequested (EVM log trigger)', () => {
  test('clean parties -> CLEAR report with DON timestamp and evidence hash', () => {
    const calls = mockHttp()
    mockOracle([SDN_ADDR])
    const reports = mockEscrow()
    const out = JSON.parse(onScreeningRequested(runtime(), event(PAYER, PAYEE)))
    expect(out.verdict).toBe('CLEAR')
    expect(out.evidence.ofacList.commit).toBe(COMMIT)
    expect(calls[1]).toContain(`/${COMMIT}/`) // list pinned to the resolved commit
    expect(reports).toHaveLength(1)
    expect(reports[0].ids).toEqual([7n])
    expect(reports[0].verdicts).toEqual([1])
    expect(reports[0].checkedAt).toBe(BigInt(NOW_MS / 1000))
    expect(reports[0].evidence).toBe(out.evidence.evidenceHash)
  })

  test('payee only on the OFAC list (oracle lags) -> HIT, escrow gets frozen', () => {
    mockHttp()
    mockOracle([SDN_ADDR])
    const reports = mockEscrow()
    const out = JSON.parse(onScreeningRequested(runtime(), event(PAYER, LIST_ONLY)))
    expect(out.verdict).toBe('HIT')
    const payee = out.evidence.parties.find((p: any) => p.address.toLowerCase() === LIST_ONLY)
    expect(payee).toMatchObject({ ofacList: true, chainalysisOracle: false, verdict: 'HIT' })
    expect(reports[0].verdicts).toEqual([2])
  })

  test('list source down -> oracle HIT still freezes', () => {
    mockHttp({ failList: true })
    mockOracle([SDN_ADDR])
    const reports = mockEscrow()
    const out = JSON.parse(onScreeningRequested(runtime(), event(SDN_ADDR, PAYEE)))
    expect(out.verdict).toBe('HIT')
    expect(out.evidence.errors[0]).toContain('ofac-list')
    expect(reports[0].verdicts).toEqual([2])
  })

  test('list source down and no hit -> INCONCLUSIVE, nothing written (fail closed)', () => {
    mockHttp({ failList: true })
    mockOracle([])
    const reports = mockEscrow()
    const out = JSON.parse(onScreeningRequested(runtime(), event(PAYER, PAYEE)))
    expect(out.verdict).toBe('INCONCLUSIVE')
    expect(out.txHash).toBeNull()
    expect(reports).toHaveLength(0)
  })

  test('oracle down and no hit -> INCONCLUSIVE (oracle required by default)', () => {
    mockHttp()
    mockOracle([], { fail: true })
    const reports = mockEscrow()
    const out = JSON.parse(onScreeningRequested(runtime(), event(PAYER, PAYEE)))
    expect(out.verdict).toBe('INCONCLUSIVE')
    expect(reports).toHaveLength(0)
  })
})

describe('onPeriodicScreening (cron)', () => {
  test('re-screens all open escrows and writes one batched report', () => {
    mockHttp()
    mockOracle([SDN_ADDR])
    const reports = mockEscrow({
      ids: [1n, 2n, 3n],
      payers: [PAYER, PAYER, SDN_ADDR],
      payees: [PAYEE, LIST_ONLY, PAYEE],
      statuses: [2, 2, 3],
    })
    const out = JSON.parse(onPeriodicScreening(runtime(), {} as any))
    expect(out.screened).toBe(3)
    expect(reports).toHaveLength(1)
    expect(reports[0].ids).toEqual([1n, 2n, 3n])
    expect(reports[0].verdicts).toEqual([1, 2, 2])
    // 4 unique parties screened once each, not 6
    expect(out.evidence.parties).toHaveLength(4)
  })

  test('no open escrows -> no reads of the sources, no write', () => {
    const calls = mockHttp()
    mockOracle([])
    const reports = mockEscrow({ ids: [], payers: [], payees: [], statuses: [] })
    expect(JSON.parse(onPeriodicScreening(runtime(), {} as any))).toEqual({ screened: 0 })
    expect(calls).toHaveLength(0)
    expect(reports).toHaveLength(0)
  })
})

describe('onAdHocScreening (HTTP trigger)', () => {
  test('returns an evidence record, writes nothing', () => {
    mockHttp()
    mockOracle([SDN_ADDR])
    const reports = mockEscrow()
    const input = Buffer.from(JSON.stringify({ addresses: [PAYER, SDN_ADDR, LIST_ONLY] }))
    const out = JSON.parse(onAdHocScreening(runtime(), { input } as any))
    expect(out.parties.map((p: any) => p.verdict)).toEqual(['CLEAR', 'HIT', 'HIT'])
    expect(out.ofacList.listSize).toBe('2')
    expect(reports).toHaveLength(0)
  })

  test('rejects oversized requests', () => {
    const many = Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
    const input = Buffer.from(JSON.stringify({ addresses: many }))
    expect(() => onAdHocScreening(runtime(), { input } as any)).toThrow('too many addresses')
  })
})
