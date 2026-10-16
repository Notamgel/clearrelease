# Demo video script (about 2:30, English)

Record with QuickTime (File → New Screen Recording) or Loom. Show the terminal and the README
side by side. Read naturally; you don't have to match the words exactly.

| Time | Screen | Say |
|---|---|---|
| 0:00 | README title | "Hi, I'm Angel. This is ClearRelease, a legal escrow where funds only move after a Chainlink CRE workflow screens both parties for sanctions." |
| 0:15 | README table with 120 / 78 / 42 | "Why does this matter? Most crypto payouts screen once, against one source. Today I compared OFAC's 120 sanctioned Ethereum addresses with the popular on-chain sanctions oracle. It misses 42 of them, about a third. All 42 are in OFAC's official XML. So we use two sources, and we screen at every payment." |
| 0:40 | Mermaid diagram | "The escrow emits ScreeningRequested at signature, at release and after arbitration. The CRE workflow pins the OFAC list to a git commit, fetches it on every node with identical consensus, reads the Chainalysis oracle on Ethereum mainnet through Multicall3, and writes a DON-signed verdict back to the escrow on Sepolia." |
| 1:00 | Terminal: `cre workflow simulate … --trigger-index 0 --http-payload …` | "First, the HTTP trigger: a law firm asks whether it can pay three wallets. One is clean, one is flagged by both sources, and one is flagged only by the OFAC list. The oracle alone would have said it's clean." |
| 1:20 | Terminal: `demo.js open`, then simulate with `--trigger-index 1 --broadcast` | "Now the real flow on Sepolia. I open an escrow anchored to the SHA-256 of the signed agreement. The workflow screens both parties and broadcasts a signed report, and the escrow becomes Active." |
| 1:45 | `demo.js approve`, simulate, `demo.js status` showing Released + evidence hash | "The client approves the milestone. A fresh screening runs, because the contract rejects any CLEAR verdict older than the request, and the funds are released. The evidence hash commits to the list commit, the oracle answers and the DON timestamp." |
| 2:05 | `demo.js open` with the sanctioned PAYEE, simulate, status Frozen | "If the payee is on the OFAC list, the escrow freezes. There's no automatic refund: blocked funds stay blocked until there's a licence or a delisting review." |
| 2:20 | Test output (14 + 21 passing) | "Fourteen contract tests and twenty-one workflow tests, using CRE's test framework. The code is MIT-licensed on GitHub. Thanks!" |

Tips
- Before recording, run every command once so the output is ready.
- Hide your `.env` and terminal history. Never show a private key.
- Upload to YouTube as **Unlisted** and paste the link into DoraHacks.
