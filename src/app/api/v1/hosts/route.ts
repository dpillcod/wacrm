// ============================================================
// GET /api/v1/hosts — partner hosts (Airbnb) for a design app
//                     (scope: marketing:read).
//
// Each host's QR link (scan_url) — the one that counts scans and gives
// guests the discount — plus the same QR as a ready SVG, and what the
// host's guests did (scans, guests, orders, sales; all time and this
// month). Also the program's terms to print on the sign.
// Never returns the host's phone or agreed reward.
//
// Pair with the host.* webhooks to hear about new or changed hosts.
// ============================================================

import QRCode from 'qrcode';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { loadBusinessSettings } from '@/lib/business/settings';
import { appBaseUrl, hostPublicView, hostRows, programView } from '@/lib/marketing/host-stats';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'marketing:read');
    const biz = await loadBusinessSettings(ctx.supabase, ctx.accountId);
    const { rows, month } = await hostRows(ctx.supabase, ctx.accountId, biz, appBaseUrl(biz, request));
    const hosts = await Promise.all(
      rows.map(async (h) => ({
        ...hostPublicView(h, h.scanUrl),
        qr_svg: await QRCode.toString(h.scanUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
        results: { all: h.all, month: h.month, countries: h.countries, last_order_at: h.lastOrderAt },
      })),
    );
    return ok({
      business_name: biz.name,
      program: programView(biz.hostProgram),
      month,
      hosts,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
