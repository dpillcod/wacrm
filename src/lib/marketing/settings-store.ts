import type { SupabaseClient } from '@supabase/supabase-js'
import { clearBusinessSettingsCache, sanitizeSettings } from '@/lib/business/settings'

// The Advertising page owns a few business settings (adLinks,
// hostProgram) and saves them on their own, over what's stored — so a
// "My business" form open elsewhere never clashes with them.

async function storedSettings(db: SupabaseClient, accountId: string): Promise<Record<string, unknown>> {
  const { data } = await db.from('business_settings').select('settings').eq('account_id', accountId).maybeSingle()
  const s = (data as { settings?: unknown } | null)?.settings
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
}

/** Merge `patch` into the stored settings and save; false when the write failed. */
export async function saveSettingsPatch(
  db: SupabaseClient,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const stored = await storedSettings(db, accountId)
  const settings = sanitizeSettings({ ...stored, ...patch })
  const { error } = await db
    .from('business_settings')
    .upsert({ account_id: accountId, settings, updated_at: new Date().toISOString() }, { onConflict: 'account_id' })
  if (error) console.error('[marketing] save failed:', error.message)
  clearBusinessSettingsCache(accountId)
  return !error
}
