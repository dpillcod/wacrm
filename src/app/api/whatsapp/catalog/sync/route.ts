import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncCatalogForAccount } from '@/lib/whatsapp/catalog-sync'

/**
 * Sync product catalog from Meta Commerce Manager → local
 * catalog_products table. Session-gated: the caller's own account
 * only. The unattended equivalent for every connected account lives
 * at `/api/whatsapp/catalog/cron-sync` (cron-secret gated); both
 * share the actual walk/upsert/stale-marking logic in
 * `lib/whatsapp/catalog-sync.ts` so a fix only has to happen once.
 *
 * Products removed from the catalog are NOT deleted locally — they're
 * marked `is_stale` so an in-flight message still referencing one
 * doesn't break, and so the picker/AI can exclude them going forward.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    const result = await syncCatalogForAccount(supabase, accountId, config)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error syncing WhatsApp catalog products:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync catalog',
      },
      { status: 500 },
    )
  }
}
