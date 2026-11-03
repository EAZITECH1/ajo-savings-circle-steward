import { loadDotEnvIfPresent, requireIntegrationConfig } from '../server/config.mjs'
import {
  createMemWalClient,
  recallCircleMemories,
  isQuarantinedSyntheticRecord,
} from '../server/walrus-memory.mjs'

loadDotEnvIfPresent()

/**
 * Strictly read-only Walrus Mainnet inventory script.
 * Never creates, updates, or deletes any Walrus Mainnet records.
 */
async function main() {
  requireIntegrationConfig('memwal')
  const targetCircle = (process.argv[2] || 'lagos-techies-seed-circle').trim()
  const { client, namespace } = createMemWalClient(targetCircle)

  try {
    const health = await client.health()
    const namespaces = await client.listNamespaces()
    const page1 = await client.listMemories({ limit: 50, namespace })
    const auditRecall = await recallCircleMemories(targetCircle, 'circle agreement pattern preference', {
      limit: 20,
      sort: 'recent',
      includeQuarantinedForAudit: true,
    })

    console.log(
      JSON.stringify(
        {
          readOnlyAudit: true,
          relayerStatus: health.status,
          relayerVersion: health.version,
          namespaces: namespaces.namespaces,
          inspectedNamespace: namespace,
          quarantinedInRuntime: isQuarantinedSyntheticRecord(targetCircle),
          indexedMetadataCount: page1.memories?.length ?? 0,
          records: auditRecall.records.map((r, idx) => ({
            index: idx + 1,
            id: r.id,
            walrusBlobId: r.walrusBlobId,
            category: r.category,
            memoryType: r.memoryType,
            title: r.title,
            quote: r.quote,
            context: r.context,
            cycle: r.cycle,
            memberId: r.memberId || null,
            confirmationType: r.confirmationType,
            confirmedBy: r.confirmedBy,
            createdAt: r.createdAt,
            quarantinedSynthetic: isQuarantinedSyntheticRecord(r),
          })),
        },
        null,
        2
      )
    )
  } finally {
    client.destroy()
  }
}

main().catch((err) => {
  console.error('Read-only Walrus inventory failed:', err.message)
  process.exit(1)
})
