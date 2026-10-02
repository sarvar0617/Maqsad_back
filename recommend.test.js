import { describe, expect, it } from 'vitest'
import { AIProviderError, DEFAULT_FALLBACK_MODELS, DEFAULT_MODEL, OUTPUT_SCHEMA, RequestError, SYSTEM_PROMPT, buildUserMessage, normalizeLanguage, systemPrompt, createClient, createModelGate, isRetryable, withModelFallback, parseRequestBody, recommend, recommendWithFallback, sanitizeRecommendation } from './recommend.js'

const routine = [
  { id: 'd-fixed-0', startTime: '09:00', endTime: '12:00', title: 'University', type: 'University', source: 'fixed', status: 'upcoming', extra: 'dropped' },
  { id: 'd-goal-1', startTime: '20:00', endTime: '21:00', title: 'Learning Programming', type: 'Goal', source: 'goal', status: 'upcoming', goalId: 'g1' },
]
const context = { date: '2026-09-28', goals: [{ title: 'Learning Programming', minutesNeededToday: 60, minutesPlannedToday: 60 }] }

function fakeClient(response) {
  const calls = []
  return {
    calls,
    generate: async (model, body) => { calls.push({ model, body }); return response },
  }
}

const geminiAnswer = (text, extra = {}) => ({
  modelVersion: 'gemini-3.8-flash',
  candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] }, ...extra }],
})

// Minimal fetch stand-in returning one canned HTTP response.
function fakeFetch(status, body) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { impl, calls }
}

describe('parseRequestBody', () => {
  it('accepts scheduler output and strips unknown item fields', () => {
    const parsed = parseRequestBody({ context, routine, warnings: [{ code: 'x', message: 'Heads up' }, 'plain'] })
    expect(parsed.routine[0]).not.toHaveProperty('extra')
    expect(parsed.warnings).toEqual(['Heads up', 'plain'])
  })

  it.each([
    [null, 'object'],
    [{ routine }, 'context'],
    [{ context, routine: [] }, 'routine'],
    [{ context, routine: [{ title: 'no id' }] }, 'id'],
  ])('rejects malformed bodies (%#)', (body, word) => {
    expect(() => parseRequestBody(body)).toThrow(RequestError)
    expect(() => parseRequestBody(body)).toThrow(new RegExp(word))
  })
})

describe('language', () => {
  it('accepts en and uz and falls back to en for anything else', () => {
    expect(parseRequestBody({ context, routine }).language).toBe('en')
    expect(parseRequestBody({ context, routine, language: 'uz' }).language).toBe('uz')
    expect(parseRequestBody({ context, routine, language: 'en' }).language).toBe('en')
    for (const value of ['ru', 'UZ', '', null, 42, { uz: true }, ['uz']]) {
      expect(parseRequestBody({ context, routine, language: value }).language).toBe('en')
      expect(normalizeLanguage(value)).toBe('en')
    }
  })

  it('names the language in the system prompt', () => {
    expect(SYSTEM_PROMPT).toMatch(/Write in English\./)
    expect(systemPrompt('uz')).toMatch(/Write in Uzbek \(Latin script\)\./)
    expect(systemPrompt('uz')).not.toMatch(/Write in English/)
    expect(systemPrompt('fr')).toBe(SYSTEM_PROMPT)
    // Only the language rule differs.
    expect(systemPrompt('uz')).toMatch(/Never compute, invent or change times/)
  })

  it('sends the Uzbek prompt to Gemini for language: uz', async () => {
    const client = fakeClient(geminiAnswer(JSON.stringify({ summary: 'Yaxshi reja.', explanations: [], suggestions: [], adjustments: [] })))
    await recommend(client, parseRequestBody({ context, routine, language: 'uz' }))
    expect(client.calls[0].body.systemInstruction.parts[0].text).toBe(systemPrompt('uz'))
  })
})

describe('prompt', () => {
  it('tells the model not to compute times and embeds the data', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never compute, invent or change times/)
    const message = buildUserMessage({ context, routine, warnings: [] })
    expect(message).toContain('<routine>')
    expect(message).toContain('"d-goal-1"')
    expect(message).toContain('(none)')
  })

  it('uses a strict JSON schema', () => {
    expect(OUTPUT_SCHEMA.additionalProperties).toBe(false)
    expect(OUTPUT_SCHEMA.required).toEqual(['summary', 'explanations', 'suggestions', 'adjustments'])
  })
})

describe('sanitizeRecommendation', () => {
  it('drops explanations for unknown or duplicate items and malformed entries', () => {
    const clean = sanitizeRecommendation({
      summary: ' Fine day. ',
      explanations: [{ itemId: 'd-goal-1', reason: 'Evening focus.' }, { itemId: 'd-goal-1', reason: 'dup' }, { itemId: 'ghost', reason: 'x' }, 'junk'],
      suggestions: ['Keep going', '', 42],
      adjustments: [{ target: 'Reading', change: 'Shortened', reason: 'Busy' }, { target: 'bad' }],
    }, routine)
    expect(clean).toEqual({
      summary: 'Fine day.',
      explanations: [{ itemId: 'd-goal-1', reason: 'Evening focus.' }],
      suggestions: ['Keep going'],
      adjustments: [{ target: 'Reading', change: 'Shortened', reason: 'Busy' }],
    })
  })
})

describe('recommend', () => {
  const answer = { summary: 'Good plan.', explanations: [{ itemId: 'd-goal-1', reason: 'Evening window.' }], suggestions: [], adjustments: [] }

  it('sends the system prompt and JSON schema to Gemini, then parses the JSON', async () => {
    const client = fakeClient(geminiAnswer(JSON.stringify(answer)))
    const result = await recommend(client, parseRequestBody({ context, routine }))

    const [{ model, body }] = client.calls
    expect(model).toBe(DEFAULT_MODEL)
    expect(body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseJsonSchema).toBe(OUTPUT_SCHEMA)
    expect(body.contents[0].parts[0].text).toContain('<routine>')
    expect(result).toEqual({ ...answer, model: 'gemini-3.8-flash' })
  })

  it('ignores thought parts and joins text parts', async () => {
    const json = JSON.stringify(answer)
    const client = fakeClient({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: json.slice(0, 10) }, { text: json.slice(10) }] } }] })
    const result = await recommend(client, parseRequestBody({ context, routine }), { model: 'custom' })
    expect(result.summary).toBe('Good plan.')
    expect(result.model).toBe('custom')
  })

  it('throws on blocked, truncated, empty or non-JSON output', async () => {
    const input = parseRequestBody({ context, routine })
    await expect(recommend(fakeClient({ promptFeedback: { blockReason: 'SAFETY' } }), input)).rejects.toThrow(/declined/)
    await expect(recommend(fakeClient(geminiAnswer('{}', { finishReason: 'SAFETY' })), input)).rejects.toThrow(/declined/)
    await expect(recommend(fakeClient(geminiAnswer('{', { finishReason: 'MAX_TOKENS' })), input)).rejects.toThrow(/cut off/)
    await expect(recommend(fakeClient({ candidates: [] }), input)).rejects.toThrow(/no answer/)
    await expect(recommend(fakeClient(geminiAnswer('not json')), input)).rejects.toThrow(AIProviderError)
  })
})

describe('createClient', () => {
  it('posts to the model endpoint with the key in a header', async () => {
    const fetch = fakeFetch(200, { candidates: [] })
    await createClient('secret-key', { fetchImpl: fetch.impl }).generate('gemini-3.8-flash', { contents: [] })
    const [{ url, init }] = fetch.calls
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(init.headers['x-goog-api-key']).toBe('secret-key')
    expect(url).not.toContain('secret-key')
  })

  it.each([
    [400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'auth'],
    [403, { error: { message: 'Permission denied' } }, 'auth'],
    [429, { error: { message: 'Resource exhausted' } }, 'rate_limited'],
    [500, { error: { message: 'Internal' } }, 'upstream'],
  ])('maps HTTP %i to kind', async (status, body, kind) => {
    const fetch = fakeFetch(status, body)
    await expect(createClient('k', { fetchImpl: fetch.impl }).generate('m', {})).rejects.toMatchObject({ kind })
  })

  it('reports network failures and timeouts', async () => {
    const down = async () => { throw new TypeError('fetch failed') }
    await expect(createClient('k', { fetchImpl: down }).generate('m', {})).rejects.toMatchObject({ kind: 'unreachable' })
    const slow = async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
    await expect(createClient('k', { fetchImpl: slow }).generate('m', {})).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('recommendWithFallback', () => {
  const answer = { summary: 'OK.', explanations: [], suggestions: [], adjustments: [] }
  const input = parseRequestBody({ context, routine })

  // generate() fails with the given error for the listed models and answers for the rest.
  function flakyClient(failures) {
    const tried = []
    return {
      tried,
      generate: async (model) => {
        tried.push(model)
        if (failures[model]) throw failures[model]
        return { ...geminiAnswer(JSON.stringify(answer)), modelVersion: model }
      },
    }
  }
  const overloaded = new AIProviderError('upstream', 'high demand', 503)

  it('falls back to the next model when the first is overloaded', async () => {
    const client = flakyClient({ [DEFAULT_MODEL]: overloaded })
    const retries = []
    const result = await recommendWithFallback(client, input, { onRetry: (failed, next) => retries.push([failed, next]) })
    expect(client.tried).toEqual([DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS[0]])
    expect(result.model).toBe(DEFAULT_FALLBACK_MODELS[0])
    expect(retries).toEqual([[DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS[0]]])
  })

  it('does not retry a rejected key', async () => {
    const client = flakyClient({ a: new AIProviderError('auth', 'bad key', 400) })
    await expect(recommendWithFallback(client, input, { models: ['a', 'b'] })).rejects.toMatchObject({ kind: 'auth' })
    expect(client.tried).toEqual(['a'])
  })

  it('throws the last error when every model fails', async () => {
    const client = flakyClient({ a: overloaded, b: new AIProviderError('rate_limited', 'slow down', 429) })
    await expect(recommendWithFallback(client, input, { models: ['a', 'b'] })).rejects.toMatchObject({ kind: 'rate_limited' })
    expect(client.tried).toEqual(['a', 'b'])
  })

  it('classifies retryable errors', () => {
    expect(isRetryable(overloaded)).toBe(true)
    expect(isRetryable(new AIProviderError('upstream', 'no such model', 404))).toBe(true)
    expect(isRetryable(new AIProviderError('upstream', 'bad request', 400))).toBe(false)
    expect(isRetryable(new AIProviderError('bad_response', 'junk'))).toBe(false)
    expect(isRetryable(new Error('other'))).toBe(false)
  })
})

describe('rate limits', () => {
  it('reads Gemini\'s retryDelay from a 429', async () => {
    const fetch = fakeFetch(429, { error: { message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37.2s' }] } })
    await expect(createClient('k', { fetchImpl: fetch.impl }).generate('m', {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 38 })
  })

  it('skips models that are cooling down and fails fast when all are', async () => {
    const gate = createModelGate()
    let clock = 1_000_000
    const now = () => clock
    const tried = []
    const limited = new AIProviderError('rate_limited', 'limit', 429, 30)
    const overloaded = new AIProviderError('upstream', 'busy', 503)
    const attempt = async (model) => {
      tried.push(model)
      if (model === 'a') throw limited
      if (model === 'b') throw overloaded
      return model
    }

    expect(await withModelFallback(['a', 'b', 'c'], attempt, undefined, { gate, now })).toBe('c')
    expect(gate.secondsLeft('a', clock)).toBe(30)
    expect(gate.secondsLeft('b', clock)).toBe(20)

    tried.length = 0
    expect(await withModelFallback(['a', 'b', 'c'], attempt, undefined, { gate, now })).toBe('c')
    expect(tried).toEqual(['c']) // a and b were not called again

    tried.length = 0
    await expect(withModelFallback(['a', 'b'], attempt, undefined, { gate, now })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 20 })
    expect(tried).toEqual([])

    clock += 31_000
    tried.length = 0
    await withModelFallback(['a', 'b', 'c'], attempt, undefined, { gate, now })
    expect(tried).toEqual(['a', 'b', 'c']) // cooldowns expired
  })
})
