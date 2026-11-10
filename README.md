# Ajo Savings Circle Steward

A non-custodial rotating savings and credit circle (Ajo / Esusu / Tanda / ROSCA) steward built on **Sui Move** (via **Tatum Sui Gateway** on **Sui Testnet**) and **Walrus Memory** (`@mysten-incubation/memwal` on **Walrus Mainnet**).

---

## Overview

Ajo Steward modernizes traditional rotating savings groups by eliminating organizer bookkeeping burnout, screenshot disputes, and custody risks:
- **Dedicated Move Shared Vault Objects**: Circles hold pooled funds in dedicated on-chain Move shared objects (`Circle<phantom T>`) on Sui Testnet. Neither Ajo Steward, Tatum, nor any individual holds custody.
- **Direct Wallet-Authorized Deposits & Claims**: Members sign deposits directly from their own Sui wallets. Scheduled recipients claim the accumulated cycle pot directly to their wallets via MoveCall.
- **Authoritative On-Chain Verification via Tatum Gateway**: Real-time inspection of Sui Testnet transaction blocks, balance changes, and Move events without relying on manual receipts.
- **Decentralized Agreement Persistence via Walrus Memory**: Circle rules, member rosters, and approved grace policies are cryptographically sealed and stored on Walrus Mainnet for semantic recall across sessions.
- **Advisory AI Steward**: An LLM-powered assistant evaluates server-recalled Walrus memories alongside verified on-chain Sui facts to provide distribution recommendations and answer circle inquiries.

---

## Core Architecture & Security Invariants

### 1. On-Chain Move Shared Vault Objects (`contracts/ajo`)
- **Package Deployment**: Published Move package `0x0d7dfa83d83c9187781a8acb0af9f7797bce6c157e417503fa18c04f03238466` on Sui Testnet.
- **Dedicated Vault per Circle**: When creating a circle, the organizer signs 1 wallet transaction to instantiate a fresh, dedicated Move shared object `Circle<T>`.
- **Contribution Flow**: During an active cycle, members sign a deposit transaction (`deposit_contribution<T>`) transferring exact tokens from their wallet into the shared vault object.
- **Claim Flow**: Payouts are claimed directly by the scheduled recipient via `claim_cycle_pot<T>`. The contract guarantees that claims before the deadline require 100% funding; after the deadline passes, any funds accumulated in the vault can be claimed incrementally.
- **Supported Tokens**: Authoritative coin types for **SUI** (`0x2::sui::SUI`, 9 decimals) and **USDC** (`0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`, 6 decimals). WAL is explicitly deprecated for new circles.

### 2. Digest-First Sui Verification via Tatum Gateway
- Queries Tatum Sui Gateway at `POST https://sui-{network}.gateway.tatum.io/graphql` (header `x-api-key: <TATUM_API_KEY>`) and JSON-RPC / fullnodes.
- Rate-limited queue with exponential backoff inspects `effects.status`, `effects.timestamp`, and `effects.balanceChanges.nodes` against the circle's registered vault address, token type, expected contribution, and cycle window (`windowStart` .. `windowEnd`).
- Returns explicit states: `Verified`, `Late`, `Partial` (with multi-tranche aggregation), `WrongToken`, `WrongAmount`, `Pending` (only when indexing), or `Unverified`.
- **Tatum Operational Boundary**: Tatum queries and verifies blockchain evidence; it never custodies funds, signs transactions, or guarantees off-chain member compliance.

### 3. Strict Separation of Chain Facts vs. Group Policy vs. AI Suggestions
- **Chain Fact**: The immutable on-chain record (`Verified`, `Late`, `Partial`, `Unverified`). A deposit received after `windowEnd` remains `Chain: Late` permanently.
- **Group Policy**: When **With memory** is active and an approved grace agreement is recalled from Walrus Memory on the server, the policy engine produces `Policy: Accepted under recorded grace agreement` (`countsTowardPot: true`). When **Without memory** is chosen, late payments evaluate strictly as `Policy: Unexcused late payment`.
- **Steward LLM**: AI suggestions are strictly advisory and clearly marked as such in the UI. The model only reads server-verified contributions and server-recalled Walrus memories.

### 4. Walrus Mainnet Memory Store (`schema: 'ajo-steward-memory/v2'`)
- Encrypted semantic memory backed by `@mysten-incubation/memwal` on Walrus Mainnet.
- **Record Types**:
  - `circle_config`: Versioned and hash-chained circle configurations, cadence, time zone, and minimal member rosters (`id`, `name`, normalized `address`).
  - `agreement` / `member_pattern`: Confirmed circle agreements and policy decisions with proposal hashes, confirmation types, and signer addresses.
  - `tx_digest_association`: Confirmed association of transaction digests with circle cycles.
- **Restart Recovery**: Restores and re-indexes state on container restart via `client.restore`, `listMemories`, and `recall`, re-verifying all transaction digests live against Tatum.
- **Data Minimization**: Private keys, unconsumed challenge nonces, and session tokens are never written to or restored from Walrus (`FORBIDDEN_SECRET_KEYS` protection).

### 5. Address-Bound Wallet Authentication & Anti-Impersonation
- Sensitive API routes (`/api/memory/*`, `/api/tatum/sui/*`, `/api/steward/*`) require signed wallet session challenges (`server/wallet-auth.mjs`).
- Cryptographic signature verification using `@mysten/sui` supports Ed25519, Secp256k1, and Secp256r1/zkLogin keys, proving that the signing public key derives to the registered member address.
- Memory proposals can only be signed by the specific member address referenced or recorded as organizer-entered by the circle organizer.

### 6. Network-Aware Explorer Citations
- Deep-linking throughout the application links transaction digests, wallet addresses, Move vault objects, and token contracts to **Suiscan (Testnet)**.
- Memory records and recovery details link directly to **Walruscan (Mainnet)** via validated Blob IDs.
- Displayed identifiers feature multi-tier responsive truncation (`max-w-[160px]` to `max-w-[460px]`) with copy-to-clipboard affordances.

---

## Environment Variables

Copy `.env.example` to `.env` (gitignored) and populate credentials for the integrations you wish to enable:

| Variable | Required For | Description |
| :--- | :--- | :--- |
| `PORT` | Optional (default `3000`) | Express + Vite server port |
| `TATUM_API_KEY` | Tatum Sui Verifier | Tatum API key (`x-api-key` header) |
| `TATUM_API_BASE` | Tatum Sui Verifier | Tatum API base URL (e.g. `https://api.tatum.io`) |
| `SUI_NETWORK` | Tatum Sui Verifier | `testnet` (default) or `mainnet` |
| `SUI_TOKEN_TYPE` | Tatum Sui Verifier | Move coin type (e.g. `0x2::sui::SUI`) |
| `SUI_TOKEN_DECIMALS` | Optional (default `9`) | Token decimals (`9` for SUI, `6` for USDC) |
| `MEMWAL_KEY` | Walrus Memory | Ed25519 delegate private key (`64`-hex or `suiprivkey1...`) |
| `MEMWAL_ACCOUNT_ID` | Walrus Memory | `MemWalAccount` Sui object ID (`0x...`) |
| `MEMWAL_SERVER_URL` | Walrus Memory | Walrus Memory relayer URL (`https://relayer.memory.walrus.xyz`) |
| `MEMWAL_NAMESPACE_PREFIX` | Optional (`ajo-circle`) | Prefix for per-circle namespaces |
| `LLM_API_KEY` | Steward Chat & Payout | API key for OpenAI-compatible chat completions provider |
| `LLM_BASE_URL` | Steward Chat & Payout | Base URL (e.g. `https://openrouter.ai/api/v1`) |
| `LLM_MODEL` | Steward Chat & Payout | Model identifier (e.g. `openai/gpt-4o-mini`) |
| `GRACE_WINDOW_HOURS` | Optional (default `72`) | Approved late-payment grace window in hours |
| `PARTIAL_PAYMENT_WINDOW_HOURS` | Optional (default `48`) | Max hours between two split-payment tranches |
| `POLLING_INTERVAL_MS` | Optional (default `1500`) | Job polling interval in ms |
| `RATE_LIMIT_RPS` | Optional (default `3`) | Outbound RPC requests per second limit |
| `RATE_LIMIT_MAX_RETRIES` | Optional (default `3`) | Max retries on HTTP 429 / transient errors |
| `RATE_LIMIT_BACKOFF_MS` | Optional (default `1000`) | Base exponential backoff in ms |
| `RECALL_LIMIT` | Optional (default `10`) | Default top-K memories recalled per query |
| `REQUEST_TIMEOUT_MS` | Optional (default `20000`) | Per-request HTTP timeout in ms |

---

## Setup & Commands

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Run full automated test suite (58 tests covering lifecycle, auth, Tatum, Walrus, Move)
npm test

# 4. Build frontend application for production
npx vite build

# 5. Run read-only Walrus Mainnet inventory (never writes or deletes)
npm run inventory:walrus

# 6. Restore / re-index a registered circle namespace from Walrus Mainnet
npm run restore:walrus -- <circle-id> 15

# 7. Start the development server (Express backend + Vite HMR)
npm run dev
```

---

## License & Credits

Built on [Sui Network](https://sui.io), [Tatum Gateway](https://tatum.io), and [Walrus Protocol](https://walrus.xyz).
Designed with non-custodial rotating credit and savings traditions (Ajo, Esusu, Tanda, Pardna, Chit Fund, Hui).
