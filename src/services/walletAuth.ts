// Client-side helper for server-issued Sui wallet authentication challenges & session headers

let activeSessionToken: string | null = null
let activeWalletAddress: string | null = null

export interface WalletAuthChallenge {
  challengeId: string
  nonce: string
  address: string
  message: string
  issuedAt: string
  expiresAt: string
}

export interface WalletSessionInfo {
  authenticated: boolean
  walletAddress: string | null
  token?: string
  authenticatedAt?: string
  expiresAt?: string
}

export function setActiveWalletSession(token: string | null, walletAddress: string | null) {
  activeSessionToken = token
  activeWalletAddress = walletAddress
}

export function getActiveWalletSession(): { token: string | null; walletAddress: string | null } {
  return {
    token: activeSessionToken,
    walletAddress: activeWalletAddress,
  }
}

export function getAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  }
  if (activeSessionToken) {
    headers.Authorization = `Bearer ${activeSessionToken}`
  }
  return headers
}

export async function requestWalletAuthChallenge(address: string): Promise<WalletAuthChallenge> {
  const res = await fetch('/api/auth/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.trim() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: Failed to issue wallet auth challenge`)
  }
  return data
}

export async function submitWalletAuthSignature(params: {
  challengeId: string
  address: string
  signature: string
  publicKeyHex?: string
}): Promise<{
  token: string
  walletAddress: string
  authenticatedAt: string
  expiresAt: string
}> {
  const res = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: Wallet signature verification failed`)
  }
  setActiveWalletSession(data.token, data.walletAddress)
  return data
}

export async function checkWalletAuthSession(): Promise<WalletSessionInfo> {
  if (!activeSessionToken) {
    return { authenticated: false, walletAddress: null }
  }
  const res = await fetch('/api/auth/session', {
    headers: getAuthHeaders(),
  })
  const data = await res.json().catch(() => ({ authenticated: false, walletAddress: null }))
  if (!data.authenticated) {
    setActiveWalletSession(null, null)
  }
  return data
}

export async function logoutWalletSession(): Promise<void> {
  if (activeSessionToken) {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: getAuthHeaders(),
    }).catch(() => {})
  }
  setActiveWalletSession(null, null)
}

/**
 * Attempt to sign a challenge message using an injected Sui Wallet extension
 * (`window.suiWallet` or Wallet Standard `sui:signPersonalMessage`) if available in the browser.
 * Returns null if no injected browser Sui wallet is present so the user can paste a signature.
 */
export async function trySignWithInjectedSuiWallet(
  message: string
): Promise<{ signature: string } | null> {
  const win = window as any
  const msgBytes = new TextEncoder().encode(message)

  if (win?.suiWallet?.signPersonalMessage) {
    const signed = await win.suiWallet.signPersonalMessage({ message: msgBytes })
    if (signed?.signature) {
      return { signature: signed.signature }
    }
  }
  return null
}
