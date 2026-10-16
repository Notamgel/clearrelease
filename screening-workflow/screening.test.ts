import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, parseAbiParameters } from 'viem'
import {
  decideEscrow,
  decideParty,
  encodeScreeningReport,
  evidenceHash,
  flagsFor,
  hashList,
  normaliseList,
  uniqueAddresses,
  VERDICT_CLEAR,
  VERDICT_HIT,
} from './screening'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const LISTED = '0x0330070FD38Ec3bB94F58FA55D40368271E9e54A'

describe('list normalisation', () => {
  test('lower-cases, de-duplicates, drops junk and sorts', () => {
    const out = normaliseList([LISTED, LISTED.toLowerCase(), 'not-an-address', 42, A])
    expect(out).toEqual([A, LISTED.toLowerCase()].sort())
  })
  test('rejects non-arrays and empty lists', () => {
    expect(() => normaliseList({})).toThrow('not a JSON array')
    expect(() => normaliseList(['x'])).toThrow('empty')
  })
  test('hash is order-independent after normalisation', () => {
    expect(hashList(normaliseList([A, LISTED]))).toBe(hashList(normaliseList([LISTED, A])))
  })
  test('flags are case-insensitive and positional', () => {
    expect(flagsFor(normaliseList([LISTED]), [A, LISTED.toLowerCase(), B])).toBe('010')
  })
  test('uniqueAddresses checksums and de-duplicates', () => {
    expect(uniqueAddresses([LISTED.toLowerCase(), LISTED, A])).toEqual([LISTED, A] as any)
    expect(() => uniqueAddresses(['0x123'])).toThrow('invalid address')
  })
})

describe('policy (fail closed)', () => {
  test('any source listing the party is a HIT', () => {
    expect(decideParty(A, true, false, true).verdict).toBe('HIT')
    expect(decideParty(A, false, true, true).verdict).toBe('HIT')
    expect(decideParty(A, null, true, true).verdict).toBe('HIT')
  })
  test('CLEAR needs every required source to answer "not listed"', () => {
    expect(decideParty(A, false, false, true).verdict).toBe('CLEAR')
    expect(decideParty(A, false, null, true).verdict).toBe('INCONCLUSIVE')
    expect(decideParty(A, null, false, true).verdict).toBe('INCONCLUSIVE')
  })
  test('oracle can be made optional', () => {
    expect(decideParty(A, false, null, false).verdict).toBe('CLEAR')
  })
  test('escrow verdict', () => {
    const clear = decideParty(A, false, false, true)
    const hit = decideParty(B, true, false, true)
    const unk = decideParty(B, null, null, true)
    expect(decideEscrow(clear, clear)).toBe(VERDICT_CLEAR)
    expect(decideEscrow(clear, hit)).toBe(VERDICT_HIT)
    expect(decideEscrow(unk, hit)).toBe(VERDICT_HIT)
    expect(decideEscrow(clear, unk)).toBeNull()
  })
})

describe('evidence and report encoding', () => {
  const snapshot = { commit: 'a'.repeat(40), listHash: `0x${'b'.repeat(64)}` as const, listSize: '120', flags: '00' }
  const parties = [decideParty(A, false, false, true), decideParty(B, false, false, true)]

  test('evidence hash is deterministic and sensitive to every input', () => {
    const h1 = evidenceHash({ snapshot, parties, checkedAt: 1000n })
    expect(evidenceHash({ snapshot, parties, checkedAt: 1000n })).toBe(h1)
    expect(evidenceHash({ snapshot, parties, checkedAt: 1001n })).not.toBe(h1)
    expect(evidenceHash({ snapshot: { ...snapshot, commit: 'c'.repeat(40) }, parties, checkedAt: 1000n })).not.toBe(h1)
    expect(evidenceHash({ snapshot: null, parties, checkedAt: 1000n })).not.toBe(h1)
  })

  test('report payload matches the contract ABI', () => {
    const hex = encodeScreeningReport(1234n, `0x${'d'.repeat(64)}`, [1n, 7n], [VERDICT_CLEAR, VERDICT_HIT])
    const [checkedAt, ev, ids, verdicts] = decodeAbiParameters(
      parseAbiParameters('uint64, bytes32, uint256[], uint8[]'),
      hex,
    )
    expect(checkedAt).toBe(1234n)
    expect(ev).toBe(`0x${'d'.repeat(64)}`)
    expect(ids).toEqual([1n, 7n])
    expect(verdicts).toEqual([1, 2])
  })
})
