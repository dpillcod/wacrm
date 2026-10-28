import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { subscribeWabaToApp, verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeSignupCode,
  listWabaPhoneNumbers,
  requestSmbSync,
} from '@/lib/whatsapp/coexistence'

/**
 * Embedded Signup for WhatsApp Business app numbers (coexistence).
 *
 * GET  → whether the button can be shown, plus the public ids the
 *        Facebook JS SDK needs (read at runtime, not baked into the build).
 * POST → { code, waba_id, phone_number_id? } from the signup popup:
 *        trade the code for a token, subscribe the WABA to our webhook,
 *        save the number as this account's WhatsApp config, then ask Meta
 *        for the phone's contacts and chat history (required within 24 h).
 *
 * Env: META_APP_ID, META_APP_SECRET, META_ES_CONFIG_ID (the Facebook Login
 * for Business configuration id of type "WhatsApp Embedded Signup").
 */

const SDK_GRAPH_VERSION = 'v21.0'

function admin() {
  return createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function signupEnv() {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  const configId = process.env.META_ES_CONFIG_ID
  return appId && appSecret && configId ? { appId, appSecret, configId } : null
}

export async function GET() {
  try {
    await requireRole('admin')
    const env = signupEnv()
    if (!env) {
      const missing = ['META_APP_ID', 'META_APP_SECRET', 'META_ES_CONFIG_ID'].filter((k) => !process.env[k])
      return NextResponse.json({ available: false, missing })
    }
    return NextResponse.json({
      available: true,
      appId: env.appId,
      configId: env.configId,
      graphVersion: SDK_GRAPH_VERSION,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const env = signupEnv()
    if (!env) return NextResponse.json({ error: 'Embedded Signup is not configured on the server.' }, { status: 400 })

    const body = (await request.json().catch(() => ({}))) as {
      code?: string
      waba_id?: string
      phone_number_id?: string
    }
    if (!body.code || !body.waba_id) {
      return NextResponse.json({ error: 'code and waba_id are required' }, { status: 400 })
    }

    const accessToken = await exchangeSignupCode({ code: body.code, appId: env.appId, appSecret: env.appSecret })

    let phoneNumberId = body.phone_number_id
    if (!phoneNumberId) {
      const numbers = await listWabaPhoneNumbers({ wabaId: body.waba_id, accessToken })
      if (numbers.length !== 1) {
        return NextResponse.json(
          { error: `The WhatsApp account has ${numbers.length} numbers; could not tell which one was connected.` },
          { status: 400 },
        )
      }
      phoneNumberId = numbers[0].id
    }

    const db = admin()
    const { data: claimed } = await db
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', ctx.accountId)
      .maybeSingle()
    if (claimed) {
      return NextResponse.json(
        { error: 'This WhatsApp number is already connected to another account on this CRM.' },
        { status: 409 },
      )
    }

    const phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
    await subscribeWabaToApp({ wabaId: body.waba_id, accessToken })

    const now = new Date().toISOString()
    const row = {
      phone_number_id: phoneNumberId,
      waba_id: body.waba_id,
      access_token: encrypt(accessToken),
      status: 'connected',
      connected_at: now,
      // Coexistence numbers stay registered by the phone app; no /register.
      registered_at: now,
      subscribed_apps_at: now,
      last_registration_error: null,
      updated_at: now,
    }
    const { data: existing } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const { error: saveError } = existing
      ? await db.from('whatsapp_config').update(row).eq('account_id', ctx.accountId)
      : await db.from('whatsapp_config').insert({ account_id: ctx.accountId, user_id: ctx.userId, ...row })
    if (saveError) {
      console.error('[embedded-signup] saving config failed:', saveError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    // Contacts first, then history — Meta's required order. Failures are
    // reported, not fatal: the number is connected either way and the
    // sync can be retried from this endpoint's PUT within 24 h.
    const sync = await requestSyncs(phoneNumberId, accessToken)
    return NextResponse.json({ success: true, phone_info: phoneInfo, sync })
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[embedded-signup] failed:', err.message)
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}

/** PUT → retry the contacts + history sync for the connected number. */
export async function PUT() {
  try {
    const ctx = await requireRole('admin')
    const { data: config } = await admin()
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!config) return NextResponse.json({ error: 'No WhatsApp number connected' }, { status: 400 })
    const sync = await requestSyncs(config.phone_number_id, decrypt(config.access_token))
    return NextResponse.json({ sync })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function requestSyncs(phoneNumberId: string, accessToken: string) {
  const result: { contacts: string; history: string } = { contacts: 'ok', history: 'ok' }
  for (const [key, syncType] of [
    ['contacts', 'smb_app_state_sync'],
    ['history', 'history'],
  ] as const) {
    try {
      await requestSmbSync({ phoneNumberId, accessToken, syncType })
    } catch (err) {
      result[key] = err instanceof Error ? err.message : String(err)
    }
  }
  return result
}
