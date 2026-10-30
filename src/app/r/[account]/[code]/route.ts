import { NextResponse, type NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadBusinessSettings } from '@/lib/business/settings'
import { adLinkUrl, normalizeAdCode } from '@/lib/marketing/ad-links'
import { isBotUserAgent } from '@/lib/marketing/hosts'

// GET /r/<account id>/<code> — the URL inside a partner's QR (an Airbnb
// host's apartment). Counts the scan, then opens WhatsApp with the
// link's message and "#CODE". Public: whoever scans isn't logged in.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ account: string; code: string }> },
) {
  const { account, code: rawCode } = await params
  const code = normalizeAdCode(rawCode)
  if (!UUID_RE.test(account) || !code) return new NextResponse('Not found', { status: 404 })

  const db = supabaseAdmin()
  const biz = await loadBusinessSettings(db, account)
  const link = biz.adLinks.find((l) => l.code === code)
  if (!link || !biz.whatsappNumber) return new NextResponse('Not found', { status: 404 })

  if (!isBotUserAgent(request.headers.get('user-agent'))) {
    const { error } = await db.from('ad_link_scans').insert({ account_id: account, code })
    if (error) console.error('[r] scan insert failed:', error.message)
  }
  return NextResponse.redirect(adLinkUrl(biz.whatsappNumber, link), 302)
}
