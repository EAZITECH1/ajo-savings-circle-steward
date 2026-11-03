// Tatum access for server routes. All endpoints, keys, networks, and timeouts
// come from validated environment configuration via ./config.mjs.

import { requireIntegrationConfig, ConfigValidationError } from './config.mjs'

export class MissingApiKeyError extends Error {
  constructor(message = 'TATUM_API_KEY / Tatum configuration is not set for this workspace') {
    super(message)
    this.name = 'MissingApiKeyError'
  }
}

export function getTatumContext(env = process.env) {
  try {
    const { serviceConfig, tunables } = requireIntegrationConfig('tatum', env)
    return { serviceConfig, tunables }
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new MissingApiKeyError(err.message)
    }
    throw err
  }
}

export function tatumApiBase(env = process.env) {
  const { serviceConfig } = getTatumContext(env)
  return serviceConfig.TATUM_API_BASE
}

function tatumDomain(env = process.env) {
  const host = new URL(tatumApiBase(env)).hostname
  return host.replace(/^api\./, '')
}

export function tatumGatewayUrl(chain, network, env = process.env) {
  const { serviceConfig } = getTatumContext(env)
  const resolvedNetwork = network || serviceConfig.SUI_NETWORK
  return `https://${chain}-${resolvedNetwork}.gateway.${tatumDomain(env)}`
}

function withKey(headers, env = process.env) {
  const { serviceConfig } = getTatumContext(env)
  const h = new Headers(headers)
  h.set('x-api-key', serviceConfig.TATUM_API_KEY)
  return h
}

export async function tatumFetch(path, init = {}, env = process.env) {
  const { tunables } = getTatumContext(env)
  return fetch(`${tatumApiBase(env)}${path.startsWith('/') ? path : `/${path}`}`, {
    signal: AbortSignal.timeout(tunables.requestTimeoutMs),
    ...init,
    headers: withKey(init.headers, env),
  })
}

export async function tatumRpc(chain, body, network, env = process.env) {
  const { tunables } = getTatumContext(env)
  return fetch(tatumGatewayUrl(chain, network, env), {
    method: 'POST',
    signal: AbortSignal.timeout(tunables.requestTimeoutMs),
    headers: withKey({ 'Content-Type': 'application/json' }, env),
    body: JSON.stringify(body),
  })
}
