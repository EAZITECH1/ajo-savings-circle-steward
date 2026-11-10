import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { getSupportedTokens } from '../tokens.mjs'
import { fetchOnchainCircleState } from '../ajo-reader.mjs'
import { tatumGraphql } from '../tatum-client.mjs'
import {
  persistCircleConfigToWalrus,
  restoreCircleFromWalrus,
  listCircleRosters,
} from '../walrus-memory.mjs'
import { requireWalletSession } from '../wallet-auth.mjs'

const router = Router()

/**
 * GET /api/ajo/package-bytecode
 * Returns the compiled bytecode modules for the ajo::circle Move package so
 * any connected wallet can publish the package directly to Sui Testnet in 1 transaction.
 */
router.get('/package-bytecode', (_req, res) => {
  try {
    const rootDir = process.cwd()
    const modulePath = path.join(rootDir, 'contracts/ajo/build/ajo/bytecode_modules/circle.mv')
    if (!fs.existsSync(modulePath)) {
      return res.status(404).json({ error: 'Compiled Move bytecode module circle.mv not found. Run sui move build first.' })
    }
    const bytes = fs.readFileSync(modulePath)
    res.json({
      modules: [bytes.toString('base64')],
      dependencies: [
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ],
    })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read package bytecode' })
  }
})

/**
 * POST /api/ajo/set-package-id
 * Sets the published AJO_PACKAGE_ID in memory and writes it to .env so the app recognizes the deployed package.
 */
router.post('/set-package-id', (req, res) => {
  try {
    const { packageId } = req.body || {}
    if (!packageId || typeof packageId !== 'string' || !packageId.startsWith('0x') || packageId.length < 10) {
      return res.status(400).json({ error: 'Valid hex packageId starting with 0x is required.' })
    }
    const cleanPkgId = packageId.trim().toLowerCase()
    process.env.AJO_PACKAGE_ID = cleanPkgId

    // Persist to .env file
    try {
      const envPath = path.join(process.cwd(), '.env')
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
      if (content.includes('AJO_PACKAGE_ID=')) {
        content = content.replace(/AJO_PACKAGE_ID=.*/g, `AJO_PACKAGE_ID=${cleanPkgId}`)
      } else {
        content = `${content.trim()}\nAJO_PACKAGE_ID=${cleanPkgId}\n`
      }
      fs.writeFileSync(envPath, content, 'utf8')
    } catch (e) {
      console.warn('Could not write AJO_PACKAGE_ID to .env file:', e.message)
    }

    res.json({ success: true, packageId: cleanPkgId })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to set package ID' })
  }
})

/**
 * GET /api/ajo/inspect-created-circle
 * Queries a create_circle or publish transaction on Sui Testnet to extract the newly created Circle<T> object ID or published package ID.
 */
router.get('/inspect-created-circle', async (req, res) => {
  try {
    const digest = String(req.query.digest || '').trim()
    if (!digest) {
      return res.status(400).json({ error: 'Transaction digest query parameter is required.' })
    }

    const query = `
      query GetTxObjectChanges($digest: String!) {
        transaction(digest: $digest) {
          effects {
            status
            objectChanges {
              nodes {
                address
                outputState {
                  asMovePackage {
                    address
                  }
                  asMoveObject {
                    contents {
                      type {
                        repr
                      }
                      json
                    }
                  }
                }
              }
            }
          }
        }
      }
    `
    const gqlRes = await tatumGraphql('sui', query, { digest }, 'testnet')
    const body = await gqlRes.json()
    const tx = body?.data?.transaction
    if (!tx || !tx.effects) {
      return res.status(404).json({ error: `Transaction ${digest} not found on Sui Testnet yet.` })
    }

    const nodes = tx.effects.objectChanges?.nodes || []
    let circleObjectId = null
    let circleType = null
    let packageId = null

    for (const node of nodes) {
      if (node.outputState?.asMovePackage?.address) {
        packageId = node.outputState.asMovePackage.address
      }
      const typeRepr = node.outputState?.asMoveObject?.contents?.type?.repr || ''
      if (typeRepr.includes('::circle::Circle<')) {
        circleObjectId = node.address
        circleType = typeRepr
      }
      if (typeRepr.includes('::package::UpgradeCap')) {
        const pkgFromJson = node.outputState?.asMoveObject?.contents?.json?.package
        if (pkgFromJson) {
          packageId = pkgFromJson
        }
      }
    }

    res.json({
      status: tx.effects.status,
      circleObjectId,
      circleType,
      packageId,
    })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to inspect transaction objects' })
  }
})

/**
 * GET /api/ajo/config
 * Returns authoritative network info, package ID, and verified supported tokens.
 */
router.get('/config', (_req, res) => {
  const current = loadConfig()
  const network = current.integrations.tatum.config?.SUI_NETWORK || 'testnet'
  const packageId = process.env.AJO_PACKAGE_ID || ''
  const tokens = getSupportedTokens(network)

  res.json({
    network,
    packageId,
    tokens,
    packageConfigured: Boolean(packageId && packageId.startsWith('0x')),
    deploymentGuide: {
      status: packageId ? 'configured' : 'not_deployed',
      buildPath: 'contracts/ajo',
      instructions: [
        '1. Switch Sui CLI to testnet: sui client switch --env testnet',
        '2. Fund deployer wallet with testnet SUI: sui client faucet',
        '3. Publish package: sui client publish --gas-budget 100000000 contracts/ajo',
        '4. Copy published package ID to .env: AJO_PACKAGE_ID=0x...',
      ],
    },
  })
})

/**
 * GET /api/ajo/circle/:objectId
 * Fetches the live on-chain Circle<T> shared object state via Tatum GraphQL / Sui fullnode.
 */
router.get('/circle/:objectId', async (req, res) => {
  try {
    const objectId = req.params.objectId
    const state = await fetchOnchainCircleState(objectId)
    if (!state.found) {
      return res.status(404).json(state)
    }
    res.json(state)
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read on-chain circle' })
  }
})

/**
 * POST /api/ajo/register-circle
 * Persists newly created or discovered on-chain Circle to Walrus memory.
 */
router.post('/register-circle', async (req, res) => {
  try {
    const session = requireWalletSession(req)
    const body = req.body || {}
    const { circleConfig } = body

    if (!circleConfig || !circleConfig.circleId || !circleConfig.poolAddress) {
      return res.status(400).json({ error: 'circleConfig with circleId and poolAddress is required' })
    }

    if (circleConfig.tokenType && String(circleConfig.tokenType).toLowerCase().includes('wal')) {
      return res.status(400).json({
        error: 'WAL is no longer supported as a contribution token. New circles must be created using SUI or USDC.',
      })
    }

    const saved = await persistCircleConfigToWalrus({
      circleId: circleConfig.circleId,
      memberAddress: session.walletAddress,
    })

    res.json({ success: true, saved })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to register circle in Walrus' })
  }
})

/**
 * GET /api/ajo/overview
 * Returns circles overview with state and next deadlines.
 */
router.get('/overview', async (_req, res) => {
  try {
    const circles = listCircleRosters()
    res.json({ circles })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch circles overview' })
  }
})

export default router
