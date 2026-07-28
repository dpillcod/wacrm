// ============================================================
// Interactive message payload — shared shape + validation.
//
// The persisted, round-trippable representation of a WhatsApp
// interactive message (reply buttons or a list). This is the single
// source of truth used by:
//   - the inbox composer + automation "send interactive" builders,
//   - the send-message core + automation engine (send + persist),
//   - the message bubble + preview (render),
//   - quick replies (store an interactive snippet).
//
// The field names (`id`/`title`/`description` on buttons/rows) match
// `meta-api.ts`'s `InteractiveButton` / `InteractiveListRow` /
// `InteractiveListSection` on purpose, so a payload maps straight onto
// the Meta send args with no translation.
//
// `validateInteractivePayload` mirrors the throws already inside the
// meta-api senders, but returns a result object so callers (API routes,
// activation checks) can surface a clean error to the user *before* the
// network call rather than turning a bad payload into a 400 from Meta
// mid-conversation.
// ============================================================

import { INTERACTIVE_LIMITS, PRODUCT_LIMITS } from './meta-api'

export interface InteractiveButton {
  /** Stable id echoed back in the webhook when tapped. */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
}

export interface InteractiveButtonsPayload {
  kind: 'buttons'
  /** Body text shown above the buttons (≤ 1024 chars). */
  body: string
  /** Optional plain-text header (≤ 60 chars). */
  header?: string
  /** Optional grey footer line (≤ 60 chars). */
  footer?: string
  /** 1–3 buttons. */
  buttons: InteractiveButton[]
}

export interface InteractiveListRow {
  /** Stable id echoed back in the webhook when selected. */
  id: string
  /** Row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface InteractiveListPayload {
  kind: 'list'
  body: string
  header?: string
  footer?: string
  /** Label of the tap-to-expand button on the message bubble (≤ 20 chars). */
  button_label: string
  /** 1–10 rows TOTAL across all sections. */
  sections: InteractiveListSection[]
}

export interface InteractiveProductPayload {
  kind: 'product'
  /** Meta Commerce catalog this WABA has connected. */
  catalog_id: string
  /** The product's `retailer_id` (SKU) inside that catalog. */
  product_retailer_id: string
  /** Optional — unlike buttons/list, a single product card needs no body. */
  body?: string
  footer?: string
}

export interface InteractiveProductListSection {
  title?: string
  /** `retailer_id`s of the products in this section. */
  product_retailer_ids: string[]
}

export interface InteractiveProductListPayload {
  kind: 'product_list'
  catalog_id: string
  /** Required for product_list (unlike the single-product message). */
  header: string
  body: string
  footer?: string
  /** Up to 10 sections / 30 products total. */
  sections: InteractiveProductListSection[]
}

export type InteractiveMessagePayload =
  | InteractiveButtonsPayload
  | InteractiveListPayload
  | InteractiveProductPayload
  | InteractiveProductListPayload

export type InteractiveValidation =
  | { ok: true }
  | { ok: false; error: string }

function ok(): InteractiveValidation {
  return { ok: true }
}
function fail(error: string): InteractiveValidation {
  return { ok: false, error }
}

function validateHeaderFooter(
  header: string | undefined,
  footer: string | undefined,
): InteractiveValidation {
  if (header && header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    return fail(
      `Header exceeds the ${INTERACTIVE_LIMITS.headerTextMaxLength}-character limit.`,
    )
  }
  if (footer && footer.length > INTERACTIVE_LIMITS.footerMaxLength) {
    return fail(
      `Footer exceeds the ${INTERACTIVE_LIMITS.footerMaxLength}-character limit.`,
    )
  }
  return ok()
}

/**
 * Validate an interactive payload against Meta's hard limits + our
 * structural rules (non-empty ids/titles, unique ids). Returns a result
 * object rather than throwing so API routes can map it to a 400 with a
 * user-facing message.
 *
 * `unknown` in, narrowed here, so it's safe to call straight on a parsed
 * request body.
 */
export function validateInteractivePayload(
  payload: unknown,
): InteractiveValidation {
  if (!payload || typeof payload !== 'object') {
    return fail('Interactive message payload is required.')
  }
  // Loosely typed on purpose: the four payload kinds don't all share the
  // same optional fields (a `product` card has no `header`, for
  // instance), so a `Partial<InteractiveMessagePayload>` intersection
  // type would reject valid accesses below. Each branch casts to its
  // specific payload type instead, same as the buttons/list branches
  // already did before product/product_list existed.
  const p = payload as { kind?: string; body?: unknown; footer?: unknown }

  // Body is required for buttons/list/product_list, but optional for a
  // single product card (Meta renders the card even with no body text).
  if (p.kind !== 'product') {
    if (typeof p.body !== 'string' || p.body.trim() === '') {
      return fail('Interactive message body text is required.')
    }
    if (p.body.length > INTERACTIVE_LIMITS.bodyMaxLength) {
      return fail(
        `Body text exceeds the ${INTERACTIVE_LIMITS.bodyMaxLength}-character limit.`,
      )
    }
  } else if (
    typeof p.body === 'string' &&
    p.body.length > INTERACTIVE_LIMITS.bodyMaxLength
  ) {
    return fail(
      `Body text exceeds the ${INTERACTIVE_LIMITS.bodyMaxLength}-character limit.`,
    )
  }

  if (p.kind === 'buttons' || p.kind === 'list') {
    const withHeader = p as { header?: string; footer?: string }
    const hf = validateHeaderFooter(withHeader.header, withHeader.footer)
    if (!hf.ok) return hf
  } else if (p.kind === 'product') {
    // No header for a single product card — only the footer applies.
    if (
      typeof p.footer === 'string' &&
      p.footer.length > INTERACTIVE_LIMITS.footerMaxLength
    ) {
      return fail(
        `Footer exceeds the ${INTERACTIVE_LIMITS.footerMaxLength}-character limit.`,
      )
    }
  } else if (p.kind === 'product_list') {
    if (
      typeof p.footer === 'string' &&
      p.footer.length > INTERACTIVE_LIMITS.footerMaxLength
    ) {
      return fail(
        `Footer exceeds the ${INTERACTIVE_LIMITS.footerMaxLength}-character limit.`,
      )
    }
  }

  if (p.kind === 'buttons') {
    const buttons = (p as InteractiveButtonsPayload).buttons
    if (!Array.isArray(buttons) || buttons.length < 1) {
      return fail('Add at least one reply button.')
    }
    if (buttons.length > INTERACTIVE_LIMITS.maxButtons) {
      return fail(
        `A reply-button message allows at most ${INTERACTIVE_LIMITS.maxButtons} buttons.`,
      )
    }
    const seen = new Set<string>()
    for (const b of buttons) {
      if (!b || typeof b.id !== 'string' || b.id.trim() === '') {
        return fail('Every button needs an id.')
      }
      if (seen.has(b.id)) {
        return fail(`Duplicate button id "${b.id}".`)
      }
      seen.add(b.id)
      if (typeof b.title !== 'string' || b.title.trim() === '') {
        return fail('Every button needs a label.')
      }
      if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
        return fail(
          `Button label "${b.title}" exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
        )
      }
    }
    return ok()
  }

  if (p.kind === 'list') {
    const list = p as InteractiveListPayload
    if (
      typeof list.button_label !== 'string' ||
      list.button_label.trim() === ''
    ) {
      return fail('The list needs a button label.')
    }
    if (list.button_label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      return fail(
        `List button label exceeds the ${INTERACTIVE_LIMITS.buttonTitleMaxLength}-character limit.`,
      )
    }
    if (!Array.isArray(list.sections) || list.sections.length < 1) {
      return fail('Add at least one list section.')
    }
    if (list.sections.length > INTERACTIVE_LIMITS.maxListSections) {
      return fail(
        `A list allows at most ${INTERACTIVE_LIMITS.maxListSections} sections.`,
      )
    }
    const seen = new Set<string>()
    let total = 0
    for (const section of list.sections) {
      if (!section || !Array.isArray(section.rows)) {
        return fail('Every list section needs rows.')
      }
      for (const row of section.rows) {
        total++
        if (!row || typeof row.id !== 'string' || row.id.trim() === '') {
          return fail('Every list row needs an id.')
        }
        if (seen.has(row.id)) {
          return fail(`Duplicate list row id "${row.id}".`)
        }
        seen.add(row.id)
        if (typeof row.title !== 'string' || row.title.trim() === '') {
          return fail('Every list row needs a title.')
        }
        if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
          return fail(
            `List row title "${row.title}" exceeds the ${INTERACTIVE_LIMITS.listRowTitleMaxLength}-character limit.`,
          )
        }
        if (
          row.description &&
          row.description.length >
            INTERACTIVE_LIMITS.listRowDescriptionMaxLength
        ) {
          return fail(
            `List row description exceeds the ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength}-character limit.`,
          )
        }
      }
    }
    if (total < 1) return fail('Add at least one list row.')
    if (total > INTERACTIVE_LIMITS.maxListRowsTotal) {
      return fail(
        `A list allows at most ${INTERACTIVE_LIMITS.maxListRowsTotal} rows in total.`,
      )
    }
    return ok()
  }

  if (p.kind === 'product') {
    const product = p as InteractiveProductPayload
    if (typeof product.catalog_id !== 'string' || !product.catalog_id.trim()) {
      return fail('A product message needs a catalog id.')
    }
    if (
      typeof product.product_retailer_id !== 'string' ||
      !product.product_retailer_id.trim()
    ) {
      return fail('Select a product to send.')
    }
    return ok()
  }

  if (p.kind === 'product_list') {
    const list = p as InteractiveProductListPayload
    if (typeof list.catalog_id !== 'string' || !list.catalog_id.trim()) {
      return fail('A product list needs a catalog id.')
    }
    if (typeof list.header !== 'string' || list.header.trim() === '') {
      return fail('A product list needs a header.')
    }
    if (list.header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
      return fail(
        `Header exceeds the ${INTERACTIVE_LIMITS.headerTextMaxLength}-character limit.`,
      )
    }
    if (!Array.isArray(list.sections) || list.sections.length < 1) {
      return fail('Add at least one product section.')
    }
    if (list.sections.length > PRODUCT_LIMITS.maxProductListSections) {
      return fail(
        `A product list allows at most ${PRODUCT_LIMITS.maxProductListSections} sections.`,
      )
    }
    let total = 0
    for (const section of list.sections) {
      if (!section || !Array.isArray(section.product_retailer_ids)) {
        return fail('Every product section needs at least one product.')
      }
      if (section.product_retailer_ids.length < 1) {
        return fail('Every product section needs at least one product.')
      }
      for (const id of section.product_retailer_ids) {
        total++
        if (!id || typeof id !== 'string') {
          return fail('Every product needs an id.')
        }
      }
    }
    if (total > PRODUCT_LIMITS.maxProductListItems) {
      return fail(
        `A product list allows at most ${PRODUCT_LIMITS.maxProductListItems} products in total.`,
      )
    }
    return ok()
  }

  return fail(
    'Interactive message must be reply buttons, a list, a product, or a product list.',
  )
}

/**
 * Short single-line summary used for `conversations.last_message_text`
 * and quick-reply list rows — the body, trimmed, or a sensible fallback.
 */
export function interactivePayloadPreviewText(
  payload: InteractiveMessagePayload,
): string {
  const body = payload.body?.trim()
  if (body) return body
  switch (payload.kind) {
    case 'buttons':
      return '[buttons]'
    case 'product':
      return '[product]'
    case 'product_list':
      return '[product list]'
    default:
      return '[list]'
  }
}
