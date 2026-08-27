import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { retrieveCatalogProducts, resolveCatalogProducts } from '@/lib/ai/catalog'
import { computeCartTotal } from '@/lib/ai/cart'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const question = latestUserMessage(messages)
    const knowledge = await retrieveKnowledge(supabase, accountId, config, question)

    // Mirrors dispatchInboundToAiReply / the draft route: only fetch
    // candidates when suggestions are actually enabled, and show the
    // tester the same product-recommendation behavior a real customer
    // would get (previously missing here, so the Playground silently
    // never surfaced catalog matches).
    const catalogCandidates = config.productSuggestionsEnabled
      ? await retrieveCatalogProducts(supabase, accountId, question)
      : []

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      catalogCandidates: catalogCandidates.map((p) => ({
        retailerId: p.retailerId,
        name: p.name,
        price: p.price,
        currency: p.currency,
      })),
    })

    const { text, handoff, recommendedRetailerIds, cartAdds, wantsCartTotal } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    let recommendedProducts: Awaited<ReturnType<typeof resolveCatalogProducts>> = []
    if (config.productSuggestionsEnabled && recommendedRetailerIds.length > 0) {
      recommendedProducts = await resolveCatalogProducts(
        supabase,
        accountId,
        recommendedRetailerIds,
      )
    }

    // The Playground has no real conversation to persist a cart
    // against (it's stateless — see the docstring), so cart intent is
    // shown informationally rather than actually accumulated: what the
    // model WOULD add, resolved against the real catalog so a
    // hallucinated id shows up as empty rather than a fake product.
    type CartAddPreviewItem = Awaited<
      ReturnType<typeof resolveCatalogProducts>
    >[number] & { quantity: number }
    let cartAddPreview: CartAddPreviewItem[] = []
    if (config.productSuggestionsEnabled && cartAdds.length > 0) {
      const resolved = await resolveCatalogProducts(
        supabase,
        accountId,
        cartAdds.map((a) => a.retailerId),
      )
      cartAddPreview = cartAdds
        .map((a) => {
          const product = resolved.find((p) => p.retailerId === a.retailerId)
          return product ? { ...product, quantity: a.quantity } : null
        })
        .filter((p): p is CartAddPreviewItem => p !== null)
    }
    const cartAddPreviewTotal = computeCartTotal(cartAddPreview)

    return NextResponse.json({
      reply: text,
      handoff,
      recommendedProducts,
      cartAddPreview,
      wantsCartTotal,
      cartAddPreviewTotal: cartAddPreview.length > 0 ? cartAddPreviewTotal : null,
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
