/**
 * WhatsApp Business app coexistence: one number used both in the
 * WhatsApp Business app on a phone and through the Cloud API (this CRM).
 *
 * Onboarding goes through Embedded Signup (featureType
 * `whatsapp_business_app_onboarding`). After it, Meta sends three extra
 * webhook fields this module understands:
 *
 *   smb_message_echoes   — messages someone sent FROM the phone app
 *   history              — up to 6 months of past chats (in chunks)
 *   smb_app_state_sync   — the phone's contacts (add / remove)
 *
 * The CRM must ask for the contacts + history sync within 24 h of
 * onboarding or Meta disconnects the number (`requestSmbSync`).
 *
 * Parsers here are pure so the webhook route stays thin and they can be
 * unit-tested with Meta's sample payloads.
 */

import { META_API_BASE } from './meta-api'

/** One message seen in an echo or history chunk, normalized. */
export interface CoexMessage {
  /** Meta message id (wamid) — used to skip duplicates. */
  id: string
  /** The customer's number (digits only). */
  customerPhone: string
  /** outbound = written by the business (phone app); inbound = the customer. */
  direction: 'inbound' | 'outbound'
  /** ISO timestamp. */
  createdAt: string
  /** messages.content_type value. */
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location'
  /** Readable text for the inbox bubble. */
  text: string
}

export interface CoexContact {
  phone: string
  name: string
  action: 'add' | 'remove'
}

interface RawMessage {
  from?: string
  to?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: { caption?: string }
  video?: { caption?: string }
  document?: { caption?: string; filename?: string }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  contacts?: Array<{ name?: { formatted_name?: string } }>
}

const digits = (s: string | undefined) => (s ?? '').replace(/\D/g, '')

/** Readable bubble text + allowed content_type for any Meta message shape. */
export function describeCoexMessage(m: RawMessage): Pick<CoexMessage, 'contentType' | 'text'> {
  switch (m.type) {
    case 'text':
      return { contentType: 'text', text: m.text?.body ?? '' }
    case 'image':
      return { contentType: 'image', text: m.image?.caption || '📷 Imagen' }
    case 'sticker':
      return { contentType: 'image', text: '🖼️ Sticker' }
    case 'video':
      return { contentType: 'video', text: m.video?.caption || '🎥 Video' }
    case 'audio':
      return { contentType: 'audio', text: '🎤 Audio' }
    case 'document':
      return {
        contentType: 'document',
        text: m.document?.caption || `📄 ${m.document?.filename || 'Documento'}`,
      }
    case 'location': {
      const l = m.location
      const where = [l?.name, l?.address].filter(Boolean).join(' · ')
      const link = l?.latitude != null ? `https://maps.google.com/?q=${l.latitude},${l.longitude}` : ''
      return { contentType: 'location', text: ['📍', where, link].filter(Boolean).join(' ') }
    }
    case 'contacts':
      return { contentType: 'text', text: `👤 ${m.contacts?.[0]?.name?.formatted_name ?? 'Contacto'}` }
    default:
      return { contentType: 'text', text: `[${m.type ?? 'mensaje'}]` }
  }
}

function toCoexMessage(m: RawMessage, customerPhone: string, direction: CoexMessage['direction']): CoexMessage | null {
  if (!m.id || !customerPhone) return null
  const ts = Number(m.timestamp)
  return {
    id: m.id,
    customerPhone,
    direction,
    createdAt: new Date(Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now()).toISOString(),
    ...describeCoexMessage(m),
  }
}

/** `smb_message_echoes`: everything here was written from the phone app. */
export function parseMessageEchoes(value: { message_echoes?: RawMessage[] }): CoexMessage[] {
  return (value.message_echoes ?? [])
    .map((m) => toCoexMessage(m, digits(m.to), 'outbound'))
    .filter((m): m is CoexMessage => m !== null)
}

export interface HistoryChunk {
  messages: CoexMessage[]
  /** Set when the business declined to share its history (or Meta failed). */
  error: string | null
  /** 0–100, from Meta's chunk metadata, when present. */
  progress: number | null
}

/**
 * `history`: threads keyed by the customer's number. A message whose
 * `from` is the business number was sent by the business.
 */
export function parseHistory(value: {
  metadata?: { display_phone_number?: string }
  history?: Array<{
    metadata?: { progress?: number | string }
    threads?: Array<{ id?: string; messages?: RawMessage[] }>
    errors?: Array<{ code?: number; title?: string; message?: string }>
  }>
}): HistoryChunk {
  const business = digits(value.metadata?.display_phone_number)
  const messages: CoexMessage[] = []
  let error: string | null = null
  let progress: number | null = null
  for (const chunk of value.history ?? []) {
    if (chunk.errors?.length) {
      const e = chunk.errors[0]
      error = `${e.code ?? ''} ${e.title ?? e.message ?? 'history error'}`.trim()
    }
    const p = Number(chunk.metadata?.progress)
    if (Number.isFinite(p)) progress = p
    for (const thread of chunk.threads ?? []) {
      const customer = digits(thread.id)
      for (const m of thread.messages ?? []) {
        const fromBusiness = business !== '' && digits(m.from) === business
        const parsed = toCoexMessage(m, customer, fromBusiness ? 'outbound' : 'inbound')
        if (parsed) messages.push(parsed)
      }
    }
  }
  return { messages, error, progress }
}

/** `smb_app_state_sync`: the phone's address book. */
export function parseStateSync(value: {
  state_sync?: Array<{
    type?: string
    action?: string
    contact?: { full_name?: string; first_name?: string; phone_number?: string }
  }>
}): CoexContact[] {
  const out: CoexContact[] = []
  for (const item of value.state_sync ?? []) {
    if (item.type !== 'contact' || !item.contact) continue
    const phone = digits(item.contact.phone_number)
    if (!phone) continue
    out.push({
      phone,
      name: (item.contact.full_name || item.contact.first_name || '').trim(),
      action: item.action === 'remove' ? 'remove' : 'add',
    })
  }
  return out
}

export const COEXISTENCE_FIELDS = new Set(['smb_message_echoes', 'history', 'smb_app_state_sync'])

// ============================================================
// Graph API calls
// ============================================================

async function graphError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as { error?: { message?: string } }
    if (data.error?.message) message = data.error.message
  } catch {
    // not JSON — keep the fallback
  }
  throw new Error(message)
}

/** Trade the Embedded Signup `code` for a business integration token. */
export async function exchangeSignupCode(args: {
  code: string
  appId: string
  appSecret: string
}): Promise<string> {
  const url = new URL(`${META_API_BASE}/oauth/access_token`)
  url.searchParams.set('client_id', args.appId)
  url.searchParams.set('client_secret', args.appSecret)
  url.searchParams.set('code', args.code)
  const response = await fetch(url)
  if (!response.ok) await graphError(response, `Meta token exchange failed: ${response.status}`)
  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('Meta did not return an access token')
  return data.access_token
}

/** Phone numbers under a WABA (used when the signup event omits the id). */
export async function listWabaPhoneNumbers(args: {
  wabaId: string
  accessToken: string
}): Promise<Array<{ id: string; display_phone_number: string }>> {
  const response = await fetch(`${META_API_BASE}/${args.wabaId}/phone_numbers?fields=id,display_phone_number`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
  const data = (await response.json()) as { data?: Array<{ id: string; display_phone_number: string }> }
  return data.data ?? []
}

/**
 * Ask Meta to send the phone app's contacts or chat history through the
 * webhook. Must be called within 24 h of onboarding, contacts first.
 */
export async function requestSmbSync(args: {
  phoneNumberId: string
  accessToken: string
  syncType: 'smb_app_state_sync' | 'history'
}): Promise<void> {
  const response = await fetch(`${META_API_BASE}/${args.phoneNumberId}/smb_app_data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: args.syncType }),
  })
  if (!response.ok) await graphError(response, `Meta API error: ${response.status}`)
}
