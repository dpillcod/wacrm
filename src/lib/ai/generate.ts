import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import {
  HANDOFF_SENTINEL,
  PRODUCT_SENTINEL_REGEX,
  PRODUCT_LIST_SENTINEL_REGEX,
  CART_ADD_SENTINEL_REGEX,
  CART_TOTAL_SENTINEL,
  aiRequestTimeoutMs,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage,
 * recommendedRetailerIds, cartAdds, wantsCartTotal }`. The handoff
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. Exactly one of the two product sentinels is expected (single
 * `[[PRODUCT:id]]` or list `[[PRODUCTS:id1,id2]]`) — the list form
 * wins if the model mistakenly emits both. `[[CART_ADD:id:qty]]` may
 * appear multiple times (one per ordered item). All ids/quantities are
 * returned as-is, UNVALIDATED; the caller must confirm each id exists
 * in `catalog_products` (and never trust a price from here) before
 * acting on it. `usage` is passed straight through (null when the
 * provider didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)

  const listMatch = raw.match(PRODUCT_LIST_SENTINEL_REGEX)
  const singleMatch = raw.match(PRODUCT_SENTINEL_REGEX)
  const recommendedRetailerIds = listMatch
    ? listMatch[1]
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : singleMatch
      ? [singleMatch[1]]
      : []

  const cartAdds = [...raw.matchAll(CART_ADD_SENTINEL_REGEX)].map((m) => ({
    retailerId: m[1].trim(),
    quantity: Number.parseInt(m[2], 10),
  }))
  const wantsCartTotal = raw.includes(CART_TOTAL_SENTINEL)

  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .replace(PRODUCT_LIST_SENTINEL_REGEX, '')
    .replace(PRODUCT_SENTINEL_REGEX, '')
    .replace(CART_ADD_SENTINEL_REGEX, '')
    .split(CART_TOTAL_SENTINEL)
    .join('')
    .trim()
  return { text, handoff, usage, recommendedRetailerIds, cartAdds, wantsCartTotal }
}
