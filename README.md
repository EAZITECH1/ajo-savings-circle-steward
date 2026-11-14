# Ajo Savings Circle Steward

A decentralized, non-custodial Rotating Savings and Credit Association (ROSCA / Ajo / Esusu / Tanda) steward combining **Sui Move smart contract vaults** on **Sui Testnet**, **Tatum blockchain indexing** for transaction verification, **Walrus Memory** (`@mysten-incubation/memwal`) on **Walrus Mainnet** for permanent decentralized memory, and an **impartial AI Steward** for payout guidance.

---

## 1. Project Overview

### What Ajo Steward Does
Ajo Steward modernizes community peer-to-peer rotating savings groups. Instead of relying on a human organizer to hold pooled money in a personal bank account or spreadsheet, Ajo Steward:
1. Deploys a dedicated, non-custodial Move smart contract vault object (`Circle<T>`) for each savings circle.
2. Directs members to sign deposit transactions straight from their Sui wallets into the on-chain vault.
3. Automatically inspects and verifies deposit transactions via **Tatum Sui Gateway** without requiring manual screenshot receipts.
4. Cryptographically commits circle rules, accepted grace policies, and payment behavior logs to **Walrus Mainnet** using SEAL threshold encryption.
5. Uses an **Advisory AI Steward** to synthesize verified on-chain facts and recalled Walrus memories to recommend fair payout distributions.

### Who It Is For
* **Community Savers & Peer Groups:** Friends, colleagues, and informal collectives practicing traditional rotating credit (Ajo, Esusu, Chit Funds, Tandas, Pardnas) seeking transparency without risking organizer default.
* **Circle Organizers:** Community leaders burdened with manual bookkeeping, tracking who paid late, and answering endless status questions.

### The Actual User Journey
1. **Circle Creation & Move Vault Deployment:** The organizer defines contribution amounts, cadence (daily, weekly, monthly), member addresses, and optional **Circle Rules & Guidelines** (via 1-click starter chips or custom policy text). The organizer signs one Sui wallet transaction to instantiate a fresh on-chain `Circle<T>` shared object, and both the circle configuration and any founding rules (`Founding Circle Rules & Guidelines` `Agreements` record) are committed to Walrus Memory and displayed on the Dashboard.
2. **Member Acceptance & Cycle Activation:** Members connect their Sui wallets and accept circle terms. Once initialized, the cycle countdown begins.
3. **Contribution & Tatum Verification:** Members submit deposits (`contribute<T>`) to the vault. When a transaction digest is submitted, the backend queries Tatum Sui Gateway to confirm the sender, recipient vault, coin type, amount, and timestamp.
4. **Governance, Notifications & Memory Storage:** Members can propose agreements (grace windows, split-payment rules, payout swaps) for organizer review/approval or rejection in Steward Chat, and receive in-app notifications (unread indicator dot, approval/rejection updates, and overdue contribution reminders). Confirmed agreements and factual late/split-payment records are permanently saved to Walrus.
5. **Pot Distribution:** Payout claims (`claim_cycle<T>`) are executed on-chain directly by the scheduled recipient.
6. **Disaster Recovery:** If the application restarts, the entire circle state is reconstructed from Walrus Mainnet and re-verified on-chain via Tatum.

### Concise Status Statement
* **Sui Smart Contracts:** **Live on Sui Testnet** (Move Package [`0x0d7dfa83d83c9187781a8acb0af9f7797bce6c157e417503fa18c04f03238466`](https://suiscan.xyz/testnet/package/0x0d7dfa83d83c9187781a8acb0af9f7797bce6c157e417503fa18c04f03238466)).
* **Tatum Chain Indexing:** **Live on Sui Testnet** via Tatum Sui Gateway GraphQL and RPC.
* **Walrus Memory:** **Live on Walrus Mainnet** via `https://relayer.memory.walrus.xyz` under Account Object [`0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4`](https://suiscan.xyz/mainnet/object/0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4).
* **AI Steward:** **Live (Advisory Only)** via OpenAI-compatible chat completions. The AI cannot move funds or execute transactions.
* **Live Deployment:** Hosted on Railway at [https://ajo-steward.up.railway.app](https://ajo-steward.up.railway.app).

---

## 2. Problem & Solution

### The Real-World Problem
Traditional rotating savings associations rely entirely on interpersonal trust and informal administration:
* **Custodial Risk:** The organizer collects all contributions into a personal bank or wallet. If the organizer falls ill, experiences an account freeze, or absconds, the entire group loses their savings.
* **Bookkeeping Burnout & Screenshot Disputes:** Members send conflicting screenshots, split payments across different days, or pay via wrong tokens. Organizers spend hours reconciling chat logs.
* **Rigid Default vs. Social Realities:** Life happens—members occasionally need a 2-day grace window due to payroll delays. When rules are purely informal, organizers face accusations of favoritism or unfair penalties.

### How Ajo Steward Solves It
* **Non-Custodial Move Vaults:** Funds are deposited directly into dedicated Move shared objects (`Circle<T>`). Neither the organizer, the backend server, Tatum, nor the AI Steward can withdraw pooled funds. Only the pre-scheduled recipient can execute `claim_cycle<T>`.
* **Authoritative Blockchain Evidence:** Tatum's GraphQL gateway inspects raw transaction blocks, verifying exact net balance changes, coin types, and timestamps against cycle deadlines.
* **Separation of Chain Facts vs. Social Policy:** A late payment is permanently recorded on-chain as `Late`. However, if the circle previously consensus-approved a grace period, Walrus Memory surfaces that policy so the AI Steward and group recognize it as excused.
* **No Exaggerated Claims:** Ajo Steward does not claim to guarantee loan repayment or physically force an off-chain person to pay. Instead, it provides an auditable, trust-minimized framework where escrow is non-custodial and payment history is immutable.

---

## 3. How Walrus Memory Changes the Product

Ajo Steward integrates **Walrus Memory** (`@mysten-incubation/memwal`) on **Walrus Mainnet** to provide decentralized, tamper-proof long-term memory for community governance without relying on a centralized Web2 database.

### What Ajo Steward Stores in Walrus
Every record is stored under an isolated namespace (`ajo-circle:<circleId>`) using the `schema: 'ajo-steward-memory/v2'` format:
1. **`circle_config`**: The immutable, versioned configuration of the circle, including Move vault object ID, token type, cadence, time zone, optional `circleRules`, and hash chain.
2. **`agreement`**: Group decisions (founding Circle Rules & Guidelines committed at creation, approved custom grace windows, agreed payout-order swaps) confirmed by the organizer or members.
3. **`member_pattern`**: Recorded operational arrangements (e.g., preference for two-tranche split contributions).
4. **`reminder_preference`**: Opted-in member reminder preferences and factual reminder conversion outcomes recorded after Tatum-confirmed payments.
5. **`historical_behavior`**: Factual records of verified late completions, grace-window outcomes, and multi-tranche split completion patterns, timestamped and linked to Sui transaction digests.
6. **`tx_digest_association`**: Cryptographic binding of confirmed Sui transaction digests to circle cycles.

### How Memories Affect Later Decisions
Walrus Memory is always active in Ajo Steward. Whenever a member checks a contribution, asks the AI Steward a question, or opens Payout Readiness, the backend recalls relevant records from the circle's Walrus namespace:
* **Semantic Recall & Session Continuity:** The server queries `client.recall()` for relevant agreements, patterns, and history, and merges any newly confirmed blobs from the current session (`sessionConfirmedCache`) so recently saved memories take effect immediately without waiting on external vector indexing.
* **Grace Policy & Cross-Cycle History (`server/payment-policy.mjs`):** Confirmed grace agreements (including custom durations and cycle scopes) allow the policy engine to evaluate a `Late` on-chain contribution as `Accepted under recorded grace agreement` (`countsTowardPot: true`) if it arrived within the approved window, or `Late (Exceeded grace window)` if it did not—always keeping the on-chain `Late` timestamp fact separate from group policy. Confirmed late completions and grace outcomes are logged factually as `historical_behavior` records to inform later cycles without opaque credit scores.
* **Split Contributions & Reminder Preferences:** Multi-tranche `Verified` contributions and opted-in `Reminder preferences` are recorded and recalled to contextualize `Partial` or `Pending` contributions and log factual completion outcomes.
* **Payout-Order Advisory & AI Citations (`server/steward-llm.mjs`):** Confirmed payout-order swap agreements are surfaced as an advisory guardrail in Payout Readiness while noting that `ajo::circle::claim_cycle` on Sui enforces the immutable `payout_order` set at circle creation. Steward Chat and Payout Readiness cite recalled Walrus blob IDs (`citedBlob` / `citedBlobId`) alongside Tatum-verified Sui transaction digests (`txDigest`) so members can verify both sources directly.

### Crucial Boundaries & Limitations
* **Storage vs. Verification:** Walrus Memory stores and recalls encrypted historical context; it **does not verify payments or enforce smart contract rules**.
* **Saving vs. Recalling:** Storing a blob to Walrus (`rememberAndWait`) returns a `blob_id`. Successful recall (`recall`) depends on semantic relevance and vector ranking.
* **Recall Ceilings:** MemWal recall returns similarity-ranked matches up to a configured limit (`tunables.recallLimit`, default 10; max 100). For full disaster recovery, Ajo Steward combines `client.recall()` with paginated `client.listMemories()` inventory audits to ensure zero missing blobs.
* **Rate Limits:** To avoid HTTP 429 rate limits from the public relayer, the backend pools `MemWal` clients in-memory (`memwalClientCache`) and applies exponential backoff retries (`withWalrusRetry`).

Verified receipts and blob IDs are documented in [WALRUS_BLOBS.md](WALRUS_BLOBS.md).

---

## 4. How Tatum Powers Ajo Steward

Tatum serves as the authoritative blockchain indexer and verification backbone for Sui Testnet.

### Exact APIs Called
The server interacts with Tatum via [server/tatum-client.mjs](server/tatum-client.mjs) and [server/sui-verifier.mjs](server/sui-verifier.mjs):
1. **Tatum Sui Gateway GraphQL (`POST https://sui-testnet.gateway.tatum.io/graphql`):**
   - Header: `x-api-key: <TATUM_API_KEY>`
   - Query: `GetSuiTransaction($digest: String!)` — retrieves `digest`, `sender.address`, `effects.status`, `effects.timestamp`, and `effects.balanceChanges.nodes { owner.address, coinType.repr, amount }`.
   - Query: `FindRecentContributions($pool: SuiAddress!, $sender: SuiAddress!)` — queries `transactions(last: 50, filter: { affectedAddress: $pool, sentAddress: $sender })` to recover transactions when the user loses their digest.
2. **Tatum RPC (`POST https://sui-testnet.gateway.tatum.io`):**
   - Fallback methods: `sui_getTransactionBlock` and `suix_queryTransactionBlocks`.

### Verification Logic & Data Handling
* **Sender & Recipient:** Checks that `sender.address` matches the registered member and that the net incoming balance change lands on the circle's registered shared vault object ID.
* **Coin Type Normalization:** Verifies that `coinType.repr` matches the circle's configured token type (`0x2::sui::SUI` or `0xa1ec7fc...::usdc::USDC`).
* **Amount Checks:** Verifies that the net received amount matches or exceeds the required contribution in base units.
* **Timestamp & Cycle Deadlines:** Compares `effects.timestamp` against `windowStart` and `windowEnd`.
* **Payment Classifications:**
  - `Verified`: Net amount received on-time before `windowEnd`.
  - `Late`: Valid transfer received after `windowEnd`.
  - `Partial`: Incomplete transfer; aggregated if a second tranche clears within `partialPaymentWindowHours` (48h).
  - `WrongToken` / `WrongAmount`: Mismatched asset or balance change.
  - `Unverified`: Transaction failed, missing on-chain, or invalid recipient. (Never reported as `Pending` once indexed).
* **Double-Claim Prevention:** An in-memory store (`submittedTransactionsStore`) records `(txDigest, network)` to prevent cross-member reuse of transaction hashes.

### Operational Boundaries
* **Tatum does not custody funds** or hold private keys.
* **Tatum does not sign transactions**; all MoveCalls are signed by user wallets.
* **Tatum does not enforce group policy**; it provides verified on-chain evidence to the application's policy engine.

---

## 5. Technical Documentation Links

* 📐 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):** Detailed system architecture, data flows, Mermaid diagrams, and Move contract specifications.
* ⚖️ **[JUDGING.md](JUDGING.md):** Hackathon evaluation guide, criteria-to-evidence matrix, test suite breakdown, and reproduction steps.
* 🦭 **[WALRUS_BLOBS.md](WALRUS_BLOBS.md):** 57 real, verified Walrus Mainnet blob receipts with explorer links and audit details.

---

## 6. Environment Configuration (.env)

Copy [.env.example](.env.example) to `.env` (gitignored). Never commit or expose private keys or API keys.

| Variable | Required For | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `PORT` | Local Server | Port for Express + Vite server | `3000` |
| `TATUM_API_KEY` | Tatum Sui Verifier | API key for Tatum Gateway (`x-api-key`) | Required for verification |
| `TATUM_API_BASE` | Tatum Sui Verifier | Tatum API base endpoint | `https://api.tatum.io` |
| `SUI_NETWORK` | Tatum Sui Verifier | Sui network for contract vaults | `testnet` |
| `SUI_TOKEN_TYPE` | Tatum Sui Verifier | Move coin type for contributions | `0x2::sui::SUI` |
| `SUI_TOKEN_DECIMALS` | Tatum Sui Verifier | Token decimal precision | `9` (SUI) or `6` (USDC) |
| `AJO_PACKAGE_ID` | Smart Contracts | Published Sui Move package ID | `0x0d7dfa83d83c9...3238466` |
| `MEMWAL_KEY` | Walrus Memory | Ed25519 delegate private key for relayer | 64-hex private key |
| `MEMWAL_ACCOUNT_ID` | Walrus Memory | `MemWalAccount` Sui object ID (Mainnet) | `0xf6b75c6fd44e...3175d4` |
| `MEMWAL_SERVER_URL` | Walrus Memory | Public Walrus Memory relayer | `https://relayer.memory.walrus.xyz` |
| `MEMWAL_NAMESPACE_PREFIX` | Walrus Memory | Prefix for circle namespaces | `ajo-circle` |
| `LLM_API_KEY` | AI Steward | API key for OpenAI-compatible LLM | Required for AI chat |
| `LLM_BASE_URL` | AI Steward | Base URL for LLM provider | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | AI Steward | Model identifier | `openai/gpt-4o-mini` |
| `GRACE_WINDOW_HOURS` | Policy Engine | Permitted grace window duration | `72` |
| `PARTIAL_PAYMENT_WINDOW_HOURS` | Policy Engine | Max window between split tranches | `48` |
| `RATE_LIMIT_RPS` | Tatum RPC Queue | Requests per second limit | `3` |
| `RATE_LIMIT_MAX_RETRIES` | Tatum RPC Queue | Retry attempts on 429/timeouts | `3` |
| `RATE_LIMIT_BACKOFF_MS` | Tatum RPC Queue | Base exponential backoff in ms | `1000` |
| `RECALL_LIMIT` | Walrus Memory | Top-K recalled memories per query | `10` |
| `REQUEST_TIMEOUT_MS` | All Integrations | HTTP fetch timeout in ms | `20000` |

---

## 7. Installation & Development

### 1. Prerequisites
* Node.js `v22.23.4+` or `v24.x`
* Sui Wallet browser extension (Sui Wallet, Suiet, or Nightly configured for Sui Testnet)

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Automated Test Suite
Runs the automated unit, contract, and integration test suite (`68` tests — `67` passed, `1` live Tatum Sui testnet lookup skipped when `TATUM_API_KEY` is unconfigured):
```bash
npm test
```

### 4. Build for Production
```bash
npm run build
```

### 5. Start Development Server
Starts the Express API server and Vite HMR frontend:
```bash
npm run dev
```

### 6. Read-Only Walrus Mainnet Inventory
Inspects all recorded memories without modifying state:
```bash
npm run inventory:walrus -- <circleId>
```

---

## 8. License & Acknowledgements

* **License:** Apache 2.0
* Built with [Sui Network](https://sui.io) Move smart contracts, [Tatum Gateway](https://tatum.io) blockchain indexing, [Walrus Protocol](https://walrus.xyz) decentralized memory, and [React](https://react.dev).
