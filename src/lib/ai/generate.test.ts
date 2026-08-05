import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    productSuggestionsEnabled: false,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('detects + strips the product sentinel', () => {
    expect(parseGeneration('Here you go [[PRODUCT:sku-123]]')).toEqual({
      text: 'Here you go',
      handoff: false,
      usage: null,
      recommendedRetailerIds: ['sku-123'],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('tolerates whitespace inside the product sentinel', () => {
    expect(parseGeneration('[[PRODUCT: sku-123 ]]')).toEqual({
      text: '',
      handoff: false,
      usage: null,
      recommendedRetailerIds: ['sku-123'],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('returns an empty list when no product sentinel is present', () => {
    expect(parseGeneration('Just a normal reply').recommendedRetailerIds).toEqual([])
  })

  it('detects + strips the product list sentinel', () => {
    expect(
      parseGeneration('Here are some options [[PRODUCTS:sku-1,sku-2,sku-3]]'),
    ).toEqual({
      text: 'Here are some options',
      handoff: false,
      usage: null,
      recommendedRetailerIds: ['sku-1', 'sku-2', 'sku-3'],
      cartAdds: [],
      wantsCartTotal: false,
    })
  })

  it('trims whitespace around each id in the product list sentinel', () => {
    expect(parseGeneration('[[PRODUCTS: sku-1 , sku-2 ]]').recommendedRetailerIds).toEqual([
      'sku-1',
      'sku-2',
    ])
  })

  it('prefers the list sentinel when the model emits both by mistake', () => {
    expect(
      parseGeneration('[[PRODUCT:sku-1]] [[PRODUCTS:sku-1,sku-2]]').recommendedRetailerIds,
    ).toEqual(['sku-1', 'sku-2'])
  })

  it('detects + strips a single cart-add sentinel', () => {
    expect(parseGeneration('Listo, agregado [[CART_ADD:sku-1:2]]')).toEqual({
      text: 'Listo, agregado',
      handoff: false,
      usage: null,
      recommendedRetailerIds: [],
      cartAdds: [{ retailerId: 'sku-1', quantity: 2 }],
      wantsCartTotal: false,
    })
  })

  it('collects several cart-add sentinels from one reply', () => {
    const result = parseGeneration(
      'Perfecto [[CART_ADD:sku-1:2]] [[CART_ADD:sku-2:1]]',
    )
    expect(result.text).toBe('Perfecto')
    expect(result.cartAdds).toEqual([
      { retailerId: 'sku-1', quantity: 2 },
      { retailerId: 'sku-2', quantity: 1 },
    ])
  })

  it('detects + strips the cart-total sentinel', () => {
    expect(parseGeneration('Un momento, calculo su pedido [[CART_TOTAL]]')).toEqual({
      text: 'Un momento, calculo su pedido',
      handoff: false,
      usage: null,
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: true,
    })
  })

  it('returns false for wantsCartTotal and [] for cartAdds by default', () => {
    const result = parseGeneration('Just a normal reply')
    expect(result.wantsCartTotal).toBe(false)
    expect(result.cartAdds).toEqual([])
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
      recommendedRetailerIds: [],
      cartAdds: [],
      wantsCartTotal: false,
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
