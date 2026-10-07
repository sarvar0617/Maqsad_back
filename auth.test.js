import { describe, expect, it } from 'vitest'
import { createAuthHandlers, createToken, createUserStore, hashPassword, parseLoginBody, parseSignupBody, verifyPassword, verifyToken } from './auth.js'

const valid = { name: ' Ali ', age: 20, email: ' Ali@Mail.com ', password: 'secret1' }
const fakeRes = () => {
  const res = { status(code) { res.code = code; return res }, json(body) { res.body = body; return res } }
  return res
}

describe('parseSignupBody', () => {
  it('trims the name and lowercases the email', () => {
    expect(parseSignupBody(valid)).toEqual({ name: 'Ali', age: 20, email: 'ali@mail.com', password: 'secret1' })
  })

  it.each([
    [{ ...valid, name: 'A' }, 'invalid_name'],
    [{ ...valid, age: 'x' }, 'invalid_age'],
    [{ ...valid, age: 2.5 }, 'invalid_age'],
    [{ ...valid, email: 'nope' }, 'invalid_email'],
    [{ ...valid, password: '123' }, 'invalid_password'],
    [null, 'invalid_name'],
  ])('rejects %j', (body, code) => {
    expect(() => parseSignupBody(body)).toThrowError(expect.objectContaining({ code, status: 400 }))
  })
})

describe('parseLoginBody', () => {
  it('requires email and password', () => {
    expect(() => parseLoginBody({ email: 'a@b.co' })).toThrowError(expect.objectContaining({ code: 'invalid_credentials' }))
  })
})

describe('passwords and tokens', () => {
  it('verifies only the right password', async () => {
    const hash = await hashPassword('secret1')
    expect(await verifyPassword('secret1', hash)).toBe(true)
    expect(await verifyPassword('secret2', hash)).toBe(false)
  })

  it('accepts a fresh token and rejects forged or expired ones', () => {
    const token = createToken('u1', 's')
    expect(verifyToken(token, 's')).toBe('u1')
    expect(verifyToken(token, 'other')).toBeNull()
    expect(verifyToken(`${token}x`, 's')).toBeNull()
    expect(verifyToken(createToken('u1', 's', { now: () => 0, ttlMs: 10 }), 's')).toBeNull()
    expect(verifyToken(undefined, 's')).toBeNull()
  })
})

describe('auth handlers', () => {
  const setup = () => createAuthHandlers({ store: createUserStore(null), secret: 's' })

  it('signs up, rejects a duplicate, logs in and resolves /me', async () => {
    const auth = setup()
    const signup = fakeRes()
    await auth.signup({ body: valid }, signup)
    expect(signup.code).toBe(201)
    expect(signup.body.user).toMatchObject({ name: 'Ali', age: 20, email: 'ali@mail.com' })
    expect(signup.body.user.passwordHash).toBeUndefined()

    const again = fakeRes()
    await auth.signup({ body: valid }, again)
    expect([again.code, again.body.error]).toEqual([409, 'email_taken'])

    const login = fakeRes()
    await auth.login({ body: { email: 'ALI@mail.com', password: 'secret1' } }, login)
    expect(login.code).toBe(200)

    const me = fakeRes()
    await auth.me({ headers: { authorization: `Bearer ${login.body.token}` } }, me)
    expect(me.body.user.email).toBe('ali@mail.com')
  })

  it('answers wrong password and unknown email the same way', async () => {
    const auth = setup()
    await auth.signup({ body: valid }, fakeRes())
    for (const body of [{ email: 'ali@mail.com', password: 'wrong' }, { email: 'x@mail.com', password: 'secret1' }]) {
      const res = fakeRes()
      await auth.login({ body }, res)
      expect([res.code, res.body.error]).toEqual([401, 'invalid_credentials'])
    }
  })

  it('rejects /me without a valid token', async () => {
    const res = fakeRes()
    await setup().me({ headers: {} }, res)
    expect(res.code).toBe(401)
  })
})
