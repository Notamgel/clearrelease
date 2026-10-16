# Sample Services Agreement (demo only)

This file stands in for a signed PDF. Its SHA-256 hash is the `agreementHash` anchored in
`ClearReleaseEscrow`. Only the hash goes on-chain; the document stays with the parties.

1. **Parties.** "Client" (the payer wallet) and "Provider" (the payee wallet).
2. **Services.** Provider delivers one milestone: a written legal-research memo.
3. **Fee.** The fee is escrowed on-chain at signature.
4. **Acceptance.** Client may accept the milestone (`approveRelease`) or raise a dispute
   (`dispute`) before the review deadline (`releaseAfter`). If Client does neither, Provider may
   claim after the deadline (`claimAfterDeadline`).
5. **Disputes.** Disputes are decided by the escrow agent acting as arbitrator, who records a
   split award (`resolveDispute`) together with the hash of the written ruling.
6. **Sanctions compliance.** No payment is made unless both parties pass sanctions screening at
   the moment of payment. If either party is identified as a sanctioned person, the funds are
   blocked and may only be dealt with as permitted by the competent authority (e.g. under an
   OFAC licence), recorded by reference (`transferBlockedFunds`).
7. **Evidence.** Each screening decision is recorded on-chain as an evidence hash that commits
   to the exact sanctions-list version and oracle answers used.

*Demo text. Not legal advice.*
