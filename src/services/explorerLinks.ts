/**
 * Utilities for resolving and formatting on-chain Sui explorer and Walrus links.
 * Enforces network validation, identifier validation, and prevents malformed or quarantined references from linking out.
 */

export const QUARANTINED_SYNTHETIC_BLOB_IDS = new Set([
  '_jSFAxHds6FqS3kFOwsKN1M2iVSHbnVt_BX1_YGeQfc',
  'rPLnm650Px2cF9_l1UcK7zZZ7EjMLQlrTGEAZVILv0U',
  'kmgKVSUM4PiTy1bJYHSAr3iVrspUvbvYVd_jhu3UWAU',
  'FYt7CvCY5YeKpVO7e1LDGwWNI-Bnb01PbJo2qm1_tKU',
  'cq4PFpzCxmWyXhQN7JkRRG6inU0KxvuzOBTaGDwySS8',
  'QAoLGVx0ytBi5SczS6k8xBxO2_WkWk4WnpPmwpDa8bM',
  '6BZtcqAEiGgHPtW1rqAgu11kuItlYI2_ohgCaC4MDcw',
  'DJGI6m-_PMB_tR2zNfywaurBkPEum8Phkde6fNFJE4Y',
  'ZqKcldiC6o3gxTR7GhuXeQ4UP1v9Vs85AskJbKpZiBM',
  'AlrI6_KXE6dyYRvQ0oqLuYvJFk70xnzN5L_MeRX598A',
])

export function resolveSuiNetwork(network?: string | null): 'testnet' | 'mainnet' | null {
  if (!network) return null
  const lower = network.toLowerCase().trim()
  if (lower.includes('testnet')) return 'testnet'
  if (lower.includes('mainnet')) return 'mainnet'
  return null
}

export function isValidSuiAddress(address?: string | null): boolean {
  if (!address || typeof address !== 'string') return false
  const trimmed = address.trim()
  return /^0x[a-fA-F0-9]{1,64}$/.test(trimmed)
}

export function isValidSuiDigest(digest?: string | null): boolean {
  if (!digest || typeof digest !== 'string') return false
  const trimmed = digest.trim()
  if (trimmed.startsWith('0x')) return false
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(trimmed)
}

export function isValidSuiCoinType(coinType?: string | null): boolean {
  if (!coinType || typeof coinType !== 'string') return false
  const trimmed = coinType.trim()
  return /^0x[a-fA-F0-9]+::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+(<.*>)?$/.test(trimmed)
}

export function isValidWalrusBlobId(blobId?: string | null): boolean {
  if (!blobId || typeof blobId !== 'string') return false
  const trimmed = blobId.trim()
  if (QUARANTINED_SYNTHETIC_BLOB_IDS.has(trimmed)) return false
  if (trimmed.startsWith('synthetic') || trimmed.startsWith('quarantine') || trimmed.startsWith('mock-')) {
    return false
  }
  return /^[A-Za-z0-9_-]{32,64}$/.test(trimmed)
}

export function getSuiTxUrl(digest: string, network: string = 'testnet'): string | null {
  const resolved = resolveSuiNetwork(network)
  if (!resolved || !isValidSuiDigest(digest)) return null
  return `https://suiscan.xyz/${resolved}/tx/${encodeURIComponent(digest.trim())}`
}

export function getSuiAccountUrl(address: string, network: string = 'testnet'): string | null {
  const resolved = resolveSuiNetwork(network)
  if (!resolved || !isValidSuiAddress(address)) return null
  return `https://suiscan.xyz/${resolved}/account/${encodeURIComponent(address.trim())}`
}

export function getSuiObjectUrl(objectId: string, network: string = 'testnet'): string | null {
  const resolved = resolveSuiNetwork(network)
  if (!resolved || !isValidSuiAddress(objectId)) return null
  return `https://suiscan.xyz/${resolved}/object/${encodeURIComponent(objectId.trim())}`
}

export function getSuiCoinUrl(coinType: string, network: string = 'testnet'): string | null {
  const resolved = resolveSuiNetwork(network)
  if (!resolved || !isValidSuiCoinType(coinType)) return null
  return `https://suiscan.xyz/${resolved}/coin/${encodeURIComponent(coinType.trim())}`
}

export function getWalrusBlobUrl(blobId: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  if (!isValidWalrusBlobId(blobId)) return null
  return `https://walruscan.com/${network}/blob/${encodeURIComponent(blobId.trim())}`
}

export function shortenIdentifier(val: string, prefixLen = 6, suffixLen = 4): string {
  if (!val) return ''
  const trimmed = val.trim()
  if (trimmed.length <= prefixLen + suffixLen + 2) return trimmed
  return `${trimmed.slice(0, prefixLen)}...${trimmed.slice(-suffixLen)}`
}
