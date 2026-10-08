// Per-user planner data (schedule, goals, tasks, preferences, routines, progress) so every device that logs
// in to the same account sees the same plan. Stored as one JSON document per user; the frontend keeps a local
// copy and sends the whole document after changes (last write wins).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { verifyToken } from './auth.js'

export const PLANNER_TABLES = ['weeklySchedule', 'goals', 'oneTimeTasks', 'preferences', 'routines', 'progress']
const ARRAY_TABLES = ['weeklySchedule', 'goals', 'oneTimeTasks', 'progress']
const OBJECT_TABLES = ['preferences', 'routines']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Keeps only the known tables and checks their shape; throws { status: 400 } on anything else.
export function parsePlannerBody(body) {
  const data = body?.data
  if (!isObject(data)) throw Object.assign(new Error('Body must be { data: { ...tables } }.'), { status: 400 })
  const clean = {}
  for (const table of ARRAY_TABLES) {
    if (data[table] === undefined) continue
    if (!Array.isArray(data[table])) throw Object.assign(new Error(`${table} must be an array.`), { status: 400 })
    clean[table] = data[table]
  }
  for (const table of OBJECT_TABLES) {
    if (data[table] === undefined) continue
    if (!isObject(data[table])) throw Object.assign(new Error(`${table} must be an object.`), { status: 400 })
    clean[table] = data[table]
  }
  return clean
}

// JSON-file store for local development (file = null keeps it in memory, for tests).
export function createPlannerStore(file) {
  const docs = new Map(file && existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : [])
  const persist = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(docs)))
    renameSync(`${file}.tmp`, file)
  }
  return {
    get: async (userId) => docs.get(userId) ?? null,
    async put(userId, data) {
      const doc = { data, updatedAt: new Date().toISOString() }
      docs.set(userId, doc)
      persist()
      return doc
    },
  }
}

// PostgreSQL store; the table is created on first use (after the users table, which it references).
export function createPgPlannerStore(pool, { ready = async () => {} } = {}) {
  let tableReady
  const init = () => {
    tableReady ??= ready().then(() => pool.query(`CREATE TABLE IF NOT EXISTS planner_data (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)).catch((error) => {
      tableReady = undefined
      throw error
    })
    return tableReady
  }
  return {
    init,
    async get(userId) {
      await init()
      const { rows } = await pool.query('SELECT data, updated_at FROM planner_data WHERE user_id = $1', [userId])
      return rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at.toISOString() } : null
    },
    async put(userId, data) {
      await init()
      const { rows } = await pool.query(
        `INSERT INTO planner_data (user_id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
         RETURNING updated_at`,
        [userId, JSON.stringify(data)],
      )
      return { data, updatedAt: rows[0].updated_at.toISOString() }
    },
  }
}

// Express handlers: GET /api/planner -> { data, updatedAt } (data null for a new account), PUT -> { updatedAt }.
export function createPlannerHandlers({ store, users, secret }) {
  async function currentUser(req, res) {
    const userId = verifyToken(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], secret)
    const user = userId && await users.findById(userId)
    if (!user) res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
    return user || null
  }
  const fail = (res, error) => {
    if (error.status === 400) return res.status(400).json({ error: 'bad_request', message: error.message })
    console.error('[planner] failed:', error)
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong.' })
  }

  return {
    async get(req, res) {
      try {
        const user = await currentUser(req, res)
        if (!user) return
        const doc = await store.get(user.id)
        res.json({ data: doc?.data ?? null, updatedAt: doc?.updatedAt ?? null })
      } catch (error) {
        fail(res, error)
      }
    },
    async put(req, res) {
      try {
        const user = await currentUser(req, res)
        if (!user) return
        const doc = await store.put(user.id, parsePlannerBody(req.body))
        res.json({ updatedAt: doc.updatedAt })
      } catch (error) {
        fail(res, error)
      }
    },
  }
}
