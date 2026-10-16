// Typed CRE binding for ClearReleaseEscrow.sol.
// Same shape as the code produced by `cre generate-bindings evm`, kept small and readable.
import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, zeroAddress } from 'viem'
import type { Address, Hex } from 'viem'
import {
  bytesToHex,
  encodeCallMsg,
  type EVMClient,
  type EVMLog,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  type Runtime,
} from '@chainlink/cre-sdk'
import { ClearReleaseEscrowABI } from './ClearReleaseEscrowAbi'

export { ClearReleaseEscrowABI }

export interface DecodedLog<T> extends Omit<EVMLog, 'data'> {
  data: T
}

export type ScreeningRequestedDecoded = {
  id: bigint
  purpose: number
  payer: Address
  payee: Address
}

export type OpenEscrows = {
  ids: readonly bigint[]
  payers: readonly Address[]
  payees: readonly Address[]
  statuses: readonly number[]
}

export class ClearReleaseEscrow {
  constructor(
    private readonly client: EVMClient,
    public readonly address: Address,
  ) {}

  /** Paginated list of escrows the periodic screening should cover. */
  listOpen(runtime: Runtime<unknown>, startId: bigint, maxItems: bigint): OpenEscrows {
    const data = encodeFunctionData({ abi: ClearReleaseEscrowABI, functionName: 'listOpen', args: [startId, maxItems] })
    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()
    const [ids, payers, payees, statuses] = decodeFunctionResult({
      abi: ClearReleaseEscrowABI,
      functionName: 'listOpen',
      data: bytesToHex(result.data),
    }) as readonly [readonly bigint[], readonly Address[], readonly Address[], readonly number[]]
    return { ids, payers, payees, statuses }
  }

  /** Signs `payload` with the DON (runtime.report) and submits it through the CRE forwarder. */
  writeReport(runtime: Runtime<unknown>, payload: Hex, gasConfig?: { gasLimit?: string }) {
    const report = runtime.report(prepareReportRequest(payload)).result()
    return this.client.writeReport(runtime, { receiver: this.address, report, gasConfig }).result()
  }

  /** EVM log trigger for ScreeningRequested(uint256 indexed id, uint8 purpose, address payer, address payee). */
  logTriggerScreeningRequested(
    confidence: 'CONFIDENCE_LEVEL_SAFE' | 'CONFIDENCE_LEVEL_LATEST' | 'CONFIDENCE_LEVEL_FINALIZED' = 'CONFIDENCE_LEVEL_SAFE',
  ) {
    const topics = encodeEventTopics({ abi: ClearReleaseEscrowABI, eventName: 'ScreeningRequested' }).map((t) => ({
      values: t == null ? [] : [hexToBase64(t as Hex)],
    }))
    const base = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
      confidence,
    })
    const self = this
    return {
      capabilityId: () => base.capabilityId(),
      method: () => base.method(),
      outputSchema: () => base.outputSchema(),
      configAsAny: () => base.configAsAny(),
      adapt: (raw: EVMLog): DecodedLog<ScreeningRequestedDecoded> => self.decodeScreeningRequested(raw),
    }
  }

  decodeScreeningRequested(log: EVMLog): DecodedLog<ScreeningRequestedDecoded> {
    const decoded = decodeEventLog({
      abi: ClearReleaseEscrowABI,
      eventName: 'ScreeningRequested',
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _ignored, ...rest } = log
    return { ...rest, data: decoded.args as unknown as ScreeningRequestedDecoded }
  }
}
