// ClearRelease — compliance-gated legal escrow, orchestrated by Chainlink CRE.
//
// Handlers (order = --trigger-index for `cre workflow simulate`):
//   0  HTTP trigger   ad-hoc screening for a list of addresses (no chain write). Lets a law firm's
//                     case-management system ask "can I pay these wallets?" and get an evidence record.
//   1  EVM log        ScreeningRequested on the escrow -> screen payer + payee -> signed report
//                     -> ClearReleaseEscrow releases / activates / freezes.
//   2  Cron           periodic re-screening of every open escrow (catches designations that happen
//                     AFTER onboarding) -> one batched signed report.
import {
  bytesToHex,
  type CronPayload,
  consensusIdenticalAggregation,
  cre,
  decodeJson,
  getNetwork,
  type HTTPPayload,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk'
import type { Address } from 'viem'
import { z } from 'zod'
import { ClearReleaseEscrow, type DecodedLog, type ScreeningRequestedDecoded } from './bindings/ClearReleaseEscrow'
import {
  decideEscrow,
  decideParty,
  encodeScreeningReport,
  evidenceHash,
  type ListSnapshot,
  type PartyResult,
  safeJson,
  uniqueAddresses,
  VERDICT_CLEAR,
  VERDICT_HIT,
} from './screening'
import { fetchListSnapshot, readSanctionsOracle } from './sources'

// ─── Config ────────────────────────────────────────────────────────────────

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address')

export const configSchema = z.object({
  escrow: z.object({
    chainSelectorName: z.string(), // e.g. ethereum-testnet-sepolia
    address: hexAddress,
    gasLimit: z.string().default('1000000'),
    logConfidence: z.enum(['CONFIDENCE_LEVEL_SAFE', 'CONFIDENCE_LEVEL_LATEST', 'CONFIDENCE_LEVEL_FINALIZED']).default('CONFIDENCE_LEVEL_SAFE'),
  }),
  sanctionsList: z.object({
    repo: z.string().default('0xB10C/ofac-sanctioned-digital-currency-addresses'),
    branch: z.string().default('lists'),
    file: z.string().default('sanctioned_addresses_ETH.json'),
  }),
  oracle: z.object({
    enabled: z.boolean().default(true),
    required: z.boolean().default(true), // CLEAR needs a "not sanctioned" answer from the oracle too
    chainSelectorName: z.string().default('ethereum-mainnet'),
    address: hexAddress.default('0x40C57923924B5c5c5455c48D93317139ADDaC8fb'), // Chainalysis SanctionsList
    multicall3: hexAddress.default('0xcA11bde05977b3631167028862bE2a173976CA11'),
  }),
  schedule: z.string().default('0 0 */6 * * *'), // every 6 hours (6-field cron, seconds first)
  maxEscrowsPerRun: z.number().int().min(1).max(15).default(10),
  maxAdHocAddresses: z.number().int().min(1).max(30).default(20),
})
export type Config = z.infer<typeof configSchema>

// ─── Shared screening step ─────────────────────────────────────────────────

export type ScreeningOutcome = {
  checkedAt: bigint
  snapshot: ListSnapshot | null
  parties: PartyResult[]
  evidenceHash: `0x${string}`
  errors: string[]
}

const evmClientFor = (chainSelectorName: string) => {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName })
  if (!network) throw new Error(`unknown chain: ${chainSelectorName}`)
  return new cre.capabilities.EVMClient(network.chainSelector.selector)
}

/** Screens addresses against both sources. Never throws for a single source failure: fails closed. */
export const screenAddresses = (runtime: Runtime<Config>, raw: readonly string[]): ScreeningOutcome => {
  const cfg = runtime.config
  const addresses = uniqueAddresses(raw)
  const errors: string[] = []
  // DON-agreed time; the escrow only accepts a CLEAR that post-dates the request it answers.
  const checkedAt = BigInt(Math.floor(runtime.now().getTime() / 1000))

  // Source 1: OFAC SDN-derived list over HTTP, identical consensus across nodes.
  let snapshot: ListSnapshot | null = null
  try {
    snapshot = new cre.capabilities.HTTPClient()
      .sendRequest(runtime, fetchListSnapshot, consensusIdenticalAggregation<ListSnapshot>())(
        cfg.sanctionsList,
        addresses.join(','),
      )
      .result()
    runtime.log(`OFAC list @${snapshot.commit.slice(0, 10)} size=${snapshot.listSize} hash=${snapshot.listHash.slice(0, 18)}…`)
  } catch (e) {
    errors.push(`ofac-list: ${(e as Error).message}`)
    runtime.log(`OFAC list unavailable: ${(e as Error).message}`)
  }

  // Source 2: Chainalysis Sanctions Oracle on Ethereum mainnet (cross-chain read).
  let oracle: (boolean | null)[] = addresses.map(() => null)
  if (cfg.oracle.enabled && addresses.length > 0) {
    try {
      oracle = readSanctionsOracle(
        runtime,
        evmClientFor(cfg.oracle.chainSelectorName),
        cfg.oracle.multicall3 as Address,
        cfg.oracle.address as Address,
        addresses,
      )
    } catch (e) {
      errors.push(`chainalysis-oracle: ${(e as Error).message}`)
      runtime.log(`Sanctions oracle unavailable: ${(e as Error).message}`)
    }
  }

  const parties = addresses.map((a, i) =>
    decideParty(
      a,
      snapshot ? snapshot.flags[i] === '1' : null,
      oracle[i] ?? null,
      cfg.oracle.enabled && cfg.oracle.required,
    ),
  )
  for (const p of parties) {
    runtime.log(`  ${p.address}  list=${p.ofacList}  oracle=${p.chainalysisOracle}  => ${p.verdict}`)
  }
  return { checkedAt, snapshot, parties, evidenceHash: evidenceHash({ snapshot, parties, checkedAt }), errors }
}

const evidenceRecord = (o: ScreeningOutcome) => ({
  version: 'clearrelease/v1',
  checkedAt: o.checkedAt,
  evidenceHash: o.evidenceHash,
  ofacList: o.snapshot
    ? { commit: o.snapshot.commit, listHash: o.snapshot.listHash, listSize: o.snapshot.listSize }
    : null,
  parties: o.parties,
  errors: o.errors,
})

const partyOf = (o: ScreeningOutcome, a: string): PartyResult => {
  const p = o.parties.find((x) => x.address.toLowerCase() === a.toLowerCase())
  if (!p) throw new Error(`party not screened: ${a}`)
  return p
}

const writeDecisions = (
  runtime: Runtime<Config>,
  escrow: ClearReleaseEscrow,
  o: ScreeningOutcome,
  ids: bigint[],
  verdicts: number[],
): string => {
  const payload = encodeScreeningReport(o.checkedAt, o.evidenceHash, ids, verdicts)
  const res = escrow.writeReport(runtime, payload, { gasLimit: runtime.config.escrow.gasLimit })
  if (res.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`report write failed: ${res.errorMessage ?? res.txStatus}`)
  }
  const txHash = bytesToHex(res.txHash ?? new Uint8Array(32))
  runtime.log(`Signed report delivered for escrows [${ids.join(', ')}] tx=${txHash}`)
  return txHash
}

const verdictName = (v: number | null) => (v === VERDICT_CLEAR ? 'CLEAR' : v === VERDICT_HIT ? 'HIT' : 'INCONCLUSIVE')

const escrowContract = (cfg: Config) =>
  new ClearReleaseEscrow(evmClientFor(cfg.escrow.chainSelectorName), cfg.escrow.address as Address)

// ─── Handler 0: HTTP ad-hoc screening ──────────────────────────────────────

const adHocSchema = z.object({ addresses: z.array(z.string()).min(1) })

export const onAdHocScreening = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const req = adHocSchema.parse(decodeJson(payload.input))
  if (req.addresses.length > runtime.config.maxAdHocAddresses) {
    throw new Error(`too many addresses (max ${runtime.config.maxAdHocAddresses})`)
  }
  runtime.log(`Ad-hoc screening of ${req.addresses.length} address(es)`)
  return safeJson(evidenceRecord(screenAddresses(runtime, req.addresses)))
}

// ─── Handler 1: escrow event ───────────────────────────────────────────────

const PURPOSES = ['none', 'onboarding', 'release', 'review']

export const onScreeningRequested = (
  runtime: Runtime<Config>,
  log: DecodedLog<ScreeningRequestedDecoded>,
): string => {
  const { id, purpose, payer, payee } = log.data
  runtime.log(`ScreeningRequested escrow=${id} purpose=${PURPOSES[purpose] ?? purpose} payer=${payer} payee=${payee}`)

  const outcome = screenAddresses(runtime, [payer, payee])
  const verdict = decideEscrow(partyOf(outcome, payer), partyOf(outcome, payee))
  const result = { escrowId: id, purpose: PURPOSES[purpose] ?? String(purpose), verdict: verdictName(verdict), evidence: evidenceRecord(outcome) }

  if (verdict === null) {
    runtime.log('Inconclusive: no report written (fail closed). The cron handler will retry.')
    return safeJson({ ...result, txHash: null })
  }
  const txHash = writeDecisions(runtime, escrowContract(runtime.config), outcome, [id], [verdict])
  return safeJson({ ...result, txHash })
}

// ─── Handler 2: periodic monitoring ────────────────────────────────────────

export const onPeriodicScreening = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const escrow = escrowContract(runtime.config)
  const open = escrow.listOpen(runtime, 1n, BigInt(runtime.config.maxEscrowsPerRun))
  runtime.log(`Periodic screening: ${open.ids.length} open escrow(s)`)
  if (open.ids.length === 0) return safeJson({ screened: 0 })

  const outcome = screenAddresses(runtime, [...open.payers, ...open.payees])
  const ids: bigint[] = []
  const verdicts: number[] = []
  const summary: { escrowId: bigint; verdict: string }[] = []
  open.ids.forEach((id, i) => {
    const v = decideEscrow(partyOf(outcome, open.payers[i]), partyOf(outcome, open.payees[i]))
    summary.push({ escrowId: id, verdict: verdictName(v) })
    if (v !== null) {
      ids.push(id)
      verdicts.push(v)
    }
  })

  const txHash = ids.length ? writeDecisions(runtime, escrow, outcome, ids, verdicts) : null
  return safeJson({ screened: open.ids.length, summary, txHash, evidence: evidenceRecord(outcome) })
}

// ─── Init ──────────────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
  const escrow = escrowContract(config)
  return [
    cre.handler(new cre.capabilities.HTTPCapability().trigger({}), onAdHocScreening),
    cre.handler(escrow.logTriggerScreeningRequested(config.escrow.logConfidence), onScreeningRequested),
    cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onPeriodicScreening),
  ]
}
