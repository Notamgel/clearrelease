// The two independent screening sources.
//
//  1. OFAC SDN "Digital Currency Address - ETH" entries, as published by the open-source
//     0xB10C/ofac-sanctioned-digital-currency-addresses project (auto-generated from the official
//     SDN XML). Fetched with the CRE HTTP capability: every DON node fetches the same git commit,
//     and consensusIdenticalAggregation only accepts a result that the nodes agree on.
//     The official SDN.CSV (~5.7 MB) exceeds CRE's 250 KB HTTP response limit, which is why a
//     pinned, derived list is used. A production deployment would add a vendor API (Chainalysis,
//     TRM, Elliptic) through Confidential HTTP with the API key kept in CRE secrets.
//
//  2. The Chainalysis on-chain Sanctions Oracle on Ethereum mainnet, read through Multicall3 with
//     the CRE EVM read capability at the last finalized block (cross-chain read: the escrow lives
//     on Sepolia, the oracle on mainnet).
import {
  bytesToHex,
  type EVMClient,
  encodeCallMsg,
  type HTTPSendRequester,
  json,
  LAST_FINALIZED_BLOCK_NUMBER,
  ok,
  type Runtime,
} from '@chainlink/cre-sdk'
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { flagsFor, hashList, type ListSnapshot, normaliseList } from './screening'

export type ListSourceConfig = {
  repo: string // e.g. "0xB10C/ofac-sanctioned-digital-currency-addresses"
  branch: string // e.g. "lists"
  file: string // e.g. "sanctioned_addresses_ETH.json"
}

const HEADERS = { 'User-Agent': 'clearrelease-cre-workflow', Accept: 'application/json' }

/**
 * Runs on every DON node (node mode). Two requests:
 *   a) resolve the branch head to an immutable commit SHA (tiny JSON)
 *   b) download the list at that exact commit, so the decision is reproducible later.
 * Returns only strings so identical-consensus is exact across nodes.
 */
export const fetchListSnapshot = (
  sendRequester: HTTPSendRequester,
  src: ListSourceConfig,
  addressesCsv: string,
): ListSnapshot => {
  const refUrl = `https://api.github.com/repos/${src.repo}/git/ref/heads/${src.branch}`
  const refResp = sendRequester.sendRequest({ url: refUrl, method: 'GET', headers: HEADERS }).result()
  if (!ok(refResp)) throw new Error(`list ref lookup failed: HTTP ${refResp.statusCode}`)
  const commit: unknown = (json(refResp) as { object?: { sha?: unknown } })?.object?.sha
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('list ref: bad commit sha')

  const listUrl = `https://raw.githubusercontent.com/${src.repo}/${commit}/${src.file}`
  const listResp = sendRequester.sendRequest({ url: listUrl, method: 'GET', headers: HEADERS }).result()
  if (!ok(listResp)) throw new Error(`list download failed: HTTP ${listResp.statusCode}`)
  const normalised = normaliseList(json(listResp))

  const addresses = addressesCsv.length ? addressesCsv.split(',') : []
  return {
    commit,
    listHash: hashList(normalised),
    listSize: String(normalised.length),
    flags: flagsFor(normalised, addresses),
  }
}

const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const ORACLE_ABI = parseAbi(['function isSanctioned(address addr) view returns (bool)'])

/** Max addresses per Multicall3 call, to stay well under CRE's 5 KB EVM read payload limit. */
export const ORACLE_CHUNK = 16

/**
 * Reads Chainalysis `isSanctioned(addr)` for every address. Returns null for an address whose
 * sub-call failed, so the policy can treat it as "source unavailable" rather than "clear".
 */
export const readSanctionsOracle = (
  runtime: Runtime<unknown>,
  client: EVMClient,
  multicall3: Address,
  oracle: Address,
  addresses: readonly Address[],
): (boolean | null)[] => {
  const out: (boolean | null)[] = []
  for (let i = 0; i < addresses.length; i += ORACLE_CHUNK) {
    const chunk = addresses.slice(i, i + ORACLE_CHUNK)
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [
        chunk.map((a) => ({
          target: oracle,
          allowFailure: true,
          callData: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'isSanctioned', args: [a] }),
        })),
      ],
    })
    const reply = client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: multicall3, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()
    const results = decodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      data: bytesToHex(reply.data),
    }) as readonly { success: boolean; returnData: Hex }[]
    if (results.length !== chunk.length) throw new Error('multicall: result length mismatch')
    for (const r of results) {
      if (!r.success || r.returnData.length < 66) {
        out.push(null)
        continue
      }
      out.push(decodeFunctionResult({ abi: ORACLE_ABI, functionName: 'isSanctioned', data: r.returnData }) as boolean)
    }
  }
  return out
}
