# DoraHacks BUIDL submission: copy and paste

Hackathon: **BLI Legal Tech Hackathon 2**, https://dorahacks.io/hackathon/legal-hack-2026
Bounty to apply for: **Best workflow with CRE (Chainlink)**, https://dorahacks.io/hackathon/bounty/1362
Track: **LegalTech & RegTech**

---

**BUIDL name:** ClearRelease

**Tagline / one-liner (max ~100 chars):**
Sanctions-gated legal escrow: funds move only after a Chainlink CRE workflow screens both parties.

**Vision (short, ~300 chars):**
Paying out under a legal agreement in crypto should be as defensible as a bank wire. ClearRelease
screens both parties against two independent sanctions sources at signature, at payment and
continuously. It fails closed and records an auditable evidence hash for every decision.

**Category / tags:** LegalTech, RegTech, Compliance, Chainlink, CRE, Escrow, Sanctions, OFAC

**GitHub:** https://github.com/Notamgel/clearrelease
**Demo video:** https://youtu.be/ADreAkAUOoA
**Contract (Sepolia):** [`0x2FFE6Ec34D1470198ba64c1A88F5FBef0dc54f50`](https://sepolia.etherscan.io/address/0x2FFE6Ec34D1470198ba64c1A88F5FBef0dc54f50)
**Example txs (Sepolia):**
- Escrow #1 opened → [`0x9e99c731…`](https://sepolia.etherscan.io/tx/0x9e99c731858f723a13c603e4f2b57fd9aedd09798d8c11bcfdf97cf27d6efaad); onboarding screening report (CLEAR) → [`0xaed5c1f1…`](https://sepolia.etherscan.io/tx/0xaed5c1f1ee7a635ec0fcc0cd70e197c0706b0a16c2b0c6f5777f8a3c52dcd1de)
- Escrow #1 release approved → [`0x41a83388…`](https://sepolia.etherscan.io/tx/0x41a83388f22f7b1053167bcd028a86b88255011e0661a883a28221fbef400684); release screening report (CLEAR → **Released**) → [`0x7061ff59…`](https://sepolia.etherscan.io/tx/0x7061ff59a25c79d19ee4d99a652869271a24cea6e8d931855c1bf7f50bb320bd)
- Escrow #2 opened with an OFAC-listed payee → [`0x31106433…`](https://sepolia.etherscan.io/tx/0x31106433464c056678a6f00c8bae85dfe074fe1ca489d0ce5b5406b8ee66b45f); screening report (HIT via the OFAC list while the Chainalysis oracle returned false → **Frozen**) → [`0xb95d1c65…`](https://sepolia.etherscan.io/tx/0xb95d1c6508133627908e5754c0d692094b48e3dbb9a4525008f5166ec8898148)
**Contact:** Angel Medina, notamgel@gmail.com

---

## Description (paste in the BUIDL "Details" field, Markdown)

### Problem
Escrow agents, law firms and marketplaces that pay out in crypto must not make funds available to
sanctioned persons. Today screening usually happens **once, at onboarding**, against **one
source**. Both habits are risky:

- Designations happen after onboarding.
- On 2026-10-16 we compared the 120 ETH addresses in OFAC's SDN list with the popular Chainalysis
  on-chain Sanctions Oracle. **The oracle did not flag 42 of them (35%).** All 42 appear in OFAC's
  official `SDN_ADVANCED.XML` (reproducible script in the repo).

### Solution
**ClearRelease** is a milestone escrow for legal agreements. A **Chainlink CRE workflow** screens
the parties at every money-moving step and writes a **DON-signed decision** on-chain.

- **EVM log trigger** on `ScreeningRequested`, fired at signature, release request, arbitration
  award and post-delisting review. The workflow screens payer and payee and sends a signed report,
  and the escrow becomes Active, Released or Frozen.
- **Cron trigger:** every 6 hours it re-screens all open escrows in one batched report, to catch
  designations made after onboarding.
- **HTTP trigger:** ad-hoc "may I pay these wallets?" checks for a firm's case-management system.
  It returns an evidence record and writes nothing.

**Two independent sources under DON consensus:**
1. An OFAC SDN-derived address list fetched over the **CRE HTTP capability**. Every node pins the
   same git commit, and `consensusIdenticalAggregation` accepts only identical results.
2. The Chainalysis Sanctions Oracle on **Ethereum mainnet**, read through Multicall3 at the
   finalized block. This is a cross-chain read; the escrow lives on Sepolia.

### Legal design, as code
- **Fail closed.** CLEAR requires every source to answer, and any hit freezes.
- **Fresh screening only.** The contract rejects a CLEAR verdict computed before the release request.
- **Blocked funds stay blocked.** There is no auto-refund. Frozen funds move only with a recorded
  licence reference, or after a fresh CLEAR review following a delisting.
- **Audit trail.** Every decision stores
  `evidenceHash = keccak(list commit, list hash, parties, answers, DON timestamp)`, so an auditor
  can recompute what was known at decision time.
- **The agreement is anchored by its SHA-256 only.** Disputes go to an arbitrator, who sets a
  split award, and the award also passes screening before payout.

### Built with
Chainlink CRE TypeScript SDK 1.23 (HTTP client, EVM read and write, log, cron and HTTP triggers,
signed reports), Solidity 0.8.24 (`ReceiverTemplate`), Hardhat, Bun, viem.

### What's working
- 14 contract tests and 21 workflow tests, using the CRE test framework with HTTP and EVM
  capability mocks
- Workflow compiles to WASM with `cre-compile`
- Simulated with the CRE CLI (`cre workflow simulate`, all three handlers), with an on-chain write
  via `--broadcast` on Sepolia: escrow #1 went Active → Released and escrow #2 (OFAC-listed payee
  the Chainalysis oracle misses) went to Frozen. Contract and tx hashes are linked above.

### Next
- Vendor APIs (TRM, Chainalysis, Elliptic) via Confidential HTTP with secrets
- EU, UK and UN lists
- Solana escrows through the CRE Solana capability
- A rotating cursor for large portfolios

---

## Other fields (if the form asks)
- **Team:** solo builder, Angel Medina (Mexico).
- **License:** MIT.
- **Payout wallet:** ask the organiser which network the bounty pays on. If a Solana address is
  accepted: `7EHnr1aT5LvxSXjsC794ir5HcoqNu72cjjSDz3s6uV78`. If they require an EVM address and your wallet is
  multi-chain (e.g. Phantom), use the Ethereum address shown in that same wallet. Do not
  use the testnet demo key.
