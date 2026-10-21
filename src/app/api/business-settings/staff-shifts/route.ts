import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { staffShifts } from '@/lib/whatsapp/staff-notify'

// GET /api/business-settings/staff-shifts → { shifts }
//   Each staff number (Settings → My business → staff alerts) with its
//   name and whether it can get WhatsApp alerts right now: alerts only
//   reach numbers that wrote to the bot in the last 24 h (Meta's free
//   window). Any member may read it.

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }
  const shifts = await staffShifts(supabaseAdmin(), ctx.accountId)
  return NextResponse.json({ shifts })
}
