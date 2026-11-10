// Sui on-chain Circle object reader via Tatum GraphQL / RPC
// Reads the live Circle<T> Move object state from the blockchain.

import { tatumGraphql } from './tatum-client.mjs'
import { loadConfig } from './config.mjs'

export async function fetchOnchainCircleState(circleObjectId, env = process.env) {
  if (!circleObjectId || typeof circleObjectId !== 'string') {
    throw new Error('circleObjectId must be a non-empty string')
  }

  const cleanId = circleObjectId.trim().toLowerCase().startsWith('0x')
    ? circleObjectId.trim()
    : `0x${circleObjectId.trim()}`

  const query = `
    query GetCircleState($address: SuiAddress!) {
      object(address: $address) {
        address
        version
        digest
        asMoveObject {
          contents {
            json
            type {
              repr
            }
          }
        }
      }
    }
  `

  let res
  let lastError = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await tatumGraphql('sui', query, { address: cleanId }, undefined, env)
      if (res.ok) {
        lastError = null
        break
      }
      lastError = new Error(`Tatum GraphQL HTTP error: ${res.status} ${res.statusText}`)
    } catch (err) {
      lastError = err
    }
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  if (lastError || !res || !res.ok) {
    return {
      found: false,
      objectId: cleanId,
      error: lastError?.message || 'Failed to query on-chain Circle object via Tatum GraphQL',
    }
  }

  try {
    const body = await res.json()
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Tatum GraphQL returned errors: ${body.errors.map((e) => e.message).join('; ')}`)
    }

    const obj = body.data?.object
    if (!obj || !obj.asMoveObject) {
      return { found: false, objectId: cleanId, reason: 'Object not found on-chain or not a Move object' }
    }

    const moveObj = obj.asMoveObject
    const typeRepr = moveObj.contents?.type?.repr || ''
    if (!typeRepr.includes('::circle::Circle<')) {
      return {
        found: false,
        objectId: cleanId,
        reason: `Object type (${typeRepr}) is not a compatible Ajo Circle Move object`,
      }
    }

    // Extract CoinType from between < and >
    const coinTypeMatch = typeRepr.match(/<(.+)>/)
    const coinType = coinTypeMatch ? coinTypeMatch[1] : '0x2::sui::SUI'

    const json = moveObj.contents?.json || {}

    return {
      found: true,
      objectId: cleanId,
      version: obj.version,
      digest: obj.digest,
      type: typeRepr,
      coinType,
      name: json.name || '',
      creator: json.creator || '',
      contributionAmount: json.contribution_amount || '0',
      cycleDurationMs: Number(json.cycle_duration_ms || 0),
      currentCycle: Number(json.current_cycle || 1),
      cycleDeadlineMs: Number(json.cycle_deadline_ms || 0),
      members: Array.isArray(json.members) ? json.members : [],
      payoutOrder: Array.isArray(json.payout_order) ? json.payout_order : [],
      acceptedMembers: Array.isArray(json.accepted_members) ? json.accepted_members : [],
      vaultBalance: json.vault || '0',
      status: Number(json.status ?? 0),
    }
  } catch (err) {
    return {
      found: false,
      objectId: cleanId,
      error: err.message || 'Failed to query on-chain Circle object',
    }
  }
}
