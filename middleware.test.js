import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { cors, parseOrigins, rateLimit } from './middleware.js'

let server
afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())))

async function start(...middleware) {
  const app = express()
  app.use(...middleware)
  app.get('/ping', (_req, res) => res.json({ ok: true }))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

describe('parseOrigins', () => {
  it('treats empty, unset and "*" as any origin', () => {
    expect(parseOrigins(undefined)).toBeNull()
    expect(parseOrigins(' ')).toBeNull()
    expect(parseOrigins('*')).toBeNull()
  })

  it('splits a list and drops trailing slashes', () => {
    expect([...parseOrigins('https://a.com/, https://b.com')]).toEqual(['https://a.com', 'https://b.com'])
  })
})

describe('cors', () => {
  it('allows any origin with "*" when no list is configured', async () => {
    const base = await start(cors(null))
    const res = await fetch(`${base}/ping`, { headers: { Origin: 'https://x.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('echoes only listed origins', async () => {
    const base = await start(cors(parseOrigins('https://app.com')))
    const ok = await fetch(`${base}/ping`, { headers: { Origin: 'https://app.com' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.com')
    expect(ok.headers.get('vary')).toMatch(/Origin/)
    const blocked = await fetch(`${base}/ping`, { headers: { Origin: 'https://evil.com' } })
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers OPTIONS preflight with 204', async () => {
    const base = await start(cors(parseOrigins('https://app.com')))
    const res = await fetch(`${base}/ping`, { method: 'OPTIONS', headers: { Origin: 'https://app.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.com')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type')
  })
})

describe('rateLimit', () => {
  it('returns 429 with Retry-After after the limit and resets after the window', async () => {
    let t = 1_000_000
    const base = await start(rateLimit({ limit: 2, windowMs: 60_000, now: () => t }))
    expect((await fetch(`${base}/ping`)).status).toBe(200)
    expect((await fetch(`${base}/ping`)).status).toBe(200)
    const blocked = await fetch(`${base}/ping`)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await blocked.json()).error).toBe('rate_limited')
    t += 60_001
    expect((await fetch(`${base}/ping`)).status).toBe(200)
  })

  it('is off when limit is 0', async () => {
    const base = await start(rateLimit({ limit: 0 }))
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/ping`)).status).toBe(200)
  })
})
