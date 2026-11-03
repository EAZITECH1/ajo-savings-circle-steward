import { loadDotEnvIfPresent, requireIntegrationConfig } from '../server/config.mjs'
import { restoreCircleFromWalrus } from '../server/walrus-memory.mjs'

loadDotEnvIfPresent()

/**
 * Exercise real Walrus recovery and Tatum re-verification for an existing
 * circle. This never uploads or deletes Walrus blobs. MemWal restore may
 * rebuild the relayer's search index.
 */
async function main() {
  const circleId = String(process.argv[2] || '').trim()
  const authenticatedWalletAddress = String(process.argv[3] || '').trim()
  if (!circleId || !authenticatedWalletAddress) {
    console.error('Usage: npm run verify:live-recovery -- <circle-id> <member-sui-address>')
    process.exitCode = 2
    return
  }

  requireIntegrationConfig('memwal')
  requireIntegrationConfig('tatum')
  const result = await restoreCircleFromWalrus(circleId, {
    authenticatedWalletAddress,
    limit: 100,
  })

  // Avoid printing roster data or memory text in this diagnostic summary.
  const summary = {
    circleId: result.circleId,
    namespace: result.namespace,
    recoveryStatus: result.recoveryStatus,
    complete: result.complete,
    inventoryAvailable: result.inventoryAvailable,
    expectedBlobCount: result.expectedBlobCount,
    recoveredBlobCount: result.recoveredBlobCount,
    missingBlobCount: result.missingBlobIds?.length || 0,
    malformedRecordCount: result.malformedRecords?.length || 0,
    conflictCount: result.conflicts?.length || 0,
    restoredTransactionCount: result.restoredTxAssociations?.length || 0,
    tatumReverificationStatuses: (result.tatumReverifications || []).map((item) => ({
      cycle: item.cycle,
      status: item.status,
      code: item.code,
      network: item.network,
    })),
    recoveryPath: result.recoveryPath,
    walrusBlobWrites: 0,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (!result.complete) process.exitCode = 1
}

main().catch((err) => {
  console.error(`Live recovery verification failed: ${err.message}`)
  process.exitCode = 1
})
