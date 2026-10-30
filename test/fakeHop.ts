// fakeHop.ts: the three tags of a version 2 hop (spec 8.4) for a hop a test
// builds by hand, as another device or an earlier session of the agent would
// have signed it. Well formed and NOT a valid proof: the chain reader never
// checks proofs (events.ts), so these stand in wherever a test only needs a
// hop on the chain. A hop whose proof must hold is made with
// computeHopProofV2, as the agent makes its own.

/** A fake seal, nonce and the shape of 16 depth-0 openings; `byte` (two hex characters) tells hops apart. */
export function fakeHopProof(byte: string = 'ab'): { seal: string; mnHex: string; mpHex: string } {
  return { seal: byte.repeat(32), mnHex: '0'.repeat(16), mpHex: '0'.repeat(16 * 128) }
}
