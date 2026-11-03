import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Load `.env` from the project root if present without overwriting existing process.env vars.
 */
export function loadDotEnvIfPresent(envFilePath = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(envFilePath)) return
  try {
    const raw = readFileSync(envFilePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined && val !== '') {
        process.env[key] = val
      }
    }
  } catch {
    // Ignore unreadable .env file
  }
}

export class ConfigValidationError extends Error {
  /**
   * @param {string} service
   * @param {string[]} issues
   */
  constructor(service, issues) {
    super(`[ConfigValidationError:${service}] ${issues.join('; ')}`)
    this.name = 'ConfigValidationError'
    this.service = service
    this.issues = issues
  }
}

/**
 * Helper for numeric environment variables with documented defaults.
 * Fails validation if a non-empty string is not a valid number in range.
 */
function envInt(defaultValue, min, max) {
  return z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val.trim() === '') return defaultValue
      const parsed = Number(val)
      if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected integer between ${min} and ${max ?? '∞'}, received "${val}"`,
        })
        return z.NEVER
      }
      return parsed
    })
}

function envPositiveNumber(defaultValue, min, max) {
  return z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val.trim() === '') return defaultValue
      const parsed = Number(val)
      if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected number between ${min} and ${max ?? '∞'}, received "${val}"`,
        })
        return z.NEVER
      }
      return parsed
    })
}

/**
 * Documented tunable defaults (overridable via environment variables):
 * - GRACE_WINDOW_HOURS: 72 hours (standard approved late-payment grace window when a grace agreement exists)
 * - PARTIAL_PAYMENT_WINDOW_HOURS: 48 hours (max window between split payment tranches from the same member)
 * - POLLING_INTERVAL_MS: 1500 ms (background job status polling interval)
 * - RATE_LIMIT_RPS: 3 requests/second (max outbound RPC/API rate before queuing)
 * - RATE_LIMIT_MAX_RETRIES: 3 retries (max retry attempts on 429 / transient network failure)
 * - RATE_LIMIT_BACKOFF_MS: 1000 ms (initial exponential backoff delay in ms)
 * - RECALL_LIMIT: 10 memories (default top-K semantic memories recalled per Steward query)
 * - REQUEST_TIMEOUT_MS: 20000 ms (per-request HTTP timeout in ms)
 * - PORT: 3000 (HTTP server listening port)
 */
export const TUNABLE_DEFAULTS = Object.freeze({
  PORT: 3000,
  GRACE_WINDOW_HOURS: 72,
  PARTIAL_PAYMENT_WINDOW_HOURS: 48,
  POLLING_INTERVAL_MS: 1500,
  RATE_LIMIT_RPS: 3,
  RATE_LIMIT_MAX_RETRIES: 3,
  RATE_LIMIT_BACKOFF_MS: 1000,
  RECALL_LIMIT: 10,
  REQUEST_TIMEOUT_MS: 20000,
  SQLITE_DB_PATH: '.data/ajo-steward.sqlite',
})

export const TunablesEnvSchema = z.object({
  PORT: envInt(TUNABLE_DEFAULTS.PORT, 1, 65535),
  GRACE_WINDOW_HOURS: envPositiveNumber(TUNABLE_DEFAULTS.GRACE_WINDOW_HOURS, 0, 720),
  PARTIAL_PAYMENT_WINDOW_HOURS: envPositiveNumber(TUNABLE_DEFAULTS.PARTIAL_PAYMENT_WINDOW_HOURS, 0, 720),
  POLLING_INTERVAL_MS: envInt(TUNABLE_DEFAULTS.POLLING_INTERVAL_MS, 100, 60000),
  RATE_LIMIT_RPS: envPositiveNumber(TUNABLE_DEFAULTS.RATE_LIMIT_RPS, 0.1, 1000),
  RATE_LIMIT_MAX_RETRIES: envInt(TUNABLE_DEFAULTS.RATE_LIMIT_MAX_RETRIES, 0, 10),
  RATE_LIMIT_BACKOFF_MS: envInt(TUNABLE_DEFAULTS.RATE_LIMIT_BACKOFF_MS, 50, 60000),
  RECALL_LIMIT: envInt(TUNABLE_DEFAULTS.RECALL_LIMIT, 1, 50),
  REQUEST_TIMEOUT_MS: envInt(TUNABLE_DEFAULTS.REQUEST_TIMEOUT_MS, 500, 120000),
  SQLITE_DB_PATH: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined || val.trim() === '') return TUNABLE_DEFAULTS.SQLITE_DB_PATH
      return val.trim()
    }),
})

export const TatumEnvSchema = z.object({
  TATUM_API_KEY: z.string().trim().min(1, 'TATUM_API_KEY is required'),
  TATUM_API_BASE: z
    .string()
    .trim()
    .url('TATUM_API_BASE must be a valid URL')
    .transform((u) => u.replace(/\/+$/, '')),
  SUI_NETWORK: z.enum(['mainnet', 'testnet'], {
    errorMap: () => ({ message: 'SUI_NETWORK must be "mainnet" or "testnet"' }),
  }),
  SUI_TOKEN_TYPE: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/, 'SUI_TOKEN_TYPE must be a valid Sui coin type (0x...::module::Type)')
    .optional(),
  SUI_TOKEN_DECIMALS: envInt(6, 0, 18),
})

export const MemWalEnvSchema = z.object({
  MEMWAL_KEY: z
    .string()
    .trim()
    .min(1, 'MEMWAL_KEY is required')
    .refine(
      (v) => /^(0x)?[a-fA-F0-9]{64}$/.test(v) || /^suiprivkey1[a-z0-9]+$/.test(v),
      'MEMWAL_KEY must be a 64-character hex Ed25519 private key or suiprivkey1... bech32 string'
    ),
  MEMWAL_ACCOUNT_ID: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{1,64}$/, 'MEMWAL_ACCOUNT_ID must be a valid Sui object ID (0x...)'),
  MEMWAL_SERVER_URL: z
    .string()
    .trim()
    .url('MEMWAL_SERVER_URL must be a valid URL')
    .transform((u) => u.replace(/\/+$/, '')),
  MEMWAL_NAMESPACE_PREFIX: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]+$/, 'MEMWAL_NAMESPACE_PREFIX must contain only alphanumeric, underscore, or hyphen characters')
    .optional(),
})

export const LlmEnvSchema = z.object({
  LLM_API_KEY: z.string().trim().min(1, 'LLM_API_KEY is required'),
  LLM_BASE_URL: z
    .string()
    .trim()
    .url('LLM_BASE_URL must be a valid URL')
    .transform((u) => u.replace(/\/+$/, '')),
  LLM_MODEL: z.string().trim().min(1, 'LLM_MODEL is required'),
})

/**
 * Evaluate a single integration's environment variables.
 * Never throws; returns structured availability + missing/invalid diagnostics.
 */
function evaluateIntegration(name, requiredKeys, allKeys, schema, env) {
  const presentKeys = allKeys.filter((k) => typeof env[k] === 'string' && env[k].trim() !== '')
  const missingRequired = requiredKeys.filter(
    (k) => typeof env[k] !== 'string' || env[k].trim() === ''
  )

  if (presentKeys.length === 0) {
    return {
      service: name,
      configured: false,
      status: 'unconfigured',
      missingVars: requiredKeys,
      issues: [`Missing required environment variables: ${requiredKeys.join(', ')}`],
      config: null,
    }
  }

  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    return {
      service: name,
      configured: false,
      status: missingRequired.length > 0 ? 'incomplete' : 'invalid',
      missingVars: missingRequired,
      issues,
      config: null,
    }
  }

  return {
    service: name,
    configured: true,
    status: 'configured',
    missingVars: [],
    issues: [],
    config: parsed.data,
  }
}

/**
 * Validate and load server configuration from `env` (defaults to `process.env`).
 * - Tunables are validated strictly at startup; invalid numeric tunables throw `ConfigValidationError`.
 * - Service integrations (`tatum`, `memwal`, `llm`) are validated individually so the server
 *   can start and report honest per-service status when a credential is absent.
 */
export function loadConfig(env = process.env) {
  const tunablesParsed = TunablesEnvSchema.safeParse(env)
  if (!tunablesParsed.success) {
    const issues = tunablesParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new ConfigValidationError('tunables', issues)
  }

  const tatum = evaluateIntegration(
    'tatum',
    ['TATUM_API_KEY', 'TATUM_API_BASE', 'SUI_NETWORK'],
    ['TATUM_API_KEY', 'TATUM_API_BASE', 'SUI_NETWORK', 'SUI_TOKEN_TYPE', 'SUI_TOKEN_DECIMALS'],
    TatumEnvSchema,
    env
  )

  const memwal = evaluateIntegration(
    'memwal',
    ['MEMWAL_KEY', 'MEMWAL_ACCOUNT_ID', 'MEMWAL_SERVER_URL'],
    ['MEMWAL_KEY', 'MEMWAL_ACCOUNT_ID', 'MEMWAL_SERVER_URL', 'MEMWAL_NAMESPACE_PREFIX'],
    MemWalEnvSchema,
    env
  )

  const llm = evaluateIntegration(
    'llm',
    ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'],
    ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'],
    LlmEnvSchema,
    env
  )

  const t = tunablesParsed.data

  return {
    tunables: {
      port: t.PORT,
      graceWindowHours: t.GRACE_WINDOW_HOURS,
      partialPaymentWindowHours: t.PARTIAL_PAYMENT_WINDOW_HOURS,
      pollingIntervalMs: t.POLLING_INTERVAL_MS,
      rateLimitRps: t.RATE_LIMIT_RPS,
      rateLimitMaxRetries: t.RATE_LIMIT_MAX_RETRIES,
      rateLimitBackoffMs: t.RATE_LIMIT_BACKOFF_MS,
      recallLimit: t.RECALL_LIMIT,
      requestTimeoutMs: t.REQUEST_TIMEOUT_MS,
      sqliteDbPath: t.SQLITE_DB_PATH,
    },
    integrations: {
      tatum,
      memwal,
      llm,
    },
  }
}

/**
 * Require a specific service integration to be validly configured, throwing
 * a `ConfigValidationError` if missing or invalid.
 */
export function requireIntegrationConfig(serviceName, env = process.env) {
  const cfg = loadConfig(env)
  const integration = cfg.integrations[serviceName]
  if (!integration) {
    throw new ConfigValidationError(serviceName, [`Unknown service "${serviceName}"`])
  }
  if (!integration.configured || !integration.config) {
    throw new ConfigValidationError(serviceName, integration.issues)
  }
  return {
    serviceConfig: integration.config,
    tunables: cfg.tunables,
  }
}

/**
 * Return all secret values currently present in `env` so outbound response guards
 * can redact them before any payload leaves the server.
 */
export function configuredSecretValues(env = process.env) {
  const candidateKeys = ['TATUM_API_KEY', 'MEMWAL_KEY', 'LLM_API_KEY']
  return candidateKeys
    .map((k) => env[k])
    .filter((v) => typeof v === 'string' && v.trim().length >= 8)
    .map((v) => v.trim())
}
