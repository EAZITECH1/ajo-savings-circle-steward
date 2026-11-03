# Ajo Savings Circle Steward

A non-custodial rotating savings circle (Ajo / Esusu / ROSCA) steward built on **Sui** (via **Tatum Sui Gateway**) and **Walrus Memory** (`@mysten-incubation/memwal` on Walrus Mainnet).

## Architecture & Security Invariants

1. **Digest-First Sui Verification via Tatum (`https://sui-{network}.gateway.tatum.io/graphql` & `sui_getTransactionBlock`)**
   - A member or organizer submits a Sui transaction digest (`Base58`).
   - Per Tatum's official Sui documentation (`https://docs.tatum.io/reference/rpc-sui.md`), Tatum documents JSON-RPC (`sui_getTransactionBlock`) on Sui Mainnet (`https://sui-mainnet.gateway.tatum.io`) and gRPC on Sui Testnet, while exposing `/_methods` on every gateway host for live supported interfaces. On the live Tatum Sui gateway (`https://sui-testnet.gateway.tatum.io/_methods` and `https://sui-mainnet.gateway.tatum.io/_methods`), Tatum serves Sui GraphQL at `POST https://sui-{network}.gateway.tatum.io/graphql` with header `x-api-key: <TATUM_API_KEY>`.
   - `server/sui-verifier.mjs` queries `transaction(digest: $digest)` via `server/tatum-client.mjs` (`tatumGraphql`, plus `sui_getTransactionBlock` JSON-RPC support) through a rate-limited queue with exponential backoff.
   - Verifies `sender.address`, `effects.status === "SUCCESS"`, `effects.timestamp`, and `effects.balanceChanges.nodes` (`owner.address`, `coinType.repr`, `amount`) against the circle's registered `poolAddress`, `tokenType`, `contributionPerMember`, and cycle window (`windowStart` .. `windowEnd`).
   - Supports two-tranche split payments from the same member within `PARTIAL_PAYMENT_WINDOW_HOURS`.
   - Returns `Unverified` (with an explicit diagnostic) whenever Tatum is unconfigured/unavailable, a digest is malformed or not found on-chain, or required fields are missing. Returns `Pending` only when a complete lookup establishes no digest/transfer has been matched yet.

2. **Strict Separation of Chain Facts vs. Group Policy**
   - On-chain facts (`Verified`, `Late`, `Partial`, `WrongToken`, `WrongAmount`, `Pending`, `Unverified`) are **never** relabeled to fit group policy.
   - A contribution that arrives after `windowEnd` always remains `Chain: Late`.
   - When **With memory** is enabled and a confirmed grace agreement is recalled from Walrus Memory on the server, the separate policy evaluator produces `Policy: Accepted under recorded grace agreement` (`countsTowardPot: true`), displaying both badges side by side in the UI.
   - When **Without memory** is selected, the exact same code path runs with memory recall disabled, producing `Policy: Unexcused late payment` (`countsTowardPot: false`).

3. **Address-Bound Wallet Authentication & Proposal-Bound Memory Confirmations**
   - All sensitive API routes (`/api/memory/*`, `/api/tatum/sui/*`, `/api/steward/*`) require a verified wallet session (`Authorization: Bearer <token>`) issued via `/api/auth/challenge` and `/api/auth/verify`, and enforce server-side circle membership (`verifyCircleMembership`).
   - Signature verification (`server/wallet-auth.mjs`) uses the official `@mysten/sui` SDK (`verifyPersonalMessageSignature` from `@mysten/sui/verify` and `Ed25519PublicKey` from `@mysten/sui/keypairs/ed25519`) to cryptographically prove that the signing public key derives to the registered member's Sui address (`publicKey.toSuiAddress()`). A valid signature from an unrelated key is always rejected (`403`).
   - Memory confirmation challenges (`POST /api/memory/challenge`) bind `circleId`, `proposalId`, `proposalHash` (SHA-256 of canonical proposal content), `member.id`, normalized `member.address`, a one-time `nonce` (consumed immediately on first lookup), and `expiresAt`.
   - Member-signed confirmations (`wallet_signature_verified`) are labeled `"Member-signed by <Name> (<Address>) — 1 wallet signature, not full group consensus"`. Organizer-entered records (`organizer_entered`, restricted to the circle's registered `organizerAddress`) are labeled `"Organizer-entered record by <Name> (<Address>) — organizer entry only, not member-signed consensus"`. Neither is presented as multi-member group voting.

4. **Zero Trust in Browser-Supplied Evidence**
   - `server/steward-llm.mjs` and `server/routes/tatum.mjs` never accept or fall back to browser-supplied `memories` or `verifications`.
   - The server recalls memories directly from Walrus Memory and reads contribution status strictly from server-verified Tatum transaction records (`getServerVerifiedContribution`). If Walrus Memory or Tatum is unavailable, the server reports the unavailable state explicitly rather than trusting client state.

5. **Preview-Compliant Persistence (`Walrus Mainnet` for Confirmed Group Memories + `Tatum` for Payment Evidence)**
   - Per the AI Builder preview runtime constraints (`AGENTS.md`: no runtime database and read-only `/data` container filesystem), the server performs zero local disk writes at runtime.
   - **Confirmed group memories (`server/walrus-memory.mjs`)**: Persisted on **Walrus Mainnet** via `@mysten-incubation/memwal` (`rememberAndWait`). After a server restart, `POST /api/memory/restore` (`restore()`) re-indexes any missing on-chain Walrus blobs and recalls recent confirmed memories for the circle's namespace.
   - **Payment evidence (`server/sui-verifier.mjs`)**: **Tatum** (`https://sui-{network}.gateway.tatum.io/graphql` and `sui_getTransactionBlock`) is the authoritative source of Sui payment evidence (`txDigest`, `observedSender`, `observedRecipient`, `tokenReceived`, `amountReceived`, `executionStatus`, `timestamp`). Conflicting transaction digest claims across different members, circles, or cycles are rejected with `TransactionConflictError` (`409`).
   - **Session & roster state (`server/wallet-auth.mjs`, `server/walrus-memory.mjs`)**: Held in server memory (`Map`/`Set`) with SHA-256 hashed session tokens, one-time challenge consumption, and duplicate member ID / duplicate wallet address prevention (`409`). Raw bearer session tokens, private keys, API keys, and raw wallet signature bytes are never persisted to disk.

---

## Quarantine Notice for Earlier Synthetic Mainnet Blobs (`lagos-techies-seed-circle`)

During an earlier integration test, 10 synthetic sample records were written to Walrus Mainnet under namespace `ajo-circle:lagos-techies-seed-circle` (documented in [`docs/walrus-mainnet-writes.json`](./docs/walrus-mainnet-writes.json)).
- Those 10 records describe fictional sample-circle members and agreements, and 5 of them were signed by an ephemeral test keypair that did not derive to the claimed wallet address.
- **Runtime Quarantine**: All 10 blob IDs (`QUARANTINED_SYNTHETIC_BLOB_IDS`) and the `lagos-techies-seed-circle` circle/namespace (`QUARANTINED_SYNTHETIC_CIRCLES`) are strictly blocklisted in `server/payment-policy.mjs` and `server/walrus-memory.mjs`. They cannot be recalled, listed, restored, or used in policy evaluation, payout recommendations, or Steward LLM prompts.
- **Read-Only Audit Inventory**: Run `npm run inventory:walrus` (`scripts/inventory-walrus-mainnet.mjs`) to inspect the quarantined records in read-only mode without modifying Walrus Mainnet.
- **Official Walrus Memory Deletion Options**: The `@mysten-incubation/memwal` delegate-key SDK intentionally does not expose a delete method. Deleting on-chain Walrus blobs requires the account owner Sui wallet (`0x679d547b18cf9f2e77f1d33f932cbf4de5c63dda6a5c5d0e44caf7ae4334cd1b`) via either:
  1. **Walrus Memory Dashboard (`https://memory.walrus.xyz/dashboard`)**: Connect the owner wallet → **Delete memories** panel → select the 10 blob IDs → **Delete selected (10)**.
  2. **Programmatic Security Delete API**: Authenticate with owner wallet signature (`POST /api/security-delete-auth/challenge` → `POST /api/security-delete-auth/verify`), list deletable blobs (`GET /api/security-deletable-blobs`), prepare a sponsored deletion transaction (`POST /api/security-deletions` with `mode: 'selection', blobIds: [...]`), sign `txBytes` with the owner wallet, and submit (`POST /api/security-deletions/{batchId}/submit`).

---

## Environment Variables

Copy `.env.example` to `.env` (gitignored) and populate the credentials for the integrations you want active.

| Variable | Required For | Description |
| :--- | :--- | :--- |
| `PORT` | Optional (default `3000`) | Express + Vite server port |
| `TATUM_API_KEY` | Tatum Sui Verifier | Tatum API key (`x-api-key` header) |
| `TATUM_API_BASE` | Tatum Sui Verifier | Tatum API base URL (e.g. `https://api.tatum.io`) |
| `SUI_NETWORK` | Tatum Sui Verifier | `mainnet` or `testnet` |
| `SUI_TOKEN_TYPE` | Tatum Sui Verifier | Move coin type (e.g. `0x2::sui::SUI`) |
| `SUI_TOKEN_DECIMALS` | Optional (default `6`) | Token decimals (`9` for SUI, `6` for USDC) |
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

## Setup & Scripts

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Run unit, route-authorization, and live integration tests
npm test

# 4. Run read-only Walrus Mainnet inventory (never writes or deletes)
npm run inventory:walrus

# 5. Restore / re-index a registered circle namespace from Walrus Mainnet
npm run restore:walrus -- <circle-id> 15

# 6. Start the Express + Vite application on port 3000
npm run dev
```
