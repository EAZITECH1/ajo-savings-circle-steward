import { MemoryStore, MemoryRecord, MemoryCategory } from './types'

/**
 * In-memory implementation of MemoryStore with initial seed data.
 * Can be swapped for Walrus / decentralized storage backing.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = []

  constructor(initialRecords: MemoryRecord[] = []) {
    this.records = [...initialRecords]
  }

  async remember(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
    const newRecord: MemoryRecord = {
      ...record,
      id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    }
    this.records = [newRecord, ...this.records]
    return newRecord
  }

  async recall(
    query: string,
    options?: { category?: MemoryCategory; memberId?: string; cycle?: number }
  ): Promise<MemoryRecord[]> {
    const q = query.toLowerCase()
    return this.records.filter(r => {
      if (options?.category && r.category !== options.category) return false
      if (options?.memberId && r.memberId !== options.memberId) return false
      if (options?.cycle !== undefined && r.cycle !== options.cycle) return false

      if (!query.trim()) return true

      return (
        r.title.toLowerCase().includes(q) ||
        r.quote.toLowerCase().includes(q) ||
        r.context.toLowerCase().includes(q) ||
        (r.memberId && r.memberId.toLowerCase().includes(q))
      )
    })
  }

  async list(): Promise<MemoryRecord[]> {
    return [...this.records]
  }
}
