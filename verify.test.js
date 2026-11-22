import { describe, expect, it } from 'vitest'
import { createAuthHandlers, createToken, createUserStore, createVerifyToken, readVerifyToken, requireVerified, verifyToken } from './auth.js'
import { createMailer, verificationEmail } from './mailer.js'

const fakeRes = () => {
  const res = { headers: {}, status(code) { res.code = code; return res }, json(body) { res.body = body; return res }, set(key, value) { res.headers[key] = value; return res } }
  return res
}
const signupBody = { name: 'Ali', age: 20, email: 'ali@mail.com', password: 'secret1' }

function setup({ verifier = null, mailFails = false } = {}) {
  const store = createUserStore(null)
  const sent = []
  const mailer = { configured: true, async send(to, message) { if (mailFails) throw new Error('down'); sent.push({ to, message }) } }
  let clock = 1_000_000
  const auth = createAuthHandlers({
    store,
    secret: 's',
    mailer,
    appUrl: 'https://maqsadai.uz/',
    google: verifier ? { verifier, clientId: 'cid' } : null,
    emailTemplate: verificationEmail,
    now: () => clock,
  })
  return { store, auth, sent, tick: (ms) => { clock += ms } }
}

const linkToken = (mail) => decodeURIComponent(/token=([^\s"&<]+)/.exec(mail.message.text)[1])

describe('email confirmation', () => {
  it('signs up unconfirmed and e-mails a link to the site', async () => {
    const { auth, sent } = setup()
    const res = fakeRes()
    await auth.signup({ body: signupBody }, res)
    expect(res.code).toBe(201)
    expect(res.body.user).toMatchObject({ emailVerified: false, google: false, hasPassword: true })
    expect(res.body.emailSent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ali@mail.com')
    expect(sent[0].message.text).toContain('https://maqsadai.uz/verify-email?token=')
  })

  it('still creates the account when the mail provider fails', async () => {
    const { auth } = setup({ mailFails: true })
    const res = fakeRes()
    await auth.signup({ body: signupBody }, res)
    expect([res.code, res.body.emailSent]).toEqual([201, false])
  })

  it('confirms the e-mail with the link token, once and idempotently', async () => {
    const { auth, sent } = setup()
    await auth.signup({ body: signupBody }, fakeRes())
    const token = linkToken(sent[0])
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes()
      await auth.verifyEmail({ body: { token } }, res)
      expect(res.body.user.emailVerified).toBe(true)
    }
  })

  it('rejects expired, forged and session tokens as links', async () => {
    const { auth, sent, tick } = setup()
    const signup = fakeRes()
    await auth.signup({ body: signupBody }, signup)
    const token = linkToken(sent[0])
    for (const bad of [`${token}x`, signup.body.token, undefined]) {
      const res = fakeRes()
      await auth.verifyEmail({ body: { token: bad } }, res)
      expect([res.code, res.body.error]).toEqual([400, 'invalid_verify_token'])
    }
    tick(25 * 60 * 60 * 1000)
    const late = fakeRes()
    await auth.verifyEmail({ body: { token } }, late)
    expect(late.code).toBe(400)
  })

  it('never accepts a link token as a login session', () => {
    const token = createVerifyToken('u1', 'a@b.co', 's')
    expect(verifyToken(token, 's')).toBeNull()
    expect(readVerifyToken(token, 's')).toEqual({ userId: 'u1', email: 'a@b.co' })
    expect(readVerifyToken(createToken('u1', 's'), 's')).toBeNull()
  })

  it('resends at most once a minute', async () => {
    const { auth, sent, tick } = setup()
    const signup = fakeRes()
    await auth.signup({ body: signupBody }, signup)
    const headers = { authorization: `Bearer ${signup.body.token}` }
    const early = fakeRes()
    await auth.resendVerification({ headers }, early)
    expect([early.code, early.body.error]).toEqual([429, 'rate_limited'])
    tick(61_000)
    const later = fakeRes()
    await auth.resendVerification({ headers }, later)
    expect(later.body).toEqual({ sent: true })
    expect(sent).toHaveLength(2)
  })
})

describe('requireVerified', () => {
  it('blocks unconfirmed users with 403 and lets confirmed ones through', async () => {
    const { auth, store, sent } = setup()
    const signup = fakeRes()
    await auth.signup({ body: signupBody }, signup)
    const gate = requireVerified({ store, secret: 's' })
    const req = { headers: { authorization: `Bearer ${signup.body.token}` } }
    const blocked = fakeRes()
    let passed = false
    await gate(req, blocked, () => { passed = true })
    expect([blocked.code, blocked.body.error, passed]).toEqual([403, 'email_not_verified', false])

    await auth.verifyEmail({ body: { token: linkToken(sent[0]) } }, fakeRes())
    await gate(req, fakeRes(), () => { passed = true })
    expect(passed).toBe(true)
    expect(req.user.email).toBe('ali@mail.com')

    const anon = fakeRes()
    await gate({ headers: {} }, anon, () => {})
    expect(anon.code).toBe(401)
  })
})

describe('Google sign-in', () => {
  const verifierFor = (payload) => ({ async verifyIdToken({ idToken, audience }) { if (idToken !== 'good' || audience !== 'cid') throw new Error('bad'); return { getPayload: () => payload } } })
  const googlePayload = { sub: 'g-1', email: 'Ali@Mail.com', email_verified: true, name: 'Ali Valiyev' }

  it('creates a confirmed account without a password', async () => {
    const { auth } = setup({ verifier: verifierFor(googlePayload) })
    const res = fakeRes()
    await auth.google({ body: { credential: 'good' } }, res)
    expect(res.code).toBe(201)
    expect(res.body.user).toMatchObject({ email: 'ali@mail.com', name: 'Ali Valiyev', emailVerified: true, google: true, hasPassword: false, age: null })
  })

  it('links Google to an existing e-mail account and confirms it', async () => {
    const { auth } = setup({ verifier: verifierFor(googlePayload) })
    const signup = fakeRes()
    await auth.signup({ body: signupBody }, signup)
    const res = fakeRes()
    await auth.google({ body: { credential: 'good' } }, res)
    expect(res.code).toBe(200)
    expect(res.body.user).toMatchObject({ id: signup.body.user.id, emailVerified: true, google: true, hasPassword: true })
    const again = fakeRes()
    await auth.google({ body: { credential: 'good' } }, again)
    expect(again.body.user.id).toBe(signup.body.user.id)
  })

  it('rejects bad tokens and unconfirmed Google e-mails', async () => {
    const { auth } = setup({ verifier: verifierFor({ ...googlePayload, email_verified: false }) })
    for (const credential of ['bad', 'good', undefined]) {
      const res = fakeRes()
      await auth.google({ body: { credential } }, res)
      expect([res.code, res.body.error]).toEqual([401, 'invalid_google_token'])
    }
  })

  it('answers 503 when Google sign-in is not configured', async () => {
    const { auth } = setup()
    const res = fakeRes()
    await auth.google({ body: { credential: 'good' } }, res)
    expect([res.code, res.body.error]).toEqual([503, 'google_not_configured'])
  })

  it('does not let a Google-only account log in with a password', async () => {
    const { auth } = setup({ verifier: verifierFor(googlePayload) })
    await auth.google({ body: { credential: 'good' } }, fakeRes())
    const res = fakeRes()
    await auth.login({ body: { email: 'ali@mail.com', password: 'anything' } }, res)
    expect(res.code).toBe(401)
  })
})

describe('mailer', () => {
  it('posts to Resend and surfaces refusals', async () => {
    const calls = []
    const ok = createMailer({ apiKey: 'k', from: 'Maqsad <noreply@maqsadai.uz>', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true } } })
    await ok.send('a@b.co', verificationEmail({ name: '<Ali>', link: 'https://x/verify-email?token=t' }))
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(calls[0].init.body)
    expect(body).toMatchObject({ from: 'Maqsad <noreply@maqsadai.uz>', to: ['a@b.co'] })
    expect(body.html).toContain('&lt;Ali&gt;')
    const refused = createMailer({ apiKey: 'k', from: 'x', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'domain not verified' }) })
    await expect(refused.send('a@b.co', { subject: 's', html: 'h', text: 't' })).rejects.toThrow('403')
  })

  it('only logs without an API key', async () => {
    const logged = []
    const mailer = createMailer({ log: { warn: (line) => logged.push(line) } })
    await mailer.send('a@b.co', { subject: 'Hi', text: 'link', html: '' })
    expect(mailer.configured).toBe(false)
    expect(logged[0]).toContain('link')
  })
})
