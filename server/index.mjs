// Must stay first — ESM runs every import before the body, so a setGlobalDispatcher()
// call further down lands after ./routes/* have made their module-scope calls.
import './proxy-bootstrap.mjs'
// Second, before any ./routes/* read the key at module load: this applies
// /creds/creds.json onto process.env, so `process.env.TATUM_API_KEY` is set on
// the controller path (which delivers the key as a file, not an env var) and
// stays live across the rotation push. A no-op where the key is already in env.
import './credentials-store.mjs'
import express from 'express'
import { createServer as createHttpServer } from 'http'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'
import authRoutes from './routes/auth.mjs'
import tatumRoutes from './routes/tatum.mjs'
import memoryRoutes from './routes/memory.mjs'
import stewardRoutes from './routes/steward.mjs'
import { credentialGuard } from './credential-guard.mjs'
import { loadDotEnvIfPresent, loadConfig } from './config.mjs'
import { initDatabase, getDatabaseStatus } from './db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// Run from the project root. The preview-sidecar starts this server with CWD=/,
// but tooling that resolves paths from the CWD — notably Tailwind's `content`
// globs — must see the project files, or it silently generates no utilities
// (unstyled preview). `vite build` already runs from here; this makes dev match.
process.chdir(root)
loadDotEnvIfPresent(path.join(root, '.env'))

// Validate tunable configuration at startup and initialize durable SQLite storage.
const bootConfig = loadConfig()
initDatabase(bootConfig.tunables.sqliteDbPath)

const app = express()
app.use(express.json())

// Redact all configured secrets from every response before it leaves the process.
app.use(credentialGuard)

// Non-secret integration status endpoint for the frontend.
app.get('/api/config/status', (_req, res) => {
  const current = loadConfig()
  res.json({
    tunables: current.tunables,
    storage: getDatabaseStatus(),
    integrations: {
      tatum: {
        configured: current.integrations.tatum.configured,
        status: current.integrations.tatum.status,
        missingVars: current.integrations.tatum.missingVars,
        issues: current.integrations.tatum.issues,
        network: current.integrations.tatum.config?.SUI_NETWORK ?? null,
        tokenType: current.integrations.tatum.config?.SUI_TOKEN_TYPE ?? null,
        tokenDecimals: current.integrations.tatum.config?.SUI_TOKEN_DECIMALS ?? null,
      },
      memwal: {
        configured: current.integrations.memwal.configured,
        status: current.integrations.memwal.status,
        missingVars: current.integrations.memwal.missingVars,
        issues: current.integrations.memwal.issues,
        namespacePrefix: current.integrations.memwal.config?.MEMWAL_NAMESPACE_PREFIX ?? null,
      },
      llm: {
        configured: current.integrations.llm.configured,
        status: current.integrations.llm.status,
        missingVars: current.integrations.llm.missingVars,
        issues: current.integrations.llm.issues,
        model: current.integrations.llm.config?.LLM_MODEL ?? null,
      },
    },
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/tatum', tatumRoutes)
app.use('/api/memory', memoryRoutes)
app.use('/api/steward', stewardRoutes)

const server = createHttpServer(app)

// All Vite config is inline — no vite.config.js needed, no temp files written.
// cacheDir points to /tmp so dep pre-bundling works on read-only node_modules mounts.
const vite = await createViteServer({
  root,
  configFile: false,
  cacheDir: '/tmp/vite',
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { server },
    // Allow any Host — the preview is served on a per-project subdomain this file
    // cannot know. Must be the boolean `true` or an array; the string 'all' is
    // iterated per-character and silently blocks everything (no warning, no error).
    // NB: Vite's 403 body says to add the host to vite.config.js — that does not apply
    // here, `configFile: false` means any vite.config.js is silently ignored.
    allowedHosts: true,
  },
  appType: 'spa',
})
app.use(vite.middlewares)

const port = bootConfig.tunables.port
server.listen(port, () => {
  console.log(`preview-sidecar listening on :${port}`)
})
