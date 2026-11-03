# Ajo Savings Circle Steward

A non-custodial rotating savings circle (Ajo / Esusu / ROSCA) steward built on **Sui** (via **Tatum Sui RPC**) and **Walrus Memory** (`@mysten-incubation/memwal` on Walrus Mainnet).

## Architecture & Design Invariants

1. **Digest-First Sui Verification via Tatum (`sui_getTransactionBlock`)**
   - A member or organizer submits a Sui transaction digest (`Base58`).
   - The server queries Tatum's Sui RPC gateway (`https://sui-{network}.gateway.tatum.io`) using the official `sui_getTransactionBlock` JSON-RPC method (`showInput: true`, `showEffects: true`, `showBalanceChanges: true`) through a rate-limited queue with exponential backoff.
   - Verifies `transaction.data.sender`, `effects.status.status === "success"`, `balanceChanges` (recipient and coin type), and `timestampMs` against the circle's cycle window (`windowStart` .. `windowEnd`).
   - Supports two-tranche split payments from the same member within `PARTIAL_PAYMENT_WINDOW_HOURS`.
   - Returns `Unverified` (with an explicit diagnostic) whenever Tatum is unconfigured/unavailable, a digest is malformed or not found on-chain, or required fields are missing. Returns `Pending` only when a complete lookup establishes no digest/transfer has been matched yet.

2. **Strict Separation of Chain Facts vs. Group Policy**
   - On-chain facts (`Verified`, `Late`, `Partial`, `WrongToken`, `WrongAmount`, `Pending`, `Unverified`) are **never** relabeled to fit group policy.
   - A contribution that arrives after `windowEnd` always remains `Chain: Late`.
   - When **With memory** is enabled and a confirmed grace agreement is recalled from Walrus Memory, the separate policy evaluator produces `Policy: Accepted under recorded grace agreement` (`countsTowardPot: true`), displaying both badges side by side in the UI.
   - When **Without memory** is selected, the exact same code path runs with memory recall disabled, producing `Policy: Unexcused late payment` (`countsTowardPot: false`).

3. **Real Walrus Memory (`@mysten-incubation/memwal`) & Server-Enforced Membership**
   - Uses `MemWal.create({ key, accountId, serverUrl, namespace })` on the server only; delegate private keys never leave the server, and `server/credential-guard.mjs` scrubs all configured secrets (`TATUM_API_KEY`, `MEMWAL_KEY`, `LLM_API_KEY`) from every outbound HTTP response.
   - Uses one deterministic namespace per circle (`${MEMWAL_NAMESPACE_PREFIX}:${circleId}`). Because Walrus Memory namespaces are vector-search partitions within an account rather than cryptographic authorization boundaries, circle membership and confirmation challenges are enforced server-side in `server/walrus-memory.mjs`.
   - Follows the **Propose → Member Confirmation → `rememberAndWait` → Real `blob_id`** flow. `"Saved on Walrus"` is only shown after `rememberAndWait` resolves with a real Walrus Mainnet `blob_id`.
   - Supports both Ed25519 challenge-signature verification (`wallet_signature_verified`) and explicitly labeled organizer-entered records (`organizer_entered`) — never fabricating multi-member consensus vote counts.

4. **Semantic Memory Scope & Honest Restoration Boundaries**
   - Per the official Walrus Memory documentation, Walrus Memory is an encrypted semantic vector store, not a relational database.
   - `POST /api/memory/restore` (`npm run restore:walrus`) calls `memwal.restore(namespace, limit)` to re-index on-chain Walrus blobs missing from the relayer's vector index (bounded by `limit` and relayer candidate caps) and then recalls recent circle memories.
   - Payment state is derived from verified Sui transaction digests rather than semantic recall.

---

## Environment Variables

Copy `.env.example` to `.env` (gitignored) and populate the credentials for the integrations you want active. The server starts cleanly even if a service credential is absent and reports honest per-service availability at `GET /api/config/status`.

| Variable | Required For | Description |
| :--- | :--- | :--- |
| `PORT` | Optional (default `3000`) | Express + Vite server port |
| `TATUM_API_KEY` | Tatum Sui Verifier | Tatum API key (`x-api-key` header) |
| `TATUM_API_BASE` | Tatum Sui Verifier | Tatum API base URL (e.g. `https://api.tatum.io`) |
| `SUI_NETWORK` | Tatum Sui Verifier | `mainnet` or `testnet` (must match your Tatum API key scope) |
| `SUI_TOKEN_TYPE` | Tatum Sui Verifier | Move coin type (e.g. `0x2::sui::SUI` or Circle USDC type) |
| `SUI_TOKEN_DECIMALS` | Optional (default `6`) | Token decimals (`9` for SUI, `6` for USDC) |
| `MEMWAL_KEY` | Walrus Memory | Ed25519 delegate private key (`64`-hex or `suiprivkey1...`) |
| `MEMWAL_ACCOUNT_ID` | Walrus Memory | `MemWalAccount` Sui object ID (`0x...`) |
| `MEMWAL_SERVER_URL` | Walrus Memory | Walrus Memory relayer URL (`https://relayer.memory.walrus.xyz`) |
| `MEMWAL_NAMESPACE_PREFIX` | Optional (`ajo-circle`) | Prefix for per-circle namespaces |
| `LLM_API_KEY` | Steward Chat & Payout | API key for OpenAI-compatible chat completions provider |
| `LLM_BASE_URL` | Steward Chat & Payout | Base URL (e.g. `https://api.openai.com/v1` or OpenRouter/Gemini compatible URL) |
| `LLM_MODEL` | Steward Chat & Payout | Model identifier |
| `GRACE_WINDOW_HOURS` | Optional (default `72`) | Approved late-payment grace window in hours |
| `PARTIAL_PAYMENT_WINDOW_HOURS` | Optional (default `48`) | Max hours between two split-payment tranches |
| `POLLING_INTERVAL_MS` | Optional (default `1500`) | Job polling interval in ms |
| `RATE_LIMIT_RPS` | Optional (default `3`) | Outbound RPC requests per second limit |
| `RATE_LIMIT_MAX_RETRIES` | Optional (default `3`) | Max retries on HTTP 429 / transient errors |
| `RATE_LIMIT_BACKOFF_MS` | Optional (default `1000`) | Base exponential backoff in ms |
| `RECALL_LIMIT` | Optional (default `10`) | Default top-K memories recalled per query |
| `REQUEST_TIMEOUT_MS` | Optional (default `20000`) | Per-request HTTP timeout in ms |

---

## Setup & Scripts

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Run unit + live integration tests (skips live network checks whose credentials are absent)
npm test

# 4. Verify 10 real Walrus Mainnet memory writes & recall/restore
npm run verify:walrus

# 5. Restore / re-index a circle namespace from Walrus Mainnet
npm run restore:walrus -- lagos-techies-seed-circle 15

# 6. Start the Express + Vite application on port 3000
npm run dev
```

---

## Verified Walrus Mainnet Writes Evidence

10 real memory writes (`rememberAndWait`), semantic recalls (`recall`), and vector-index restores (`restore`) were executed against Walrus Mainnet (`https://relayer.memory.walrus.xyz`, `accountId: 0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4`, namespace: `ajo-circle:lagos-techies-seed-circle`). Full receipts are saved in [`docs/walrus-mainnet-writes.json`](./docs/walrus-mainnet-writes.json):

| # | Category | Title | Walrus Mainnet `blob_id` | `job_id` |
| :- | :--- | :--- | :--- | :--- |
| 1 | Agreements | Tunde 72-Hour Contractor Grace Window | `_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc` | `e18a766a-2a7c-4c20-961d-a32c9aa7d31e` |
| 2 | Member patterns | Emeka Two-Tranche Split Contribution Pattern | `rPLnm650Px2cF9_l1UcK7zZZ7EjMLQlrTGEAZVILv0U` | `73cf1b54-7f82-4c4c-9b71-8ed1992ebc77` |
| 3 | Member patterns | Chidi Early Cycle Liquidity Anchor | `kmgKVSUM4PiTy1bJYHSAr3iVrspUvbvYVd_jhu3UWAU` | `7a7ac407-10f0-46b7-acf8-39d483e7ee81` |
| 4 | Reminder preferences | Folake Direct Notification Preference | `FYt7CvCY5YeKpVO7e1LDGwWNI-Bnb01PbJo2qm1_tKU` | `81c768fb-f698-4d19-876f-cc090d94389f` |
| 5 | Agreements | Emergency Medical Rotation Swap Rule | `cq4PFpzCxmWyXhQN7JkRRG6inU0KxvuzOBTaGDwySS8` | `2279c1ce-18b6-419b-baa9-0f704dcf74ca` |
| 6 | Agreements | Cycle 6 Turn Swap Between Zainab and Chidi | `QAoLGVx0ytBi5SczS6k8xBxO2_WkWk4WnpPmwpDa8bM` | `62c9bf23-b7b0-4d53-8847-e1eb277520c7` |
| 7 | Reminder preferences | Tunde Pre-Invoice Reminder Timing | `6BZtcqAEiGgHPtW1rqAgu11kuItlYI2_ohgCaC4MDcw` | `907b08c3-fca5-43b6-b54d-7fc5b909362f` |
| 8 | Member patterns | Amina Organizer Day-1 Verification Pattern | `DJGI6m-_PMB_tR2zNfywaurBkPEum8Phkde6fNFJE4Y` | `0a54db72-b106-496a-ab5e-b9371979c4fd` |
| 9 | Agreements | Strict Token Type Verification Policy | `ZqKcldiC6o3gxTR7GhuXeQ4UP1v9Vs85AskJbKpZiBM` | `6d68263e-b33e-4b07-b08f-4adf5d7a0c41` |
| 10 | Reminder preferences | Zainab Evening UTC Reminder Window | `AlrI6_KXE6dyYRvQ0oqLuYvJFk70xnzN5L_MeRX598A` | `1854272f-5ff8-407f-9aa9-054de70d6ea0` |
