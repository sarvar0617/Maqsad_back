// Small hand-written middleware (no extra packages): CORS and an in-memory per-IP rate limit.

// Parses CORS_ORIGINS ("https://a.com, https://b.com"). Empty/unset or "*" means any origin.
export function parseOrigins(value) {
  const list = (value ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean)
  return list.length === 0 || list.includes('*') ? null : new Set(list)
}

export function cors(origins) {
  return (req, res, next) => {
    const origin = req.headers.origin
    if (origin && (!origins || origins.has(origin))) {
      res.set('Access-Control-Allow-Origin', origins ? origin : '*')
      if (origins) res.vary('Origin')
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
      res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type')
      res.set('Access-Control-Max-Age', '86400')
      return res.sendStatus(204)
    }
    next()
  }
}

// Fixed window per client IP. limit <= 0 disables it. Behind a proxy set TRUST_PROXY so req.ip is the real client.
export function rateLimit({ limit, windowMs = 60_000, now = Date.now } = {}) {
  if (!(limit > 0)) return (_req, _res, next) => next()
  const hits = new Map()
  const sweep = setInterval(() => {
    const t = now()
    for (const [ip, entry] of hits) if (entry.resetAt <= t) hits.delete(ip)
  }, windowMs)
  sweep.unref()

  return (req, res, next) => {
    const t = now()
    const ip = req.ip || 'unknown'
    let entry = hits.get(ip)
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs }
      hits.set(ip, entry)
    }
    entry.count += 1
    if (entry.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000))
      res.set('Retry-After', String(retryAfterSeconds))
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down.', retryAfterSeconds })
    }
    next()
  }
}
