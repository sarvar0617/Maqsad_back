import { describe, expect, it } from 'vitest'
import { createAuthHandlers, createUserStore } from './auth.js'
import { createPlannerHandlers, createPlannerStore, parsePlannerBody } from './planner.js'

const fakeRes = () => {
  const res = { status(code) { res.code = code; return res }, json(body) { res.body = body; return res } }
  return res
}

describe('parsePlannerBody', () => {
  it('keeps known tables and drops the rest', () => {
    expect(parsePlannerBody({ data: { goals: [{ id: 'g' }], preferences: { wakeTime: '07:00' }, hacker: 1 } }))
      .toEqual({ goals: [{ id: 'g' }], preferences: { wakeTime: '07:00' } })
  })

  it.each([[null], [{}], [{ data: [] }], [{ data: { goals: {} } }], [{ data: { routines: [] } }]])('rejects %j', (body) => {
    expect(() => parsePlannerBody(body)).toThrowError(expect.objectContaining({ status: 400 }))
  })
})

describe('planner handlers', () => {
  async function setup() {
    const users = createUserStore(null)
    const auth = createAuthHandlers({ store: users, secret: 's' })
    const planner = createPlannerHandlers({ store: createPlannerStore(null), users, secret: 's' })
    const signup = fakeRes()
    await auth.signup({ body: { name: 'Ali', age: 20, email: 'ali@mail.com', password: 'secret1' } }, signup)
    return { planner, headers: { authorization: `Bearer ${signup.body.token}` } }
  }

  it('returns null for a new account, then what another device saved', async () => {
    const { planner, headers } = await setup()
    const empty = fakeRes()
    await planner.get({ headers }, empty)
    expect(empty.body).toEqual({ data: null, updatedAt: null })

    const saved = fakeRes()
    await planner.put({ headers, body: { data: { goals: [{ id: 'g1', title: 'IELTS' }] } } }, saved)
    expect(typeof saved.body.updatedAt).toBe('string')

    const phone = fakeRes()
    await planner.get({ headers }, phone)
    expect(phone.body.data).toEqual({ goals: [{ id: 'g1', title: 'IELTS' }] })
  })

  it('rejects requests without a valid token', async () => {
    const { planner } = await setup()
    const res = fakeRes()
    await planner.get({ headers: {} }, res)
    expect(res.code).toBe(401)
  })

  it('answers 400 for a malformed body', async () => {
    const { planner, headers } = await setup()
    const res = fakeRes()
    await planner.put({ headers, body: { data: { goals: 'x' } } }, res)
    expect(res.code).toBe(400)
  })
})
