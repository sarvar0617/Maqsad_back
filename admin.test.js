import { describe, expect, it, vi } from 'vitest'
import { buildStats, createActivityTracker, createAdminHandlers, dayKey, parseAdminEmails } from './admin.js'
import { createToken, createUserStore } from './auth.js'

const SECRET = 'test-secret'
const NOW = Date.parse('2026-11-26T10:00:00Z') // 15:00 in Tashkent
const fakeRes = () => {
  const res = { headers: {}, set(key, value) { res.headers[key] = value; return res }, status(code) { res.code = code; return res }, json(body) { res.body = body; return res } }
  return res
}
const user = (id, email, extra = {}) => ({ id, name: id, email, passwordHash: 'x', emailVerified: true, googleSub: null, createdAt: '2026-11-20T08:00:00Z', ...extra })

describe('parseAdminEmails', () => {
  it('reads a comma-separated list and falls back to the owner', () => {
    expect(parseAdminEmails(' A@x.uz, b@x.uz ')).toEqual(['a@x.uz', 'b@x.uz'])
    expect(parseAdminEmails('')).toEqual(['sarvardev17@gmail.com'])
  })
})

describe('dayKey', () => {
  it('uses the Tashkent calendar day', () => {
    expect(dayKey(new Date('2026-11-25T20:30:00Z'))).toBe('2026-11-26')
  })
})

describe('buildStats', () => {
  const data = {
    users: [
      { id: 'a', name: 'A', email: 'a@x.uz', emailVerified: true, google: true, hasPassword: false, createdAt: '2026-11-26T05:00:00Z', lastSeenAt: '2026-11-26T09:00:00Z' },
      { id: 'b', name: 'B', email: 'b@x.uz', emailVerified: false, google: false, hasPassword: true, createdAt: '2026-11-22T05:00:00Z', lastSeenAt: null },
      { id: 'c', name: 'C', email: 'c@x.uz', emailVerified: true, google: false, hasPassword: true, createdAt: '2026-10-01T05:00:00Z', lastSeenAt: '2026-11-10T09:00:00Z' },
    ],
    activity: [
      { userId: 'a', day: '2026-11-26' },
      { userId: 'a', day: '2026-11-25' },
      { userId: 'b', day: '2026-11-22' },
      { userId: 'c', day: '2026-11-10' },
    ],
  }
  const stats = buildStats(data, { now: NOW })

  it('counts accounts by kind', () => {
    expect(stats.totals).toEqual({ users: 3, verified: 2, google: 1, password: 2 })
  })

  it('counts sign-ups and distinct active users per window', () => {
    expect(stats.signups).toEqual({ today: 1, week: 2, month: 2 })
    expect(stats.active).toEqual({ today: 1, week: 2, month: 3 })
  })

  it('gives 30 days of daily numbers ending today', () => {
    expect(stats.daily).toHaveLength(30)
    expect(stats.daily.at(-1)).toEqual({ day: '2026-11-26', signups: 1, active: 1 })
    expect(stats.daily.find((entry) => entry.day === '2026-11-22')).toEqual({ day: '2026-11-22', signups: 1, active: 1 })
  })

  it('lists the newest accounts first without secrets', () => {
    expect(stats.recent.map((entry) => entry.email)).toEqual(['a@x.uz', 'b@x.uz', 'c@x.uz'])
    expect(Object.keys(stats.recent[0])).not.toContain('passwordHash')
  })
})

describe('createActivityTracker', () => {
  it('writes once per user within a few minutes on the same day', async () => {
    let time = NOW
    const store = { touch: vi.fn(async () => {}) }
    const touch = createActivityTracker(store, { now: () => time })
    touch('a')
    touch('a')
    time += 60_000
    touch('a')
    time += 10 * 60_000
    touch('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.touch).toHaveBeenCalledTimes(2)
    expect(store.touch).toHaveBeenCalledWith('a', '2026-11-26')
  })
})

describe('GET /api/admin/stats', () => {
  const store = createUserStore(null)
  store.add(user('owner', 'sarvardev17@gmail.com'))
  store.add(user('other', 'someone@x.uz'))
  store.add(user('fake', 'admin@x.uz', { emailVerified: false }))
  store.touch('other', '2026-11-26')
  const handlers = createAdminHandlers({ store, secret: SECRET, adminEmails: ['sarvardev17@gmail.com', 'admin@x.uz'], now: () => NOW })
  const call = async (userId) => {
    const res = fakeRes()
    await handlers.stats({ headers: userId ? { authorization: `Bearer ${createToken(userId, SECRET, { now: () => NOW })}` } : {} }, res)
    return res
  }

  it('answers the admin', async () => {
    const res = await call('owner')
    expect(res.code).toBeUndefined()
    expect(res.body.totals.users).toBe(3)
    expect(res.body.active.today).toBe(1)
  })

  it('refuses other users, unconfirmed admin e-mails and anonymous requests', async () => {
    expect((await call('other')).code).toBe(403)
    expect((await call('fake')).code).toBe(403)
    expect((await call(null)).code).toBe(401)
  })
})
