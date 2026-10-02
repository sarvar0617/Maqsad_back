import { describe, expect, it } from 'vitest'
import { CHAT_SCHEMA, CHAT_SYSTEM_PROMPT, MAX_ACTIONS, MAX_MESSAGES, buildChatRequest, chat, chatSystemPrompt, parseChatBody, sanitizeChatAnswer } from './chat.js'
import { AIProviderError, RequestError } from './recommend.js'

const context = { today: { date: '2026-09-24', weekday: 'Thursday', now: '13:00' } }
const geminiAnswer = (payload) => ({ modelVersion: 'gemini-3.8-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(payload) }] } }] })
const fakeClient = (response) => {
  const calls = []
  return { calls, generate: async (model, body) => { calls.push({ model, body }); return response } }
}

describe('parseChatBody', () => {
  it('keeps the last messages, trims long ones and requires a final user turn', () => {
    const messages = Array.from({ length: MAX_MESSAGES + 4 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `m${index}` }))
    messages.push({ role: 'user', text: 'x'.repeat(5000) })
    const parsed = parseChatBody({ messages, context })
    expect(parsed.messages).toHaveLength(MAX_MESSAGES)
    expect(parsed.messages.at(-1).text).toHaveLength(2000)
  })

  it.each([
    [null, 'object'],
    [{ messages: [{ role: 'user', text: 'hi' }] }, 'context'],
    [{ context, messages: [] }, 'messages'],
    [{ context, messages: [{ role: 'system', text: 'x' }] }, 'role'],
    [{ context, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] }, 'last message'],
    [{ context, messages: [{ role: 'user', text: '   ' }] }, 'empty'],
  ])('rejects malformed bodies (%#)', (body, word) => {
    expect(() => parseChatBody(body)).toThrow(RequestError)
    expect(() => parseChatBody(body)).toThrow(new RegExp(word))
  })
})

describe('language', () => {
  const messages = [{ role: 'user', text: 'ok' }]

  it('accepts en and uz and falls back to en for anything else', () => {
    expect(parseChatBody({ messages, context }).language).toBe('en')
    expect(parseChatBody({ messages, context, language: 'uz' }).language).toBe('uz')
    for (const value of ['ru', 'Uzbek', '', null, 1]) expect(parseChatBody({ messages, context, language: value }).language).toBe('en')
  })

  it('keeps "reply in the user\'s language" and uses the app language when that is unclear', () => {
    for (const language of ['en', 'uz']) expect(chatSystemPrompt(language)).toMatch(/reply in the same language the user writes in/)
    expect(CHAT_SYSTEM_PROMPT).toMatch(/unclear .* reply in English, the language the user chose in the app/)
    expect(chatSystemPrompt('uz')).toMatch(/unclear .* reply in Uzbek \(Latin script/)
    expect(chatSystemPrompt('xx')).toBe(CHAT_SYSTEM_PROMPT)
  })

  it('puts the chosen default language into the request', () => {
    const request = buildChatRequest(parseChatBody({ messages, context, language: 'uz' }))
    expect(request.systemInstruction.parts[0].text).toContain(chatSystemPrompt('uz'))
  })
})

describe('buildChatRequest', () => {
  it('puts rules and planner data in the system instruction and maps roles', () => {
    const request = buildChatRequest({ context, messages: [{ role: 'assistant', text: 'orphan' }, { role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }, { role: 'user', text: 'Plan?' }] })
    const system = request.systemInstruction.parts[0].text
    expect(system).toContain(CHAT_SYSTEM_PROMPT)
    expect(system).toContain('"weekday": "Thursday"')
    expect(request.contents.map((entry) => entry.role)).toEqual(['user', 'model', 'user'])
    expect(request.generationConfig.responseJsonSchema).toBe(CHAT_SCHEMA)
  })

  it('tells the model to stay on topic and only propose changes', () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/politely decline/)
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never change anything yourself/i)
  })
})

describe('sanitizeChatAnswer', () => {
  it('keeps valid proposals and drops malformed ones', () => {
    const clean = sanitizeChatAnswer({
      reply: ' Sure! ',
      actions: [
        { type: 'addTask', summary: 'Add Cleaning', task: { title: 'Cleaning', date: '2026-09-24', startTime: '19:00', endTime: '20:00', priority: 'Urgent' } },
        { type: 'addTask', summary: 'Bad time', task: { title: 'X', date: '2026-09-24', startTime: '21:00', endTime: '20:00', priority: 'Low' } },
        { type: 'addTask', summary: 'Bad date', task: { title: 'X', date: 'tomorrow', startTime: '10:00', endTime: '11:00' } },
        { type: 'addGoal', summary: 'IELTS', goal: { title: 'IELTS 7.0', startDate: '2026-09-24', endDate: '2026-12-24', priority: 'High', targetHours: 150.04, unit: 'hours' } },
        { type: 'addGoal', summary: 'No hours', goal: { title: 'X', startDate: '2026-09-24', endDate: '2026-12-24', priority: 'High', targetHours: 0 } },
        { type: 'updatePreferences', summary: 'Shorter sessions', preferences: { maxSessionMinutes: 45, breakMinutes: 999, wakeTime: '6:00', preferredStudyTime: 'evening' } },
        { type: 'updatePreferences', summary: 'Nothing valid', preferences: { breakMinutes: -5 } },
        { type: 'deleteEverything', summary: 'nope' },
        { type: 'generateRoutine', summary: 'Rebuild' },
        { type: 'generateRoutine', summary: 'Rebuild again' },
      ],
    })
    expect(clean.reply).toBe('Sure!')
    expect(clean.actions).toEqual([
      { type: 'addTask', summary: 'Add Cleaning', task: { title: 'Cleaning', date: '2026-09-24', startTime: '19:00', endTime: '20:00', priority: 'Medium' } },
      { type: 'addGoal', summary: 'IELTS', goal: { title: 'IELTS 7.0', description: '', startDate: '2026-09-24', endDate: '2026-12-24', priority: 'High', targetHours: 150, unit: 'hours' } },
      { type: 'updatePreferences', summary: 'Shorter sessions', preferences: { maxSessionMinutes: 45, preferredStudyTime: 'evening' } },
      { type: 'generateRoutine', summary: 'Rebuild' },
    ])
  })

  it(`caps proposals at ${MAX_ACTIONS}`, () => {
    const task = { title: 'T', date: '2026-09-24', startTime: '10:00', endTime: '11:00', priority: 'Low' }
    const clean = sanitizeChatAnswer({ reply: 'ok', actions: Array.from({ length: 9 }, () => ({ type: 'addTask', summary: 's', task })) })
    expect(clean.actions).toHaveLength(MAX_ACTIONS)
  })

  it('rejects a missing reply', () => {
    expect(() => sanitizeChatAnswer({ actions: [] })).toThrow()
    expect(() => sanitizeChatAnswer({ reply: '  ', actions: [] })).toThrow()
  })
})

describe('chat', () => {
  it('calls Gemini and returns the cleaned answer with the model name', async () => {
    const client = fakeClient(geminiAnswer({ reply: 'Hi!', actions: [] }))
    const result = await chat(client, parseChatBody({ context, messages: [{ role: 'user', text: 'hello' }] }), { model: 'm1' })
    expect(client.calls[0].model).toBe('m1')
    expect(result).toEqual({ reply: 'Hi!', actions: [], model: 'gemini-3.8-flash' })
  })

  it('wraps bad answers in AIProviderError', async () => {
    const client = fakeClient(geminiAnswer({ nope: true }))
    await expect(chat(client, parseChatBody({ context, messages: [{ role: 'user', text: 'hello' }] }))).rejects.toBeInstanceOf(AIProviderError)
  })
})
