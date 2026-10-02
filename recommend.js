// Builds the Gemini request for a routine explanation and validates the answer.
// The scheduler (src/utils/scheduler.js) has already decided every time slot; the model only explains and advises.
// Uses the Gemini REST API with plain fetch, so no SDK is needed.

export const DEFAULT_MODEL = 'gemini-3.8-flash'
// Tried in order when the main model is overloaded, rate limited or unavailable. All are on the free tier.
export const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite']
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
// Per model attempt; with fallbacks the total stays under the frontend's 60s limit.
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ITEMS = 100

// The app's UI languages. Anything else sent by a client falls back to English.
export const LANGUAGES = ['en', 'uz']
export const normalizeLanguage = (value) => (LANGUAGES.includes(value) ? value : 'en')

// How each language is named to the model.
export const LANGUAGE_NAMES = {
  en: 'English',
  uz: 'Uzbek (Latin script, with ‘ in o‘ and g‘)',
}

const LANGUAGE_RULES = {
  en: 'Write in English.',
  uz: 'Write in Uzbek (Latin script). Use ‘ in o‘ and g‘. Keep goal and task titles exactly as given.',
}

const BASE_PROMPT = `You are the planning coach inside Maqsad, a daily-routine planner for students.

A deterministic scheduler has already built today's routine from the user's fixed schedule, one-time tasks, goals and preferences. Your job is to explain that plan and give advice. You are not the scheduler.

Rules:
- Never compute, invent or change times. Every time you mention must appear verbatim in the routine or in the free-time lists you are given.
- Base every statement on the provided data (goal priority, days left, progress, minutes needed vs. planned, preferences, warnings). Do not guess facts that are not there.
- When a goal got less time than it needed (minutesPlannedToday < minutesNeededToday) or none at all, say which goal was shortened, by how much, and why (e.g. which blocks and tasks filled the day, which rule such as the 3-hour no-break limit or meal buffers applied).
- Suggestions and adjustments are proposals for the user to decide on (move a task, extend a deadline, lower a target, use a listed free slot). Do not present them as already done.
- Routine item status: upcoming, active, completed, skipped, missed (a task or goal session whose time went by without being done; the user can still mark it done) or passed (a fixed block, buffer or break that is already over — not a failure). Mention missed sessions and what the user can do about them (e.g. rebuild the plan so the minutes move to later free time); never treat passed items as missed.
- Explanations: at most one per routine item, only for items worth explaining (goals, tasks, buffers, breaks; fixed blocks only if relevant). Use the item's exact id.
- Be concise and friendly. {LANGUAGE_RULE} Every text field (summary, reasons, suggestions, adjustments) uses this language. Summary: 2–4 sentences. Each reason: one sentence.`

export const systemPrompt = (language = 'en') => BASE_PROMPT.replace('{LANGUAGE_RULE}', LANGUAGE_RULES[normalizeLanguage(language)])

// The English prompt (kept for callers and tests that use the default language).
export const SYSTEM_PROMPT = systemPrompt('en')

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    explanations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { itemId: { type: 'string' }, reason: { type: 'string' } },
        required: ['itemId', 'reason'],
        additionalProperties: false,
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Goal or item title the adjustment is about' },
          change: { type: 'string', description: 'What the user could change' },
          reason: { type: 'string' },
        },
        required: ['target', 'change', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'explanations', 'suggestions', 'adjustments'],
  additionalProperties: false,
}

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Accepts { context, routine, warnings?, language? } as produced by generateRoutine(); throws RequestError when malformed.
// language: 'en' | 'uz'; any other value becomes 'en'.
export function parseRequestBody(body) {
  if (!isObject(body)) throw new RequestError('Body must be a JSON object.')
  const { context, routine, warnings = [], language } = body
  if (!isObject(context)) throw new RequestError('"context" must be an object.')
  if (!Array.isArray(routine) || !routine.length) throw new RequestError('"routine" must be a non-empty array.')
  if (routine.length > MAX_ITEMS) throw new RequestError(`"routine" has more than ${MAX_ITEMS} items.`)
  for (const item of routine) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string') {
      throw new RequestError('Each routine item needs a string "id" and "title".')
    }
  }
  return {
    language: normalizeLanguage(language),
    context,
    routine: routine.map(({ id, startTime, endTime, title, type, source, status, goalId }) => ({ id, startTime, endTime, title, type, source, status, goalId })),
    warnings: (Array.isArray(warnings) ? warnings : []).map((warning) => (typeof warning === 'string' ? warning : warning?.message)).filter(Boolean),
  }
}

export function buildUserMessage({ context, routine, warnings }) {
  return [
    'Here is the scheduler output for one day. Explain it and advise the user.',
    '',
    '<context>',
    JSON.stringify(context, null, 2),
    '</context>',
    '',
    '<routine>',
    JSON.stringify(routine, null, 2),
    '</routine>',
    '',
    '<scheduler_warnings>',
    warnings.length ? warnings.map((warning) => `- ${warning}`).join('\n') : '(none)',
    '</scheduler_warnings>',
  ].join('\n')
}

// Keeps only well-formed entries and explanations that point at real routine items.
export function sanitizeRecommendation(raw, routine) {
  if (!isObject(raw) || typeof raw.summary !== 'string') throw new Error('Model returned an unexpected shape.')
  const ids = new Set(routine.map((item) => item.id))
  const seen = new Set()
  return {
    summary: raw.summary.trim(),
    explanations: (Array.isArray(raw.explanations) ? raw.explanations : [])
      .filter((entry) => isObject(entry) && ids.has(entry.itemId) && typeof entry.reason === 'string' && !seen.has(entry.itemId) && seen.add(entry.itemId))
      .map(({ itemId, reason }) => ({ itemId, reason: reason.trim() })),
    suggestions: (Array.isArray(raw.suggestions) ? raw.suggestions : []).filter((text) => typeof text === 'string' && text.trim()).map((text) => text.trim()),
    adjustments: (Array.isArray(raw.adjustments) ? raw.adjustments : [])
      .filter((entry) => isObject(entry) && ['target', 'change', 'reason'].every((key) => typeof entry[key] === 'string'))
      .map(({ target, change, reason }) => ({ target, change, reason })),
  }
}

// Errors from the AI provider, grouped so the HTTP layer can map them to status codes.
// kind: 'auth' | 'rate_limited' | 'unreachable' | 'timeout' | 'upstream' | 'bad_response'
export class AIProviderError extends Error {
  constructor(kind, message, status, retryAfterSeconds) {
    super(message)
    this.kind = kind
    this.status = status
    // From Gemini's RetryInfo (429) or our own cooldown; undefined when unknown.
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// Gemini puts the suggested wait in error.details[].retryDelay, e.g. "37s" or "1.5s".
function parseRetryDelay(details) {
  const info = (Array.isArray(details) ? details : []).find((detail) => typeof detail?.retryDelay === 'string')
  const seconds = info ? Number.parseFloat(info.retryDelay) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined
}

function classifyHttpError(status, body) {
  const message = body?.error?.message || `HTTP ${status}`
  const reason = JSON.stringify(body?.error?.details ?? '')
  if (status === 401 || status === 403 || reason.includes('API_KEY_INVALID') || /api key/i.test(message)) {
    return new AIProviderError('auth', `Gemini rejected the API key or access (${status}): ${message}`, status)
  }
  if (status === 429) {
    const retryAfter = parseRetryDelay(body?.error?.details)
    return new AIProviderError('rate_limited', `Gemini free-tier limit reached${retryAfter ? ` (retry in ${retryAfter}s)` : ''}.`, status, retryAfter)
  }
  return new AIProviderError('upstream', `Gemini error (${status}): ${message}`, status)
}

// A tiny client: generate(model, body) -> parsed JSON response. fetchImpl is injectable for tests.
export function createClient(apiKey, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = GEMINI_BASE_URL } = {}) {
  return {
    async generate(model, body) {
      let response
      try {
        response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new AIProviderError('timeout', `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s.`)
        }
        throw new AIProviderError('unreachable', `Could not reach Gemini: ${error?.message ?? error}`)
      }
      const data = await response.json().catch(() => null)
      if (!response.ok) throw classifyHttpError(response.status, data)
      if (!data) throw new AIProviderError('bad_response', 'Gemini returned a non-JSON response.')
      return data
    },
  }
}

export function buildGeminiRequest(input) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt(input.language) }] },
    contents: [{ role: 'user', parts: [{ text: buildUserMessage(input) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: OUTPUT_SCHEMA,
      // Includes the model's internal thinking tokens, so leave generous room.
      maxOutputTokens: 8192,
    },
  }
}

const BLOCKED_FINISH_REASONS = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']

// Pulls the JSON answer out of a generateContent response, or throws AIProviderError.
export function readJsonAnswer(data) {
  if (data?.promptFeedback?.blockReason) throw new AIProviderError('bad_response', 'The model declined this request.')
  const candidate = data?.candidates?.[0]
  if (!candidate) throw new AIProviderError('bad_response', 'The model returned no answer.')
  if (BLOCKED_FINISH_REASONS.includes(candidate.finishReason)) throw new AIProviderError('bad_response', 'The model declined this request.')
  if (candidate.finishReason === 'MAX_TOKENS') throw new AIProviderError('bad_response', 'The model response was cut off.')

  // Skip "thought" parts; the answer is the concatenated text parts.
  const text = (candidate.content?.parts ?? []).filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('')
  if (!text.trim()) throw new AIProviderError('bad_response', 'The model returned no text.')

  try {
    return JSON.parse(text)
  } catch {
    throw new AIProviderError('bad_response', 'The model did not return valid JSON.')
  }
}

export async function recommend(client, input, { model = DEFAULT_MODEL } = {}) {
  const data = await client.generate(model, buildGeminiRequest(input))
  const parsed = readJsonAnswer(data)
  try {
    return { ...sanitizeRecommendation(parsed, input.routine), model: data.modelVersion || model }
  } catch (error) {
    throw new AIProviderError('bad_response', error.message)
  }
}

// Errors worth trying another model for: overload (503), other 5xx, rate limits, timeouts, unknown model (404).
export function isRetryable(error) {
  if (!(error instanceof AIProviderError)) return false
  if (['rate_limited', 'timeout', 'unreachable'].includes(error.kind)) return true
  return error.kind === 'upstream' && (error.status === 404 || error.status >= 500)
}

// Remembers models that just answered 429/503 so we stop spending quota on them for a while.
export const RATE_LIMIT_COOLDOWN_SECONDS = 60
export const OVERLOAD_COOLDOWN_SECONDS = 20

export function createModelGate() {
  const until = new Map()
  return {
    secondsLeft: (model, now = Date.now()) => Math.max(0, Math.ceil(((until.get(model) ?? 0) - now) / 1000)),
    block: (model, seconds, now = Date.now()) => until.set(model, Math.max(until.get(model) ?? 0, now + seconds * 1000)),
  }
}

function cooldownFor(error) {
  if (!(error instanceof AIProviderError)) return 0
  if (error.kind === 'rate_limited') return Math.max(5, error.retryAfterSeconds ?? RATE_LIMIT_COOLDOWN_SECONDS)
  if (error.kind === 'upstream' && error.status === 503) return OVERLOAD_COOLDOWN_SECONDS
  return 0
}

// Runs attempt(model) for each model in turn until one succeeds. Bad keys and bad answers are not retried.
// With a gate, models that are cooling down are skipped; if all are, it fails fast with rate_limited.
export async function withModelFallback(models, attempt, onRetry, { gate, now = () => Date.now() } = {}) {
  const all = [...new Set(models.filter(Boolean))]
  const list = gate ? all.filter((model) => gate.secondsLeft(model, now()) === 0) : all
  if (!list.length) {
    const wait = Math.min(...all.map((model) => gate.secondsLeft(model, now())))
    throw new AIProviderError('rate_limited', `All AI models are busy or over the free limit. Try again in ${wait}s.`, 429, wait)
  }

  let lastError
  for (const [index, model] of list.entries()) {
    try {
      return await attempt(model)
    } catch (error) {
      lastError = error
      const cooldown = cooldownFor(error)
      if (gate && cooldown) gate.block(model, cooldown, now())
      const next = list[index + 1]
      if (!next || !isRetryable(error)) throw error
      onRetry?.(model, next, error)
    }
  }
  throw lastError
}

export function recommendWithFallback(client, input, { models = [DEFAULT_MODEL, ...DEFAULT_FALLBACK_MODELS], onRetry, gate } = {}) {
  return withModelFallback(models, (model) => recommend(client, input, { model }), onRetry, { gate })
}
