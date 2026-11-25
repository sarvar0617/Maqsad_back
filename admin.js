// Usage numbers for the project owner: how many accounts exist and how many people actually use the app.
// - Activity: every authenticated request marks the user as seen today (at most once per few minutes per user,
//   so the database is not written on every call). Days are counted in the owner's time zone.
// - GET /api/admin/stats answers only for a confirmed account whose e-mail is in ADMIN_EMAILS.
import { verifyToken } from './auth.js'

export const DEFAULT_ADMIN_EMAILS = ['sarvardev17@gmail.com']
export const STATS_TIME_ZONE = 'Asia/Tashkent'
const TOUCH_INTERVAL_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CHART_DAYS = 30
const RECENT_USERS = 25

export function parseAdminEmails(setting) {
  const list = String(setting ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)
  return list.length ? list : DEFAULT_ADMIN_EMAILS
}

// YYYY-MM-DD of `date` in `timeZone`.
export function dayKey(date, timeZone = STATS_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

// Returns touch(userId): records today's visit through store.touch(userId, day), throttled per user.
// Never throws and never delays the request it is called from.
export function createActivityTracker(store, { now = Date.now, timeZone = STATS_TIME_ZONE } = {}) {
  const lastTouch = new Map()
  return function touch(userId) {
    if (!userId || typeof store.touch !== 'function') return
    const time = now()
    const day = dayKey(new Date(time), timeZone)
    const previous = lastTouch.get(userId)
    if (previous && previous.day === day && time - previous.time < TOUCH_INTERVAL_MS) return
    lastTouch.set(userId, { day, time })
    Promise.resolve()
      .then(() => store.touch(userId, day))
      .catch((error) => {
        lastTouch.delete(userId)
        console.error('[admin] could not record activity:', error.message)
      })
  }
}

const toTime = (value) => (value ? new Date(value).getTime() : null)

// users: [{ id, name, email, emailVerified, google, hasPassword, createdAt, lastSeenAt }]
// activity: [{ userId, day }] for (at least) the last CHART_DAYS days.
export function buildStats({ users, activity }, { now = Date.now(), timeZone = STATS_TIME_ZONE } = {}) {
  const days = Array.from({ length: CHART_DAYS }, (_, index) => dayKey(new Date(now - (CHART_DAYS - 1 - index) * DAY_MS), timeZone))
  const today = days[days.length - 1]
  const since = (count) => new Set(days.slice(-count))

  const signupsByDay = new Map()
  for (const user of users) {
    const key = dayKey(new Date(user.createdAt), timeZone)
    signupsByDay.set(key, (signupsByDay.get(key) ?? 0) + 1)
  }
  const activeByDay = new Map()
  for (const { userId, day } of activity) {
    if (!activeByDay.has(day)) activeByDay.set(day, new Set())
    activeByDay.get(day).add(userId)
  }
  const activeIn = (count) => {
    const window = since(count)
    const ids = new Set()
    for (const { userId, day } of activity) if (window.has(day)) ids.add(userId)
    return ids.size
  }
  const signedUpIn = (count) => {
    const window = since(count)
    return users.filter((user) => window.has(dayKey(new Date(user.createdAt), timeZone))).length
  }

  const recent = [...users]
    .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
    .slice(0, RECENT_USERS)
    .map(({ name, email, emailVerified, google, createdAt, lastSeenAt }) => ({ name, email, emailVerified: Boolean(emailVerified), google: Boolean(google), createdAt, lastSeenAt: lastSeenAt ?? null }))

  return {
    generatedAt: new Date(now).toISOString(),
    timeZone,
    today,
    totals: {
      users: users.length,
      verified: users.filter((user) => user.emailVerified).length,
      google: users.filter((user) => user.google).length,
      password: users.filter((user) => user.hasPassword).length,
    },
    signups: { today: signedUpIn(1), week: signedUpIn(7), month: signedUpIn(30) },
    active: { today: activeIn(1), week: activeIn(7), month: activeIn(30) },
    daily: days.map((day) => ({ day, signups: signupsByDay.get(day) ?? 0, active: activeByDay.get(day)?.size ?? 0 })),
    recent,
  }
}

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]

// GET /api/admin/stats. 401 without a valid session, 403 for everyone but a confirmed admin account.
export function createAdminHandlers({ store, secret, adminEmails = DEFAULT_ADMIN_EMAILS, timeZone = STATS_TIME_ZONE, now = Date.now }) {
  const admins = new Set(adminEmails.map((email) => email.toLowerCase()))
  return {
    async stats(req, res) {
      try {
        const userId = verifyToken(bearer(req), secret)
        const user = userId && await store.findById(userId)
        if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Please log in again.' })
        if (!user.emailVerified || !admins.has(String(user.email).toLowerCase())) return res.status(403).json({ error: 'forbidden', message: 'Admins only.' })
        const data = await store.statsData({ sinceDay: dayKey(new Date(now() - (CHART_DAYS - 1) * DAY_MS), timeZone) })
        res.set('Cache-Control', 'no-store')
        res.json(buildStats(data, { now: now(), timeZone }))
      } catch (error) {
        console.error('[admin] stats failed:', error)
        res.status(500).json({ error: 'server_error', message: 'Something went wrong.' })
      }
    },
  }
}
