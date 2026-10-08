// Maqsad API: endpoints that ask Gemini to explain a scheduler-built routine and to power the AI Coach chat.
// Run with `npm start` (or `npm run dev`). Reads .env if present; hosting platforms just set real env vars.
import express from 'express'
import { chat, parseChatBody } from './chat.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createAuthHandlers, createPgUserStore, createUserStore, loadSecret } from './auth.js'
import { cors, parseOrigins, rateLimit } from './middleware.js'
import { createPgPlannerStore, createPlannerHandlers, createPlannerStore } from './planner.js'
import { AIProviderError, DEFAULT_FALLBACK_MODELS, DEFAULT_MODEL, RequestError, createClient, createModelGate, parseRequestBody, recommendWithFallback, withModelFallback } from './recommend.js'

const envFile = fileURLToPath(new URL('./.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST?.trim() || '0.0.0.0'
const MODEL = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL
// Comma-separated list in GEMINI_FALLBACK_MODELS overrides the defaults; set it to "none" to disable.
const fallbackSetting = process.env.GEMINI_FALLBACK_MODELS?.trim()
const FALLBACKS = fallbackSetting === 'none' ? [] : fallbackSetting ? fallbackSetting.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_FALLBACK_MODELS
const MODELS = [...new Set([MODEL, ...FALLBACKS])]
const ORIGINS = parseOrigins(process.env.CORS_ORIGINS)
const rateSetting = process.env.RATE_LIMIT_PER_MIN?.trim()
const RATE_LIMIT = rateSetting && Number.isFinite(Number(rateSetting)) ? Number(rateSetting) : 20
// Shared by both endpoints: a model that hit its limit is skipped for a while instead of burning more quota.
const gate = createModelGate()
// Accounts: PostgreSQL when DATABASE_URL is set (production); otherwise users.json in AUTH_DATA_DIR (default ./data).
const dataDir = process.env.AUTH_DATA_DIR?.trim() || fileURLToPath(new URL('./data', import.meta.url))
const DATABASE_URL = process.env.DATABASE_URL?.trim()
// Render's internal URL needs no SSL; external URLs (other hosts, local tools) do.
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, max: 5, ssl: /\.render\.com|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined }) : null
pool?.on('error', (error) => console.error('[db] idle client error:', error.message))
const userStore = pool ? createPgUserStore(pool) : createUserStore(join(dataDir, 'users.json'))
const authSecret = loadSecret(process.env.AUTH_SECRET?.trim(), join(dataDir, 'auth-secret.txt'))
const authHandlers = createAuthHandlers({ store: userStore, secret: authSecret })
// Planner data synced between a user's devices; same storage choice as accounts.
const plannerStore = pool ? createPgPlannerStore(pool, { ready: () => userStore.init() }) : createPlannerStore(join(dataDir, 'planner.json'))
const plannerHandlers = createPlannerHandlers({ store: plannerStore, users: userStore, secret: authSecret })
const authRateSetting = process.env.AUTH_RATE_LIMIT_PER_MIN?.trim()
const AUTH_RATE_LIMIT = authRateSetting && Number.isFinite(Number(authRateSetting)) ? Number(authRateSetting) : 10
const apiKey = process.env.GEMINI_API_KEY?.trim()
// GEMINI_BASE_URL is only for local testing against a mock; leave it unset.
const client = apiKey ? createClient(apiKey, { baseUrl: process.env.GEMINI_BASE_URL?.trim() || undefined }) : null

// AIProviderError.kind -> HTTP status for the frontend (which falls back to offline mode on any non-2xx).
const STATUS_BY_KIND = { auth: 502, rate_limited: 429, unreachable: 502, timeout: 504, upstream: 502, bad_response: 502 }

const logRetry = (failed, next, error) => console.warn(`[ai] ${failed} unavailable (${error.kind}${error.status ? ` ${error.status}` : ''}), trying ${next}`)
const logFallback = (result) => {
  if (result.model && !result.model.startsWith(MODEL)) console.log(`[ai] answered by fallback model ${result.model}`)
}
function sendAiError(res, error) {
  if (error instanceof AIProviderError) {
    console.error(`[ai] ${error.kind}: ${error.message}`)
    if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds))
    return res.status(STATUS_BY_KIND[error.kind] ?? 502).json({ error: error.kind, message: error.message, retryAfterSeconds: error.retryAfterSeconds })
  }
  console.error('[ai] failed:', error)
  return res.status(502).json({ error: 'server_error', message: error.message })
}

const app = express()
app.disable('x-powered-by')
// Number of proxy hops in front of the app (Render/Railway: 1) so the rate limit sees the real client IP.
const trustProxy = process.env.TRUST_PROXY?.trim()
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy)
app.use(cors(ORIGINS))
app.use('/api/ai', rateLimit({ limit: RATE_LIMIT }))
app.use('/api/auth', rateLimit({ limit: AUTH_RATE_LIMIT }))
app.use('/api/planner', rateLimit({ limit: 120 }))
// A full planner document (months of routines) is bigger than the other bodies.
app.use('/api/planner', express.json({ limit: '2mb' }))
app.use(express.json({ limit: '200kb' }))

app.get('/api/health', async (_req, res) => {
  let db = 'file'
  if (pool) db = await pool.query('SELECT 1').then(() => 'ok', () => 'down')
  res.json({ ok: true, ai: Boolean(client), provider: 'gemini', model: client ? MODEL : null, fallbacks: client ? MODELS.slice(1) : [], db })
})

app.post('/api/auth/signup', authHandlers.signup)
app.post('/api/auth/login', authHandlers.login)
app.get('/api/auth/me', authHandlers.me)

app.get('/api/planner', plannerHandlers.get)
app.put('/api/planner', plannerHandlers.put)

app.post('/api/ai/recommend', async (req, res) => {
  if (!client) {
    return res.status(503).json({ error: 'no_api_key', message: 'GEMINI_API_KEY is not set on the server.' })
  }

  let input
  try {
    input = parseRequestBody(req.body)
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ error: 'bad_request', message: error.message })
    throw error
  }

  try {
    const result = await recommendWithFallback(client, input, { models: MODELS, onRetry: logRetry, gate })
    logFallback(result)
    res.json(result)
  } catch (error) {
    sendAiError(res, error)
  }
})

// AI Coach chat (chat.js). The answer only proposes changes; the frontend applies them after the user confirms.
app.post('/api/ai/chat', async (req, res) => {
  if (!client) {
    return res.status(503).json({ error: 'no_api_key', message: 'GEMINI_API_KEY is not set on the server.' })
  }

  let input
  try {
    input = parseChatBody(req.body)
  } catch (error) {
    if (error instanceof RequestError) return res.status(error.status).json({ error: 'bad_request', message: error.message })
    throw error
  }

  try {
    const result = await withModelFallback(MODELS, (model) => chat(client, input, { model }), logRetry, { gate })
    logFallback(result)
    res.json(result)
  } catch (error) {
    sendAiError(res, error)
  }
})

// Malformed JSON bodies and anything else express rejects.
app.use((error, _req, res, _next) => {
  const status = error.status ?? error.statusCode ?? 500
  res.status(status).json({ error: status === 400 ? 'bad_request' : 'server_error', message: error.message })
})

const server = app.listen(PORT, HOST, () => {
  console.log(`[api] http://${HOST}:${PORT} - AI ${client ? `enabled (Gemini, ${MODELS.join(' -> ')})` : 'disabled: set GEMINI_API_KEY'}`)
  console.log(`[api] rate limit: ${RATE_LIMIT > 0 ? `${RATE_LIMIT} requests/min per IP on /api/ai` : 'off'}`)
  console.log(`[api] accounts: ${pool ? 'PostgreSQL (DATABASE_URL)' : `JSON file in ${dataDir}`}`)
  if (pool) plannerStore.init().then(() => console.log('[db] users and planner_data tables ready'), (error) => console.error('[db] init failed:', error.message))
  if (!ORIGINS) console.warn('[api] WARNING: CORS_ORIGINS is not set, allowing requests from any origin. Set it to your frontend URL in production.')
})

// Keep-alive for Render's free plan, which spins a service down after 15 minutes without inbound requests.
// The server calls its own public URL (Render sets RENDER_EXTERNAL_URL), so the request comes back in through
// Render's proxy and counts as traffic. Off unless KEEP_ALIVE_MINUTES is set (e.g. 10); keep it under 15.
const keepAliveMinutes = Number(process.env.KEEP_ALIVE_MINUTES)
const keepAliveUrl = process.env.KEEP_ALIVE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim()
const keepAlive = keepAliveMinutes > 0 && keepAliveUrl
  ? setInterval(() => {
    fetch(new URL('/api/health', keepAliveUrl), { signal: AbortSignal.timeout(30_000) })
      .then((response) => { if (!response.ok) console.warn(`[keep-alive] /api/health answered ${response.status}`) })
      .catch((error) => console.warn(`[keep-alive] ping failed: ${error.message}`))
  }, keepAliveMinutes * 60_000)
  : null
if (keepAlive) console.log(`[keep-alive] pinging ${keepAliveUrl}/api/health every ${keepAliveMinutes} min`)

// Graceful shutdown: stop accepting connections, let in-flight requests finish, force exit after 10s.
function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`)
  if (keepAlive) clearInterval(keepAlive)
  server.close(() => (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0)))
  server.closeIdleConnections()
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
