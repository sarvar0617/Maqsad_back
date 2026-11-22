# Maqsad API

Express 5 backend for Maqsad. It asks Gemini to explain a routine and powers the AI Coach chat. Requires Node >= 22.12.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, ai, provider, model, fallbacks, db }`; `ai:false` when no API key, `db`: `ok` / `down` / `file` |
| POST | `/api/auth/signup` | `{ name, age, email, password }` → `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | `Authorization: Bearer <token>` → `{ user }` |
| POST | `/api/auth/google` | `{ credential }` (Google Identity Services ID token) → `{ token, user }`; links to an existing account with the same email |
| POST | `/api/auth/verify-email` | `{ token }` from the emailed link → `{ user }` with `emailVerified: true` |
| POST | `/api/auth/resend-verification` | Bearer token → `{ sent }`; at most once a minute |
| GET | `/api/planner` | Bearer token → `{ data, updatedAt }` (`data: null` for a new account) |
| PUT | `/api/planner` | Bearer token, `{ data: { weeklySchedule, goals, oneTimeTasks, preferences, routines, progress } }` → `{ updatedAt }` (max 2 MB) |
| POST | `/api/ai/recommend` | 503 `no_api_key` without a key |
| POST | `/api/ai/chat` | 503 `no_api_key` without a key |

`/api/ai/*` is rate limited per IP (429 + `Retry-After`).

Accounts must confirm their email before `/api/ai/*` and `/api/planner` work (403 `email_not_verified`). Google accounts are confirmed on sign-in.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | - | Required for AI. Without it health says `ai:false` and `/api/ai/*` return 503. |
| `PORT` | `8787` | Hosting platforms set this. |
| `HOST` | `0.0.0.0` | Bind address. |
| `CORS_ORIGINS` | any (`*`) | Comma-separated frontend origins. Unset logs a warning; set it in production. |
| `RATE_LIMIT_PER_MIN` | `20` | Requests per minute per IP on `/api/ai/*`; `0` disables. |
| `TRUST_PROXY` | unset | Proxy hops in front of the app (Render/Railway: `1`) so the limit sees real client IPs. |
| `GEMINI_MODEL` | built-in | Main model. |
| `GEMINI_FALLBACK_MODELS` | built-in | Comma-separated, or `none`. |
| `DATABASE_URL` | unset | PostgreSQL for accounts (required in production). Unset = `data/users.json`, which is lost on redeploy. |
| `RESEND_API_KEY` | unset | Sends the email-confirmation link through Resend. Unset = the link is only logged. |
| `MAIL_FROM` | `Maqsad <noreply@maqsadai.uz>` | Sender; its domain must be verified in Resend. |
| `APP_URL` | `http://localhost:5173` | Site the confirmation link opens. |
| `GOOGLE_CLIENT_ID` | unset | Google sign-in (OAuth Web client ID). |
| `KEEP_ALIVE_MINUTES` | unset | Render free plan: the server pings its own `RENDER_EXTERNAL_URL` every N minutes (keep < 15) so it never spins down. A 24/7 service uses ~744 of the 750 free hours a month, so keep only one free service awake. |
| `AUTH_SECRET` | generated | Signs login tokens. Set a long random string in production. |

See `.env.example`. Never commit `.env`.

## Local run

```sh
npm ci
cp .env.example .env   # put your GEMINI_API_KEY in .env
npm run dev            # or: npm start
npm test
```

```sh
curl http://localhost:8787/api/health
curl -X POST http://localhost:8787/api/ai/chat -H "Content-Type: application/json" -d '{"messages":[{"role":"user","text":"Salom"}],"context":{}}'
curl -i -X OPTIONS http://localhost:8787/api/ai/chat -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"
```

The chat/recommend bodies must match what the frontend sends (see `chat.js` / `recommend.js`).

## Deploy

### Render / Railway (Node)
1. Push this folder as its own repo.
2. New Web Service from the repo. Build: `npm ci --omit=dev`. Start: `npm start`.
3. Set env: `GEMINI_API_KEY`, `CORS_ORIGINS=https://<your-frontend-domain>`, `TRUST_PROXY=1`, `AUTH_SECRET`, and `DATABASE_URL` (the Render Postgres *Internal Database URL*). Do not set `PORT`.
4. Health check path: `/api/health`.

### Docker / VPS
```sh
docker build -t maqsad-api .
docker run -d --name maqsad-api --restart unless-stopped -p 8787:8787 \
  -e GEMINI_API_KEY=... -e CORS_ORIGINS=https://your-frontend.example -e TRUST_PROXY=1 \
  maqsad-api
curl http://localhost:8787/api/health
```
Put HTTPS (Caddy/nginx) in front; keep `TRUST_PROXY=1` when you do. Drop it if the container is exposed directly.

The server shuts down gracefully on SIGTERM/SIGINT.
