// Accounts: sign up (name, age, email, password), log in (email, password) or continue with Google.
// A new e-mail/password account must confirm its address through a signed link sent by e-mail;
// Google accounts arrive already confirmed (Google has verified the address).
// Passwords are hashed with scrypt, sessions are HMAC-signed tokens. Users live in PostgreSQL when
// DATABASE_URL is set (production), otherwise in a JSON file (local dev) or in memory (tests).
import { randomBytes, scrypt as scryptCallback, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { RequestError } from './recommend.js'

const scrypt = promisify(scryptCallback)
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000
const RESEND_COOLDOWN_MS = 60 * 1000
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

function signClaims(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

// The claims of a correctly signed, unexpired token, or null.
function readClaims(token, secret, now) {
  const [payload, signature] = String(token ?? '').split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof claims?.sub === 'string' && claims.exp > now() ? claims : null
  } catch {
    return null
  }
}

export function createToken(userId, secret, { now = Date.now, ttlMs = TOKEN_TTL_MS } = {}) {
  return signClaims({ sub: userId, exp: now() + ttlMs }, secret)
}

// Returns the user id of a session token, or null for a missing, forged, expired or non-session token.
export function verifyToken(token, secret, { now = Date.now } = {}) {
  const claims = readClaims(token, secret, now)
  return claims && !claims.purpose ? claims.sub : null
}

// E-mail confirmation link token: bound to the address, so changing the e-mail would void it.
export function createVerifyToken(userId, email, secret, { now = Date.now, ttlMs = VERIFY_TTL_MS } = {}) {
  return signClaims({ sub: userId, email, purpose: 'verify', exp: now() + ttlMs }, secret)
}

export function readVerifyToken(token, secret, { now = Date.now } = {}) {
  const claims = readClaims(token, secret, now)
  return claims?.purpose === 'verify' && typeof claims.email === 'string' ? { userId: claims.sub, email: claims.email } : null
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
    findByGoogleSub: (sub) => [...users.values()].find((user) => user.googleSub === sub) ?? null,
    add(user) {
      users.set(user.email, { emailVerified: false, googleSub: null, ...user })
      persist()
    },
    // patch: { emailVerified?, googleSub? }
    update(id, patch) {
      const user = [...users.values()].find((entry) => entry.id === id)
      if (!user) return null
      Object.assign(user, patch)
      persist()
      return user
    },
  }
}

// PostgreSQL user store (same interface as createUserStore, but every method returns a promise).
// `pool` is a pg Pool; the table is created on first use.
export function createPgUserStore(pool) {
  const toUser = (row) => row && {
    id: row.id,
    name: row.name,
    age: row.age,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerified: row.email_verified,
    googleSub: row.google_sub,
    createdAt: row.created_at.toISOString(),
  }
  let ready
  const init = () => {
    ready ??= pool.query(`CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      name text NOT NULL,
      age integer NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      ALTER TABLE users ALTER COLUMN age DROP NOT NULL;
    `)).catch((error) => {
      ready = undefined // retry on the next request instead of failing forever
      throw error
    })
    return ready
  }
  return {
    init,
    async findByEmail(email) {
      await init()
      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email])
      return toUser(rows[0]) ?? null
    },
    async findById(id) {
      await init()
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id])
      return toUser(rows[0]) ?? null
    },
    async findByGoogleSub(sub) {
      await init()
      const { rows } = await pool.query('SELECT * FROM users WHERE google_sub = $1', [sub])
      return toUser(rows[0]) ?? null
    },
    async update(id, { emailVerified, googleSub }) {
      await init()
      const { rows } = await pool.query(
        `UPDATE users SET email_verified = COALESCE($2, email_verified), google_sub = COALESCE($3, google_sub)
         WHERE id = $1 RETURNING *`,
        [id, emailVerified ?? null, googleSub ?? null],
      )
      return toUser(rows[0]) ?? null
    },
    async add(user) {
      await init()
      try {
        await pool.query(
          'INSERT INTO users (id, name, age, email, password_hash, email_verified, google_sub, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [user.id, user.name, user.age ?? null, user.email, user.passwordHash ?? null, Boolean(user.emailVerified), user.googleSub ?? null, user.createdAt],
        )
      } catch (error) {
        // Two sign-ups with the same email at the same moment: the unique index decides.
        if (error.code === '23505') throw fail('email_taken', 'An account with this email already exists.', 409)
        throw error
      }
    },
  }
}

export const publicUser = ({ id, name, age, email, emailVerified, googleSub, passwordHash }) => ({
  id,
  name,
  age: age ?? null,
  email,
  emailVerified: Boolean(emailVerified),
  google: Boolean(googleSub),
  hasPassword: Boolean(passwordHash),
})

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]

// Middleware: lets the request through only for a logged-in user whose e-mail is confirmed (req.user is set).
export function requireVerified({ store, secret }) {
  return async (req, res, next) => {
    try {
      const userId = verifyToken(bearer(req), secret)
      const user = userId && await store.findById(userId)
      if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
      if (!user.emailVerified) return res.status(403).json({ error: 'email_not_verified', message: 'Confirm your email address first.' })
      req.user = user
      next()
    } catch (error) {
      console.error('[auth] check failed:', error)
      res.status(500).json({ error: 'server_error', message: 'Something went wrong.' })
    }
  }
}

// Checks a Google Identity Services ID token. Returns { sub, email, name } or throws invalid_google_token.
// `verifier` is a google-auth-library OAuth2Client (injected so tests need no network).
export async function readGoogleCredential(credential, { verifier, clientId }) {
  if (typeof credential !== 'string' || !credential) throw fail('invalid_google_token', 'Google sign-in failed.', 401)
  let payload
  try {
    const ticket = await verifier.verifyIdToken({ idToken: credential, audience: clientId })
    payload = ticket.getPayload()
  } catch {
    throw fail('invalid_google_token', 'Google sign-in failed.', 401)
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) throw fail('invalid_google_token', 'Google did not confirm this email.', 401)
  return { sub: payload.sub, email: normalizeEmail(payload.email), name: String(payload.name || payload.email.split('@')[0]).slice(0, 60) }
}

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

// Express handlers: { signup, login, me, google, verifyEmail, resendVerification }.
// mailer: from mailer.js; appUrl: the site the confirmation link opens (e.g. https://maqsadai.uz);
// google: { verifier, clientId } or null when Google sign-in is not configured.
export function createAuthHandlers({ store, secret, mailer = null, appUrl = 'http://localhost:5173', google = null, emailTemplate = ({ link }) => ({ subject: 'Confirm your email', text: link, html: link }), now = Date.now }) {
  const lastSent = new Map() // userId -> time of the last confirmation e-mail, to stop resend spam

  async function sendVerification(user) {
    if (!mailer) return false
    const link = `${appUrl.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(createVerifyToken(user.id, user.email, secret, { now }))}`
    try {
      await mailer.send(user.email, emailTemplate({ name: user.name, link }))
      lastSent.set(user.id, now())
      return true
    } catch (error) {
      console.error('[mail] verification email failed:', error.message)
      return false
    }
  }

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
        if (await store.findByEmail(input.email)) throw fail('email_taken', 'An account with this email already exists.', 409)
        const user = { id: randomBytes(12).toString('hex'), name: input.name, age: input.age, email: input.email, passwordHash: await hashPassword(input.password), emailVerified: false, googleSub: null, createdAt: new Date().toISOString() }
        await store.add(user)
        const emailSent = await sendVerification(user)
        res.status(201).json({ token: createToken(user.id, secret), user: publicUser(user), emailSent })
      } catch (error) {
        sendError(res, error)
      }
    },

    async login(req, res) {
      try {
        const { email, password } = parseLoginBody(req.body)
        const user = await store.findByEmail(email)
        // Hash even for unknown emails so response time does not reveal which emails exist.
        const valid = await verifyPassword(password, user?.passwordHash ?? '00:00').catch(() => false)
        if (!user || !valid) throw fail('invalid_credentials', 'Wrong email or password.', 401)
        respond(res, user)
      } catch (error) {
        sendError(res, error)
      }
    },

    async me(req, res) {
      try {
        const userId = verifyToken(bearer(req), secret)
        const user = userId && await store.findById(userId)
        if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
        res.json({ user: publicUser(user) })
      } catch (error) {
        sendError(res, error)
      }
    },

    // POST { credential } from Google Identity Services. Signs in, links Google to an existing account with the
    // same e-mail (and confirms that e-mail, since Google verified it), or creates a new confirmed account.
    async google(req, res) {
      try {
        if (!google) throw fail('google_not_configured', 'Google sign-in is not set up.', 503)
        const profile = await readGoogleCredential(req.body?.credential, google)
        let user = await store.findByGoogleSub(profile.sub)
        let status = 200
        if (!user) {
          const existing = await store.findByEmail(profile.email)
          if (existing) {
            user = await store.update(existing.id, { googleSub: profile.sub, emailVerified: true })
          } else {
            user = { id: randomBytes(12).toString('hex'), name: profile.name.length >= 2 ? profile.name : profile.email, age: null, email: profile.email, passwordHash: null, emailVerified: true, googleSub: profile.sub, createdAt: new Date().toISOString() }
            await store.add(user)
            status = 201
          }
        }
        respond(res, user, status)
      } catch (error) {
        sendError(res, error)
      }
    },

    // POST { token } from the link in the e-mail. Works without being logged in (the link may open on another device).
    async verifyEmail(req, res) {
      try {
        const claims = readVerifyToken(req.body?.token, secret, { now })
        const user = claims && await store.findById(claims.userId)
        if (!user || user.email !== claims.email) throw fail('invalid_verify_token', 'This link is invalid or has expired.', 400)
        const updated = user.emailVerified ? user : await store.update(user.id, { emailVerified: true })
        res.json({ user: publicUser(updated) })
      } catch (error) {
        sendError(res, error)
      }
    },

    // POST (logged in): sends the confirmation e-mail again, at most once a minute.
    async resendVerification(req, res) {
      try {
        const userId = verifyToken(bearer(req), secret)
        const user = userId && await store.findById(userId)
        if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
        if (user.emailVerified) return res.json({ sent: false, alreadyVerified: true })
        const wait = (lastSent.get(user.id) ?? 0) + RESEND_COOLDOWN_MS - now()
        if (wait > 0) {
          res.set('Retry-After', String(Math.ceil(wait / 1000)))
          return res.status(429).json({ error: 'rate_limited', message: 'Wait a minute before asking again.', retryAfterSeconds: Math.ceil(wait / 1000) })
        }
        const sent = await sendVerification(user)
        if (!sent) return res.status(502).json({ error: 'mail_failed', message: 'The email could not be sent. Try again later.' })
        res.json({ sent: true })
      } catch (error) {
        sendError(res, error)
      }
    },
  }
}
