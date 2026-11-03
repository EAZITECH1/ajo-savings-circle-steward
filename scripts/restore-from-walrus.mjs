import { loadDotEnvIfPresent, requireIntegrationConfig } from '../server/config.mjs'
import { restoreCircleMemoriesFromWalrus } from '../server/walrus-memory.mjs'

loadDotEnvIfPresent()

async function main() {
  requireIntegrationConfig('memwal')
  const circleId = (process.argv[2] || '').trim()
  if (!circleId) {
    console.error('Usage: node scripts/restore-from-walrus.mjs <circle-id> [limit]')
    process.exit(1)
  }
  const limit = Number(process.argv[3]) || 15

  console.log(`Restoring Walrus Memory vector index for circle "${circleId}" (limit=${limit})...`)
  const outcome = await restoreCircleMemoriesFromWalrus(circleId, limit)

  console.log('\n=== Restore Summary ===')
  console.log(JSON.stringify(outcome.restoreResult, null, 2))
  console.log(`\nNote: ${outcome.limitationsNote}`)
  console.log(`\n=== Recalled Memories (${outcome.records.length}) ===`)
  for (const r of outcome.records) {
    console.log(
      `- [${r.category}] "${r.title}" (Cycle ${r.cycle}) | Blob: ${r.walrusBlobId} | ${r.confirmedBy}`
    )
  }
}

main().catch((err) => {
  console.error('Failed to restore from Walrus:', err.message)
  process.exit(1)
})
