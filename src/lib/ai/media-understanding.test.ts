import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mediaIdFromUrl,
  parseFirstMessageRoute,
  parseImageReading,
  transcriptionTarget,
} from './media-understanding'
import type { AiConfig } from './types'

const anthropic = { provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-haiku-4-5' } as AiConfig
const openai = { provider: 'openai', apiKey: 'sk-oa', model: 'gpt-4o-mini' } as AiConfig

describe('mediaIdFromUrl', () => {
  it('takes the media id from the inbox proxy path, relative or absolute', () => {
    expect(mediaIdFromUrl('/api/whatsapp/media/12345')).toBe('12345')
    expect(mediaIdFromUrl('https://crm.example.com/api/whatsapp/media/98765')).toBe('98765')
    expect(mediaIdFromUrl('https://example.com/foto.jpg')).toBeNull()
    expect(mediaIdFromUrl(null)).toBeNull()
  })
})

describe('parseImageReading', () => {
  it('reads a list, tolerating text around the JSON', () => {
    expect(parseImageReading('Claro: {"kind":"list","lines":["2 panes"," 1  leche ",""]}')).toEqual({
      kind: 'list',
      lines: ['2 panes', '1 leche'],
    })
  })
  it('treats a list with no lines, or a non-order photo, as other', () => {
    expect(parseImageReading('{"kind":"list","lines":[]}')).toEqual({ kind: 'other', summary: '' })
    expect(parseImageReading('{"kind":"other","summary":"un comprobante"}')).toEqual({
      kind: 'other',
      summary: 'un comprobante',
    })
  })
  it('recognises a payment receipt', () => {
    expect(parseImageReading('{"kind":"receipt","summary":"Pichincha $25,40"}')).toEqual({
      kind: 'receipt',
      summary: 'Pichincha $25,40',
    })
  })
  it('returns null for a reply with no JSON', () => {
    expect(parseImageReading('no sé')).toBeNull()
  })
})

describe('parseFirstMessageRoute', () => {
  it('keeps order lines only for an order', () => {
    expect(parseFirstMessageRoute('{"intent":"order","lines":["2 panes","1 leche"]}')).toEqual({
      intent: 'order',
      lines: ['2 panes', '1 leche'],
    })
    expect(parseFirstMessageRoute('{"intent":"question","lines":["x"]}')).toEqual({ intent: 'question', lines: [] })
  })
  it('an order with no products is not an order', () => {
    expect(parseFirstMessageRoute('{"intent":"order","lines":[]}')).toEqual({ intent: 'other', lines: [] })
  })
  it('rejects unknown intents and garbage', () => {
    expect(parseFirstMessageRoute('{"intent":"buy"}')).toBeNull()
    expect(parseFirstMessageRoute('hola')).toBeNull()
  })
})

describe('transcriptionTarget', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('prefers the server key (Groq by default)', () => {
    vi.stubEnv('TRANSCRIBE_API_KEY', 'gsk')
    vi.stubEnv('TRANSCRIBE_BASE_URL', '')
    vi.stubEnv('TRANSCRIBE_MODEL', '')
    expect(transcriptionTarget(anthropic)).toEqual({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk',
      model: 'whisper-large-v3-turbo',
    })
  })
  it("falls back to the account's OpenAI key, and has none for Anthropic alone", () => {
    vi.stubEnv('TRANSCRIBE_API_KEY', '')
    expect(transcriptionTarget(openai)?.baseUrl).toBe('https://api.openai.com/v1')
    expect(transcriptionTarget(anthropic)).toBeNull()
    expect(transcriptionTarget(null)).toBeNull()
  })
})
