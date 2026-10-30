import { describe, expect, it } from 'vitest'
import { DEFAULT_BUSINESS_SETTINGS, sanitizeSettings, type BusinessSettings } from '@/lib/business/settings'
import { pickAdCode, sanitizeAdLinks, type AdLink } from './ad-links'
import {
  countryOfPhone,
  hostGuestLine,
  hostScanPath,
  hostSummaryText,
  hostWelcomeText,
  isBotUserAgent,
} from './hosts'

const host: AdLink = {
  code: 'JUAN',
  name: 'Juan Pérez',
  channel: 'Anfitrión Airbnb',
  message: 'Hola 👋 me hospedo en Depto El Vergel 🏠',
  createdAt: '2026-10-30T00:00:00.000Z',
  host: { lodging: 'Depto El Vergel', phone: '593991234567', reward: '3 % en crédito' },
}

function biz(program: Partial<BusinessSettings['hostProgram']> = {}): BusinessSettings {
  return sanitizeSettings({
    ...DEFAULT_BUSINESS_SETTINGS,
    name: 'Ferretería Demo',
    hostProgram: { ...DEFAULT_BUSINESS_SETTINGS.hostProgram, ...program },
  })
}

describe('host program', () => {
  it('welcomes a guest with the discount and free delivery', () => {
    const text = hostWelcomeText(biz({ discountPct: 5, freeDeliveryFrom: 20 }), host)!
    expect(text).toContain('*Depto El Vergel*')
    expect(text).toContain('*5 % de descuento*')
    expect(text).toContain('*envío gratis* desde $20,00')
    expect(text).toContain('Ferretería Demo')
  })

  it('leaves free delivery out when not offered, and sends nothing when nothing is offered', () => {
    expect(hostWelcomeText(biz({ freeDeliveryFrom: 0 }), host)).not.toContain('envío gratis')
    expect(hostWelcomeText(biz({ discountPct: 0, freeDeliveryFrom: 0 }), host)).toBeNull()
    expect(hostWelcomeText(biz(), { ...host, host: undefined })).toBeNull()
  })

  it('tells the team what to apply on the order card', () => {
    expect(hostGuestLine(biz({ discountPct: 5, freeDeliveryFrom: 20 }), host)).toBe(
      '🏠 Huésped de Juan Pérez (Depto El Vergel) · 5 % de descuento · envío gratis desde $20,00',
    )
  })

  it('clamps the program values', () => {
    const p = biz({ discountPct: 80, freeDeliveryFrom: -3, validDays: 0 }).hostProgram
    expect(p).toMatchObject({ discountPct: 50, freeDeliveryFrom: 0, validDays: 1 })
  })

  it('writes the monthly summary for the host', () => {
    const text = hostSummaryText(host, { month: 'octubre de 2026', guests: 3, orders: 2, sales: 41.5 })
    expect(text).toContain('Hola Juan Pérez')
    expect(text).toContain('2 pedido(s) por $41,50')
    expect(text).toContain('Su premio: 3 % en crédito')
  })

  it('builds the QR path', () => {
    expect(hostScanPath('acc-1', 'JUAN')).toBe('/r/acc-1/JUAN')
  })
})

describe('countryOfPhone', () => {
  it('uses the longest calling code', () => {
    expect(countryOfPhone('593991234567')).toBe('Ecuador')
    expect(countryOfPhone('+1 (415) 555-0100')).toBe('EE. UU. / Canadá')
    expect(countryOfPhone('351912345678')).toBe('Portugal')
    expect(countryOfPhone('34612345678')).toBe('España')
    expect(countryOfPhone('999')).toBe('Otro')
  })
})

describe('isBotUserAgent', () => {
  it('skips link previews', () => {
    expect(isBotUserAgent('WhatsApp/2.23')).toBe(true)
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true)
    expect(isBotUserAgent(null)).toBe(true)
    expect(isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false)
  })
})

describe('host links', () => {
  it('keeps the host data through sanitizing', () => {
    const [link] = sanitizeAdLinks([{ ...host, host: { lodging: ' Depto ', phone: '+593 99 123 4567', reward: 'x' } }])
    expect(link.host).toEqual({ lodging: 'Depto', phone: '593991234567', reward: 'x' })
    expect(sanitizeAdLinks([{ ...host, host: undefined }])[0].host).toBeUndefined()
  })

  it('picks a free code', () => {
    expect(pickAdCode('', 'Juan Pérez', [])).toBe('JUAN')
    expect(pickAdCode('', 'Juan Pérez', ['JUAN'])).toBe('JUAN2')
    expect(pickAdCode('casa1', 'x', [])).toBe('CASA1')
    expect(pickAdCode('casa1', 'x', ['CASA1'])).toBeNull()
  })
})
