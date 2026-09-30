import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateWooOrder, wooConfigured, wooOrderUrl } from './client'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('wooOrderUrl', () => {
  it('builds the REST path without doubled slashes', () => {
    expect(wooOrderUrl('https://ferrotiendaec.com/', '45637')).toBe(
      'https://ferrotiendaec.com/wp-json/wc/v3/orders/45637',
    )
    expect(wooOrderUrl('https://ferrotiendaec.com', '45637', '/notes')).toBe(
      'https://ferrotiendaec.com/wp-json/wc/v3/orders/45637/notes',
    )
  })
})

describe('updateWooOrder', () => {
  it('is a reported no-op until the store credentials are configured', async () => {
    vi.stubEnv('WOOCOMMERCE_URL', '')
    vi.stubEnv('WOOCOMMERCE_KEY', '')
    vi.stubEnv('WOOCOMMERCE_SECRET', '')
    expect(wooConfigured()).toBe(false)
    expect(await updateWooOrder('1', { status: 'cancelled' })).toEqual({ ok: false, error: 'not_configured' })
  })
})
