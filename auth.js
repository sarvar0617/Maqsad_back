// Accounts: sign up (name, age, email, password) and log in (email, password). No extra packages:
// passwords are hashed with scrypt, sessions are HMAC-signed tokens, users live in a JSON file.
import { randomBytes, scrypt as scryptCallback, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { RequestError } from './recommend.js'

const scrypt = promisify(scryptCallback)
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase()

// Throws RequestError with a stable `code` the frontend translates.
function fail(code, message, status = 400) {
  const error = new RequestError(message, status)
  error.code = code
  return error
}

export function parseSignupBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const age = Number(body?.age)
  const email = normalizeEmail(body?.email)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (name.length < 2 || name.length > 60) throw fail('invalid_name', 'Name must be 2-60 characters.')
  if (!Number.isInteger(age) || age < 5 || age > 120) throw fail('invalid_age', 'Age must be a whole number between 5 and 120.')
  if (!EMAIL_PATTERN.test(email) || email.length > 120) throw fail('invalid_email', 'Enter a valid email address.')
  if (password.length < 6 || password.length > 100) throw fail('invalid_password', 'Password must be 6-100 characters.')
  return { name, age, email, password }
}

export function parseLoginBody(body) {
  const email = normalizeEmail(body?.email)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!email || !password) throw fail('invalid_credentials', 'Email and password are required.', 401)
  return { email, password }
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored).split(':')
  if (!saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url')

export function createToken(userId, secret, { now = Date.now, ttlMs = TOKEN_TTL_MS } = {}) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: now() + ttlMs })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

// Returns the user id, or null for a missing, forged or expired token.
export function verifyToken(token, secret, { now = Date.now } = {}) {
  const [payload, signature] = String(token ?? '').split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof sub === 'string' && exp > now() ? sub : null
  } catch {
    return null
  }
}

// JSON-file user store. Pass file = null for an in-memory store (tests). On hosts with a throwaway disk
// (free tiers) the file is lost on redeploy: point AUTH_DATA_DIR at a persistent volume or swap in a database.
export function createUserStore(file) {
  const users = new Map()
  if (file && existsSync(file)) {
    for (const user of JSON.parse(readFileSync(file, 'utf8'))) users.set(user.email, user)
  }
  const persist = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify([...users.values()], null, 2))
    renameSync(`${file}.tmp`, file)
  }
  return {
    findByEmail: (email) => users.get(email) ?? null,
    findById: (id) => [...users.values()].find((user) => user.id === id) ?? null,
    add(user) {
      users.set(user.email, user)
      persist()
    },
  }
}

export const publicUser = ({ id, name, age, email }) => ({ id, name, age, email })

// Signing secret: AUTH_SECRET if set, otherwise a random one kept next to the users file.
export function loadSecret(envSecret, file) {
  if (envSecret) return envSecret
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  if (file) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, secret)
  }
  return secret
}

// Express handlers: { signup, login, me }.
export function createAuthHandlers({ store, secret }) {
  const respond = (res, user, status = 200) => res.status(status).json({ token: createToken(user.id, secret), user: publicUser(user) })
  const sendError = (res, error) => {
    if (error instanceof RequestError) return res.status(error.status).json({ error: error.code ?? 'bad_request', message: error.message })
    console.error('[auth] failed:', error)
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong.' })
  }

  return {
    async signup(req, res) {
      try {
        const input = parseSignupBody(req.body)
        if (store.findByEmail(input.email)) throw fail('email_taken', 'An account with this email already exists.', 409)
        const user = { id: randomBytes(12).toString('hex'), name: input.name, age: input.age, email: input.email, passwordHash: await hashPassword(input.password), createdAt: new Date().toISOString() }
        store.add(user)
        respond(res, user, 201)
      } catch (error) {
        sendError(res, error)
      }
    },

    async login(req, res) {
      try {
        const { email, password } = parseLoginBody(req.body)
        const user = store.findByEmail(email)
        // Hash even for unknown emails so response time does not reveal which emails exist.
        const valid = await verifyPassword(password, user?.passwordHash ?? '00:00').catch(() => false)
        if (!user || !valid) throw fail('invalid_credentials', 'Wrong email or password.', 401)
        respond(res, user)
      } catch (error) {
        sendError(res, error)
      }
    },

    me(req, res) {
      const userId = verifyToken(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], secret)
      const user = userId && store.findById(userId)
      if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
      res.json({ user: publicUser(user) })
    },
  }
}
