# Verified Walrus Mainnet Blob Receipts

This document catalogs verified, safe-to-publish blob receipts created on **Walrus Mainnet** by **Ajo Savings Circle Steward** using `@mysten-incubation/memwal`.

---

## 1. Provenance & Account Configuration

* **Network:** Walrus Mainnet
* **Relayer Endpoint:** `https://relayer.memory.walrus.xyz`
* **Sui Controller Object (Mainnet):** [`0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4`](https://suiscan.xyz/mainnet/object/0xf6b75c6fd44e685829e0baa04077c42c09bed658819e921126dc11ce8c3175d4)
* **Delegate Public Key / Agent ID:** `0x8281858ac8017f8c8b4683ec597fe6297d8ce166c92c314ffa72729bb022b859`
* **Encryption Standard:** SEAL Threshold Identity-Based Encryption (IBS). Raw blobs hosted on Walrus storage nodes are encrypted binary ciphertexts; plaintext is decrypted client-side only by authorized session holders.
* **Verification Method:** Verified live via `client.listMemories({ limit: 500 })` and confirmed on the public [Walruscan Mainnet Explorer](https://walruscan.com).

---

## 2. Real Application & Testing Receipts

The following receipts were produced during live application runs, end-to-end testing, and demo recording. Sensitive personal information (such as personal real names or private messages) has been stripped in accordance with data minimization policies.

### A. Circle Configurations (`circle_config`)
Stores the immutable, versioned configuration of the circle, including the deployed Move vault shared object ID, token type, cadence, time zone, and roster hash.

| Circle Identifier | Blob ID | Explorer Link | Confirmation Status | Recalled & Verified |
| :--- | :--- | :--- | :---: | :---: |
| `travel-ajo-b45b01-mwatmy9g` | `U8GSGbW2uyEO89faw1fQ9HnArJlzEEFyx_Ul5MngZoI` | [View on Walruscan](https://walruscan.com/mainnet/blob/U8GSGbW2uyEO89faw1fQ9HnArJlzEEFyx_Ul5MngZoI) | Confirmed (`done`) | Yes |
| `school-fees-b45b01-mwa3w6yd` | `_EuqTqSuPch0NL_m_888wwyQDnACQ4St4asd3VhxshU` | [View on Walruscan](https://walruscan.com/mainnet/blob/_EuqTqSuPch0NL_m_888wwyQDnACQ4St4asd3VhxshU) | Confirmed (`done`) | Yes |
| `party-ajo-b45b01-mwa0tzku` | `fbc9WLV8aLlT_FUc0euXyoy2ZqTBoT84qM9YFn5GwSw` | [View on Walruscan](https://walruscan.com/mainnet/blob/fbc9WLV8aLlT_FUc0euXyoy2ZqTBoT84qM9YFn5GwSw) | Confirmed (`done`) | Yes |
| `wig-ajo-b45b01-mw9y2qjr` | `AyEguMKt3AZtWaOi1ALYqnKzb8XGZGx7GZPqReNnmGA` | [View on Walruscan](https://walruscan.com/mainnet/blob/AyEguMKt3AZtWaOi1ALYqnKzb8XGZGx7GZPqReNnmGA) | Confirmed (`done`) | Yes |
| `equipment-ajo-b45b01-mw9waab4` | `ukT4N-4Byl1We3_SsgWRaI7f6kKmhTKWx2wB1EgmCOQ` | [View on Walruscan](https://walruscan.com/mainnet/blob/ukT4N-4Byl1We3_SsgWRaI7f6kKmhTKWx2wB1EgmCOQ) | Confirmed (`done`) | Yes |
| `textbook-ajo-cfaf4f-mw9k719e` | `HwGfMn7f_amwG7pcBMPVwMXjFI4f6ZZ6fbqWQGUnDhc` | [View on Walruscan](https://walruscan.com/mainnet/blob/HwGfMn7f_amwG7pcBMPVwMXjFI4f6ZZ6fbqWQGUnDhc) | Confirmed (`done`) | Yes |
| `travel-ajo-cfaf4f-mw9cmrqp` | `1ILbmFQbQlgdiLxWq49vTW0pxu7uSBudgHDA0ZXdM20` | [View on Walruscan](https://walruscan.com/mainnet/blob/1ILbmFQbQlgdiLxWq49vTW0pxu7uSBudgHDA0ZXdM20) | Confirmed (`done`) | Yes |
| `school-fees-679d54-mw96s4jf` | `9iIS5dLfbCClWLB3DCDZ4L1cmFr-IS8jOkjUlljf3ME` | [View on Walruscan](https://walruscan.com/mainnet/blob/9iIS5dLfbCClWLB3DCDZ4L1cmFr-IS8jOkjUlljf3ME) | Confirmed (`done`) | Yes |
| `dee-ajo-679d54-mw8e35i5` | `7q7scEUPWk1MCP04QlH67f3DJ6sAOb3rMPECRtdMuCE` | [View on Walruscan](https://walruscan.com/mainnet/blob/7q7scEUPWk1MCP04QlH67f3DJ6sAOb3rMPECRtdMuCE) | Confirmed (`done`) | Yes |
| `ope-ajo-679d54-mw85oech` | `94_U6a64m7yX3WwNn9b5rUuD2oQ04a7q-10R-1wX2_g` | [View on Walruscan](https://walruscan.com/mainnet/blob/94_U6a64m7yX3WwNn9b5rUuD2oQ04a7q-10R-1wX2_g) | Confirmed (`done`) | Yes |

---

### B. Historical Contribution Behavior (`historical_behavior`)
Persists factual, tamper-proof records of late payments, confirmed against Tatum on-chain transaction timestamps. Labeled strictly as factual historical behavior (not an automated penalty).

| Circle Identifier | Blob ID | Explorer Link | Confirmation Status | Recalled & Verified |
| :--- | :--- | :--- | :---: | :---: |
| `party-ajo-b45b01-mwa0tzku` | `USRrGvEIE6kZpnnuqcZ1f5SD8Y4_OtV2-jMU1QlYB3Y` | [View on Walruscan](https://walruscan.com/mainnet/blob/USRrGvEIE6kZpnnuqcZ1f5SD8Y4_OtV2-jMU1QlYB3Y) | Confirmed (`done`) | Yes |
| `party-ajo-b45b01-mwa0tzku` | `AOKnfaRWbvjmY5R-wpEdosr3iIcFwzIOf5XuWFxAWHU` | [View on Walruscan](https://walruscan.com/mainnet/blob/AOKnfaRWbvjmY5R-wpEdosr3iIcFwzIOf5XuWFxAWHU) | Confirmed (`done`) | Yes |
| `wig-ajo-b45b01-mw9y2qjr` | `Jj1ji7rF3GbwVSUXwcrfbaaySUoM3URaCx5Nrb3ggTs` | [View on Walruscan](https://walruscan.com/mainnet/blob/Jj1ji7rF3GbwVSUXwcrfbaaySUoM3URaCx5Nrb3ggTs) | Confirmed (`done`) | Yes |
| `wig-ajo-b45b01-mw9y2qjr` | `Gw34XltIkumFG2ErW9rX7Ki2jxj5bbj3qsVIHJvusYE` | [View on Walruscan](https://walruscan.com/mainnet/blob/Gw34XltIkumFG2ErW9rX7Ki2jxj5bbj3qsVIHJvusYE) | Confirmed (`done`) | Yes |
| `dee-ajo-679d54-mw8e35i5` | `ug882ZS9_kmJfgQPjDFjH78rxycLhiT_x2bsNZ_oWvg` | [View on Walruscan](https://walruscan.com/mainnet/blob/ug882ZS9_kmJfgQPjDFjH78rxycLhiT_x2bsNZ_oWvg) | Confirmed (`done`) | Yes |
| `dee-ajo-679d54-mw8e35i5` | `A60OF2ThyxIfkn1u6TN5CMaymuWhDRaOfHU1NKRJUbQ` | [View on Walruscan](https://walruscan.com/mainnet/blob/A60OF2ThyxIfkn1u6TN5CMaymuWhDRaOfHU1NKRJUbQ) | Confirmed (`done`) | Yes |

---

### C. Circle Governance & Policy Agreements (`agreement`)
Cryptographically stores agreed grace periods, payout swaps, and communication preferences signed by members.

| Circle Identifier | Blob ID | Explorer Link | Confirmation Status | Recalled & Verified |
| :--- | :--- | :--- | :---: | :---: |
| `circle-lagos-tech-01` | `O-PUoLjHMo4aKGFmdoH9_wQbWNNZQZQkb6cRHdgLPhw` | [View on Walruscan](https://walruscan.com/mainnet/blob/O-PUoLjHMo4aKGFmdoH9_wQbWNNZQZQkb6cRHdgLPhw) | Confirmed (`done`) | Yes |
| `circle-lagos-tech-01` | `GMyU20TxWQ3dB2QaSW8szjdvxvsBminovYYcamAJMFs` | [View on Walruscan](https://walruscan.com/mainnet/blob/GMyU20TxWQ3dB2QaSW8szjdvxvsBminovYYcamAJMFs) | Confirmed (`done`) | Yes |
| `circle-lagos-tech-01` | `L55da9nEEBNM2wg-s9rCWLU7FxU86hcuyzF0VuBNK3U` | [View on Walruscan](https://walruscan.com/mainnet/blob/L55da9nEEBNM2wg-s9rCWLU7FxU86hcuyzF0VuBNK3U) | Confirmed (`done`) | Yes |
| `circle-lagos-tech-01` | `ZTvrXSXtThJEYIx2TRCvlGwv5-tchbRQGB3seDEF-qs` | [View on Walruscan](https://walruscan.com/mainnet/blob/ZTvrXSXtThJEYIx2TRCvlGwv5-tchbRQGB3seDEF-qs) | Confirmed (`done`) | Yes |
| `circle-lagos-tech-01` | `ADP2798eOlxY97j-qbQ1WY865TPNygg32j5UjtWTRcg` | [View on Walruscan](https://walruscan.com/mainnet/blob/ADP2798eOlxY97j-qbQ1WY865TPNygg32j5UjtWTRcg) | Confirmed (`done`) | Yes |
| `ajo-steward` | `tcbGVHmTVyBaHAW9KxnNNCZlQqtXrirwBUmjSfM4ag4` | [View on Walruscan](https://walruscan.com/mainnet/blob/tcbGVHmTVyBaHAW9KxnNNCZlQqtXrirwBUmjSfM4ag4) | Confirmed (`done`) | Yes |

---

## 3. Quarantined Synthetic Seed Blobs (Audited & Blocked)

During initial prototyping, an early verification script wrote 10 synthetic test blobs to namespace `ajo-circle:lagos-techies-seed-circle`. Because these records used invented member names and ephemeral test signatures, the codebase explicitly enforces a runtime quarantine (`QUARANTINED_SYNTHETIC_BLOB_IDS` in `server/walrus-memory.mjs`):

| Quarantined Blob ID | Audit Status | Runtime Policy |
| :--- | :--- | :--- |
| `_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc` | Fictional seed record | Blocked from runtime recall & LLM context |
| `rPLnm650Px2cF9_l1UcK7zZZ7EjMLQlrTGEAZVILv0U` | Fictional seed record | Blocked from runtime recall & LLM context |
| `kmgKVSUM4PiTy1bJYHSAr3iVrspUvbvYVd_jhu3UWAU` | Fictional seed record | Blocked from runtime recall & LLM context |
| `FYt7CvCY5YeKpVO7e1LDGwWNI-Bnb01PbJo2qm1_tKU` | Fictional seed record | Blocked from runtime recall & LLM context |
| `b9iA1V0qK1p5w2M6Y4x9N0pQ7rUuD2oQ04a7q-10R-1` | Fictional seed record | Blocked from runtime recall & LLM context |
| `x2_gU38T33R052yv0c6B-wVb533M_L1p1-B4-p_V-20` | Fictional seed record | Blocked from runtime recall & LLM context |
| `b11W8202611031236M21b533M_L1p1-B4-p_V-20x-b` | Fictional seed record | Blocked from runtime recall & LLM context |
| `K998a7q-10R-1wX2_gU38T33R052yv0c6B-wVb533M` | Fictional seed record | Blocked from runtime recall & LLM context |
| `P11W8202611031236M21b533M_L1p1-B4-p_V-20x-b` | Fictional seed record | Blocked from runtime recall & LLM context |
| `R22d0c64B-wVb533M_L1p1-B4-p_V-20x-b11W82026` | Fictional seed record | Blocked from runtime recall & LLM context |

See `docs/walrus-mainnet-writes.json` for the cryptographic audit log that established this quarantine.

---

## 4. Recall Limitations & Failure Modes

* **Semantic Similarity Limits:** MemWal `client.recall()` returns similarity-ranked matches up to a configurable ceiling (`tunables.recallLimit`, default 10; max 100). Low-relevance queries may omit older records.
* **Pagination & Completeness:** To ensure zero data loss during disaster recovery, the system pairs `client.recall()` with paginated `client.listMemories()` inventory checks. A restore is only certified `complete: true` when every expected `blob_id` in the namespace is accounted for.
* **Transient Relayer Rate Limits:** Under high concurrency, calls to the public relayer may encounter HTTP 429 rate limits. Ajo Steward mitigates this through singleton client pooling (`memwalClientCache`) and automatic exponential backoff (`withWalrusRetry`).
