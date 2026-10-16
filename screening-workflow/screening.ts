// Pure screening logic: no capability calls here, so everything is unit-testable.
import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbiParameters, toBytes } from 'viem'
import type { Address, Hex } from 'viem'

export const VERDICT_CLEAR = 1
export const VERDICT_HIT = 2
export const EVIDENCE_VERSION = 'clearrelease/v1'

/** Per-source answer for one address: true = listed, false = not listed, null = source unavailable. */
export type SourceAnswer = boolean | null

export type PartyResult = {
  address: Address
  ofacList: SourceAnswer
  chainalysisOracle: SourceAnswer
  verdict: 'CLEAR' | 'HIT' | 'INCONCLUSIVE'
}

export type ListSnapshot = {
  commit: string // git commit of the list snapshot (40 hex chars)
  listHash: Hex // keccak256 of the normalised list
  listSize: string
  flags: string // one char per screened address: '1' listed, '0' not listed
}

/** Lower-case, de-duplicate, validate and sort an address list so every node hashes the same bytes. */
export const normaliseList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) throw new Error('sanctions list is not a JSON array')
  const set = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && isAddress(item, { strict: false })) set.add(item.toLowerCase())
  }
  if (set.size === 0) throw new Error('sanctions list is empty')
  return [...set].sort()
}

export const hashList = (normalised: string[]): Hex => keccak256(toBytes(normalised.join('\n')))

export const flagsFor = (normalised: string[], addresses: readonly string[]): string => {
  const set = new Set(normalised)
  return addresses.map((a) => (set.has(a.toLowerCase()) ? '1' : '0')).join('')
}

export const uniqueAddresses = (addresses: readonly string[]): Address[] => {
  const seen = new Set<string>()
  const out: Address[] = []
  for (const a of addresses) {
    if (!isAddress(a, { strict: false })) throw new Error(`invalid address: ${a}`)
    const k = a.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(getAddress(a))
    }
  }
  return out
}

/**
 * Policy: a party is a HIT if ANY available source lists it (compliance prefers a reviewed false
 * positive over a missed match). It is CLEAR only if EVERY required source answered "not listed".
 * Anything else is INCONCLUSIVE and the workflow does not write (fail closed).
 */
export const decideParty = (
  address: Address,
  ofacList: SourceAnswer,
  chainalysisOracle: SourceAnswer,
  oracleRequired: boolean,
): PartyResult => {
  let verdict: PartyResult['verdict']
  if (ofacList === true || chainalysisOracle === true) verdict = 'HIT'
  else if (ofacList === false && (chainalysisOracle === false || !oracleRequired)) verdict = 'CLEAR'
  else verdict = 'INCONCLUSIVE'
  return { address, ofacList, chainalysisOracle, verdict }
}

/** Escrow verdict from its two parties. Returns null when it must not be written on-chain. */
export const decideEscrow = (payer: PartyResult, payee: PartyResult): number | null => {
  if (payer.verdict === 'HIT' || payee.verdict === 'HIT') return VERDICT_HIT
  if (payer.verdict === 'CLEAR' && payee.verdict === 'CLEAR') return VERDICT_CLEAR
  return null
}

const answerCode = (a: SourceAnswer): number => (a === null ? 255 : a ? 1 : 0)

/**
 * Evidence hash committed on-chain with every decision. Anyone can recompute it from the logged
 * evidence record: the git commit pins the exact list version, the oracle answers are reproducible
 * with an archive node read, and checkedAt is the DON timestamp.
 */
export const evidenceHash = (args: {
  snapshot: ListSnapshot | null
  parties: PartyResult[]
  checkedAt: bigint
}): Hex => {
  const commit = (args.snapshot ? `0x${args.snapshot.commit}` : `0x${'00'.repeat(20)}`) as Hex
  const listHash = (args.snapshot ? args.snapshot.listHash : `0x${'00'.repeat(32)}`) as Hex
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('string, bytes20, bytes32, address[], uint8[], uint8[], uint64'),
      [
        EVIDENCE_VERSION,
        commit,
        listHash,
        args.parties.map((p) => p.address),
        args.parties.map((p) => answerCode(p.ofacList)),
        args.parties.map((p) => answerCode(p.chainalysisOracle)),
        args.checkedAt,
      ],
    ),
  )
}

/** ABI payload expected by ClearReleaseEscrow._processReport. */
export const encodeScreeningReport = (checkedAt: bigint, evidence: Hex, ids: bigint[], verdicts: number[]): Hex =>
  encodeAbiParameters(parseAbiParameters('uint64 checkedAt, bytes32 evidenceHash, uint256[] ids, uint8[] verdicts'), [
    checkedAt,
    evidence,
    ids,
    verdicts,
  ])

export const safeJson = (o: unknown): string =>
  JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
