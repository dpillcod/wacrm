import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { retrieveCatalogProducts, resolveCatalogProduct, resolveCatalogProducts } from './catalog'
import { addCartItem, getCartItems, formatCartSummary } from './cart'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { pickCrossSellSuggestion } from './cross-sell'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText, engineSendProduct, engineSendProductList } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * Hand a conversation off to a human: pause the bot (sticky until
 * re-enabled), route to the configured handoff agent (null leaves it
 * in the shared queue), and leave a short internal note. Assigning
 * fires the `on_conversation_assigned` trigger, which notifies the
 * agent. Shared by both handoff triggers — the model asking for one,
 * and the reply cap being exhausted — so a customer never gets
 * silently ignored either way.
 */
async function handOffToHuman(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  handoffAgentId: string | null,
  currentAssignedAgentId: string | null,
  summary: string,
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  if (handoffAgentId && !currentAssignedAgentId) {
    update.assigned_agent_id = handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', conversationId)
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  console.log(`[ai auto-reply] dispatch invoked for conversation ${conversationId}`)

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) {
      console.log('[ai auto-reply] skipped: not configured or disabled', {
        hasConfig: !!config,
        autoReplyEnabled: config?.autoReplyEnabled,
      })
      return
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      console.log('[ai auto-reply] skipped: an active new_message_received/keyword_match automation exists')
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      console.log('[ai auto-reply] skipped: conversation lookup failed', convErr)
      return
    }
    if (conv.assigned_agent_id) {
      console.log('[ai auto-reply] skipped: conversation has a human assigned_agent_id')
      return // a human owns this thread
    }
    if (conv.ai_autoreply_disabled) {
      console.log('[ai auto-reply] skipped: ai_autoreply_disabled is true')
      return // handed off / turned off here
    }
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). Reaching the cap
    // now hands off to a human instead of going silent — a customer who
    // keeps writing past the limit must not be left unanswered.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.log('[ai auto-reply] reply cap reached — handing off to a human', conv.ai_reply_count)
      const capMessages = await buildConversationContext(db, conversationId)
      await handOffToHuman(
        db,
        conversationId,
        config.handoffAgentId,
        conv.assigned_agent_id,
        buildHandoffSummary({
          messages: capMessages,
          replyCount: conv.ai_reply_count ?? 0,
        }),
      )
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) {
      console.log('[ai auto-reply] skipped: buildConversationContext returned no messages')
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const question = latestUserMessage(messages)
    const knowledge = await retrieveKnowledge(db, accountId, config, question)

    // Catalog candidates are opt-in and only worth fetching when the
    // account might actually recommend a product — same "don't pay for
    // work nobody asked for" gate as the knowledge-base head-count check.
    const catalogCandidates = config.productSuggestionsEnabled
      ? await retrieveCatalogProducts(db, accountId, question)
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

    console.log('[ai auto-reply] calling provider', { provider: config.provider, model: config.model })
    const { text: generatedText, handoff, usage, recommendedRetailerIds, cartAdds, wantsCartTotal } = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    let text = generatedText
    console.log('[ai auto-reply] provider responded', { handoff, textLength: text?.length ?? 0 })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human.
      await handOffToHuman(
        db,
        conversationId,
        config.handoffAgentId,
        conv.assigned_agent_id,
        buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 }),
      )
      return
    }

    // Curated cross-sell aside — only on a normal (non-handoff) reply,
    // never competing with a "your order is complete" or handoff
    // message. Deterministic keyword match, not the model's call — see
    // cross-sell.ts for why.
    const crossSell = pickCrossSellSuggestion(question ?? '', messages)
    if (crossSell) {
      text = `${text}\n\n${crossSell}`
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) {
      console.log('[ai auto-reply] skipped: lost claim_ai_reply_slot race', { claimed })
      return
    }

    console.log('[ai auto-reply] sending text reply to Meta')
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // Product card/list sends alongside the text reply, not instead of
    // it, and does NOT consume its own reply-cap slot — the cap already
    // ran above and only bounds how many times the bot answers, not
    // how many messages one answer produces. Wrapped in its own
    // try/catch so a Meta/catalog failure here can never undo or mask
    // the text reply that already landed.
    if (config.productSuggestionsEnabled && recommendedRetailerIds.length > 0) {
      try {
        const { data: waConfig } = await db
          .from('whatsapp_config')
          .select('catalog_id')
          .eq('account_id', accountId)
          .maybeSingle()

        if (waConfig?.catalog_id) {
          if (recommendedRetailerIds.length === 1) {
            const product = await resolveCatalogProduct(
              db,
              accountId,
              recommendedRetailerIds[0],
            )
            if (product) {
              await engineSendProduct({
                accountId,
                userId: configOwnerUserId,
                conversationId,
                contactId,
                catalogId: waConfig.catalog_id,
                productRetailerId: product.retailerId,
                aiGenerated: true,
              })
            }
          } else {
            const products = await resolveCatalogProducts(
              db,
              accountId,
              recommendedRetailerIds,
            )
            if (products.length > 0) {
              await engineSendProductList({
                accountId,
                userId: configOwnerUserId,
                conversationId,
                contactId,
                catalogId: waConfig.catalog_id,
                headerText: 'Opciones disponibles',
                bodyText: 'Elige la que te interese:',
                sections: [
                  { productRetailerIds: products.map((p) => p.retailerId) },
                ],
                aiGenerated: true,
              })
            }
          }
        }
      } catch (err) {
        console.error('[ai auto-reply] product card/list send failed:', err)
      }
    }

    // Cart bookkeeping — also alongside the text reply, also not
    // counted against the reply cap. Adds land first so a total
    // requested in the same message already reflects them.
    if (config.productSuggestionsEnabled && (cartAdds.length > 0 || wantsCartTotal)) {
      try {
        for (const add of cartAdds) {
          await addCartItem(db, accountId, conversationId, add.retailerId, add.quantity)
        }
        if (wantsCartTotal) {
          const items = await getCartItems(db, conversationId)
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: formatCartSummary(items),
            aiGenerated: true,
          })
        }
      } catch (err) {
        console.error('[ai auto-reply] cart bookkeeping failed:', err)
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
