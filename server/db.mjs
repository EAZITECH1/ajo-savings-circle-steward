import crypto from 'node:crypto'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadConfig, TUNABLE_DEFAULTS } from './config.mjs'
import {
  QUARANTINED_SYNTHETIC_CIRCLES,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
} from './payment-policy.mjs'

export class StorageUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=503]
   */
  constructor(message, statusCode = 503) {
    super(message)
    this.name = 'StorageUnavailableError'
    this.statusCode = statusCode
  }
}

export class StorageConflictError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=409]
   */
  constructor(message, statusCode = 409) {
    super(message)
    this.name = 'StorageConflictError'
    this.statusCode = statusCode
  }
}

/**
 * Versioned SQLite schema migrations.
 * Applied in a transaction at startup and tracked in `schema_migrations`.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: '001_initial_durable_schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS quarantined_records (
          record_id TEXT PRIMARY KEY,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('circle', 'walrus_blob')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS circles (
          circle_id TEXT PRIMARY KEY,
          circle_name TEXT NOT NULL,
          pool_address TEXT NOT NULL,
          normalized_pool_address TEXT NOT NULL,
          contribution_per_member REAL NOT NULL CHECK (contribution_per_member >= 0),
          token_type TEXT NOT NULL,
          cycle_length TEXT NOT NULL,
          current_cycle INTEGER NOT NULL CHECK (current_cycle >= 1),
          organizer_address TEXT NOT NULL,
          normalized_organizer_address TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS circle_members (
          circle_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          name TEXT NOT NULL,
          address TEXT NOT NULL,
          normalized_address TEXT NOT NULL,
          avatar_color TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (circle_id, member_id),
          UNIQUE (circle_id, normalized_address),
          FOREIGN KEY (circle_id) REFERENCES circles(circle_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_circle_members_norm_addr
          ON circle_members(normalized_address);

        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY,
          circle_id TEXT NOT NULL,
          category TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          title TEXT NOT NULL,
          quote TEXT NOT NULL,
          suggested_action TEXT NOT NULL,
          member_id TEXT,
          member_ids_json TEXT NOT NULL,
          cycle INTEGER NOT NULL,
          tx_digest TEXT,
          proposed_by TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
          walrus_blob_id TEXT,
          confirmed_by TEXT,
          confirmation_type TEXT,
          confirming_address TEXT,
          created_at TEXT NOT NULL,
          confirmed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_proposals_circle_status
          ON proposals(circle_id, status);

        CREATE TABLE IF NOT EXISTS confirmation_challenges (
          nonce TEXT PRIMARY KEY,
          circle_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          member_id TEXT NOT NULL,
          member_address TEXT NOT NULL,
          message TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
          consumed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_confirmation_challenges_proposal
          ON confirmation_challenges(proposal_id);

        CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
          challenge_id TEXT PRIMARY KEY,
          nonce TEXT NOT NULL UNIQUE,
          address TEXT NOT NULL,
          message TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
          consumed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS wallet_sessions (
          token_hash TEXT PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          public_key_base64 TEXT NOT NULL,
          scheme TEXT NOT NULL,
          authenticated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_wallet_sessions_address
          ON wallet_sessions(wallet_address);

        CREATE TABLE IF NOT EXISTS confirmed_memories_cache (
          walrus_blob_id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          circle_id TEXT NOT NULL,
          record_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_confirmed_memories_namespace
          ON confirmed_memories_cache(namespace);

        CREATE TABLE IF NOT EXISTS submitted_transactions (
          tx_digest TEXT NOT NULL,
          network TEXT NOT NULL,
          circle_id TEXT NOT NULL,
          cycle INTEGER NOT NULL,
          member_id TEXT,
          normalized_member_address TEXT NOT NULL,
          expected_pool_address TEXT NOT NULL,
          observed_sender TEXT,
          observed_recipient TEXT,
          token_type TEXT,
          amount REAL,
          execution_status TEXT NOT NULL,
          tx_timestamp_ms INTEGER,
          tx_timestamp_iso TEXT,
          verified_at_iso TEXT NOT NULL,
          PRIMARY KEY (tx_digest, network)
        );

        CREATE INDEX IF NOT EXISTS idx_submitted_tx_member_cycle
          ON submitted_transactions(circle_id, cycle, normalized_member_address);

        CREATE TABLE IF NOT EXISTS member_cycle_verifications (
          circle_id TEXT NOT NULL,
          cycle INTEGER NOT NULL,
          normalized_member_address TEXT NOT NULL,
          member_id TEXT,
          network TEXT NOT NULL,
          status TEXT NOT NULL,
          code TEXT NOT NULL,
          tx_digest TEXT,
          tx_digests_json TEXT NOT NULL,
          observed_sender TEXT,
          observed_recipient TEXT,
          token_received TEXT,
          amount_received REAL NOT NULL,
          execution_status TEXT NOT NULL,
          tx_timestamp_iso TEXT,
          hours_late REAL,
          error TEXT,
          raw_notes TEXT,
          policy_json TEXT,
          verified_at_iso TEXT NOT NULL,
          PRIMARY KEY (circle_id, cycle, normalized_member_address)
        );
      `)

      const nowIso = new Date().toISOString()
      const insertQuarantine = db.prepare(`
        INSERT OR IGNORE INTO quarantined_records (record_id, record_kind, reason, created_at)
        VALUES (?, ?, ?, ?)
      `)
      for (const circleId of QUARANTINED_SYNTHETIC_CIRCLES) {
        insertQuarantine.run(
          circleId.toLowerCase(),
          'circle',
          'Quarantined synthetic sample circle history (blocked from runtime use).',
          nowIso
        )
      }
      for (const blobId of QUARANTINED_SYNTHETIC_BLOB_IDS) {
        insertQuarantine.run(
          blobId,
          'walrus_blob',
          'Quarantined synthetic Walrus Mainnet blob from sample seed script.',
          nowIso
        )
      }
    },
  },
]

let activeDb = null
let activeDbPath = null
let simulatedOutageReason = null

/**
 * Resolve the effective SQLite file path.
 * - Uses explicit `dbPath` if passed.
 * - Uses `process.env.SQLITE_DB_PATH` if set.
 * - When running under `node --test` (`NODE_TEST_CONTEXT`) without an explicit `SQLITE_DB_PATH`,
 *   uses an isolated per-process SQLite file in `os.tmpdir()` so ephemeral test keypairs
 *   do not collide across separate test runs.
 * - Otherwise uses `TUNABLE_DEFAULTS.SQLITE_DB_PATH` (`.data/ajo-steward.sqlite`).
 */
export function resolveDefaultDbPath(customPath) {
  if (customPath && String(customPath).trim()) {
    return String(customPath).trim()
  }
  const envPath = process.env.SQLITE_DB_PATH
  if (envPath && envPath.trim()) {
    return envPath.trim()
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(), `ajo-steward-test-${process.pid}.sqlite`)
  }
  try {
    const cfg = loadConfig()
    return cfg.tunables.sqliteDbPath || TUNABLE_DEFAULTS.SQLITE_DB_PATH
  } catch {
    return TUNABLE_DEFAULTS.SQLITE_DB_PATH
  }
}

/**
 * Apply pending schema migrations inside an immediate transaction.
 * @param {DatabaseSync} db
 */
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all()
  const appliedVersions = new Set(appliedRows.map((r) => Number(r.version)))

  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `)

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue
    withTransaction(db, () => {
      migration.up(db)
      insertMigration.run(migration.version, migration.name, new Date().toISOString())
    })
  }
}

/**
 * Initialize or re-initialize the SQLite database connection and run migrations.
 * @param {string} [customPath]
 */
export function initDatabase(customPath) {
  if (activeDb) {
    try {
      activeDb.close()
    } catch {
      // Ignore already-closed handle
    }
    activeDb = null
  }

  simulatedOutageReason = null
  const rawPath = resolveDefaultDbPath(customPath)
  const resolvedPath = rawPath === ':memory:' ? ':memory:' : path.resolve(process.cwd(), rawPath)

  try {
    if (resolvedPath !== ':memory:') {
      mkdirSync(path.dirname(resolvedPath), { recursive: true })
    }
    const db = new DatabaseSync(resolvedPath)
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 5000;')
    if (resolvedPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;')
    }
    runMigrations(db)
    activeDb = db
    activeDbPath = resolvedPath
    return db
  } catch (err) {
    throw new StorageUnavailableError(
      `Durable storage initialization failed at "${resolvedPath}": ${err.message}`,
      503
    )
  }
}

/**
 * Get the active SQLite database connection, initializing lazily if needed.
 * Throws `StorageUnavailableError` if storage is unavailable or in simulated outage mode.
 * @returns {DatabaseSync}
 */
export function getDatabase() {
  if (simulatedOutageReason) {
    throw new StorageUnavailableError(simulatedOutageReason, 503)
  }
  if (!activeDb) {
    return initDatabase()
  }
  return activeDb
}

/**
 * Close the active SQLite database connection.
 */
export function closeDatabase() {
  if (activeDb) {
    try {
      activeDb.close()
    } catch {
      // Ignore close errors
    }
    activeDb = null
  }
}

/**
 * Simulate or clear a database outage for testing failure semantics.
 * @param {boolean} isOutage
 * @param {string} [reason]
 */
export function setDatabaseOutageForTesting(
  isOutage,
  reason = 'Durable SQLite storage is currently unavailable (simulated outage).'
) {
  simulatedOutageReason = isOutage ? reason : null
}

/**
 * Return metadata about the active durable storage engine.
 */
export function getDatabaseStatus() {
  try {
    const db = getDatabase()
    const migrations = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
      .all()
    return {
      available: true,
      engine: 'node:sqlite (DatabaseSync)',
      path: activeDbPath,
      schemaVersion: migrations.length > 0 ? migrations[migrations.length - 1].version : 0,
      migrationsCount: migrations.length,
    }
  } catch (err) {
    return {
      available: false,
      engine: 'node:sqlite (DatabaseSync)',
      path: activeDbPath,
      error: err.message,
    }
  }
}

/**
 * Execute a synchronous callback inside a `BEGIN IMMEDIATE` SQLite transaction.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore rollback failure if transaction was already aborted
    }
    throw err
  }
}

/**
 * Compute a SHA-256 hex digest of a bearer session token so raw session tokens
 * are never persisted in the SQLite database file.
 * @param {string} token
 */
export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token).trim(), 'utf8').digest('hex')
}

/**
 * Check whether a circle ID or Walrus blob ID is marked quarantined in durable storage.
 * @param {string} recordId
 */
export function isRecordQuarantinedInDb(recordId) {
  if (!recordId || typeof recordId !== 'string') return false
  try {
    const db = getDatabase()
    const trimmed = recordId.trim()
    const row = db
      .prepare(
        'SELECT record_id FROM quarantined_records WHERE record_id = ? OR record_id = ? LIMIT 1'
      )
      .get(trimmed, trimmed.toLowerCase())
    return Boolean(row)
  } catch {
    return false
  }
}
