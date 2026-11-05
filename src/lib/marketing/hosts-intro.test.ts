import { describe, expect, it } from 'vitest'
import { sanitizeSettings } from '@/lib/business/settings'
import { hostWelcomeText, isHostIntro } from './hosts'
import type { AdLink } from './ad-links'

const link = {
  code: 'DIEGO',
  name: 'Diego Ponce',
  channel: 'Anfitrión Airbnb',
  message: 'Hola 👋 me hospedo en Misicata - Rocas de Misicata 🏠',
  host: { lodging: 'Misicata - Rocas de Misicata', phone: '', reward: '' },
} as unknown as AdLink

describe('isHostIntro', () => {
  it('is the QR text, as sent or retyped', () => {
    expect(isHostIntro('Hola 👋 me hospedo en Misicata - Rocas de Misicata 🏠', link)).toBe(true)
    expect(isHostIntro('Buenas tardes, me hospedo en Misicata', link)).toBe(true)
    expect(isHostIntro("Hi, I'm staying at Rocas de Misicata", link)).toBe(true)
    expect(isHostIntro('', link)).toBe(true)
  })

  it('is not a message that already asks for something', () => {
    expect(isHostIntro('Quiero 2 aguas y pan', link)).toBe(false)
    expect(isHostIntro('Hola me hospedo en Misicata, necesito 2 botellones de agua, 1 libra de café, pan, huevos y leche por favor', link)).toBe(false)
  })
})

describe('hostWelcomeText', () => {
  it('mentions free delivery in both languages', () => {
    const biz = sanitizeSettings({ name: 'Ferrotienda', hostProgram: { discountPct: 5, freeDeliveryFrom: 20, validDays: 15 } })
    const text = hostWelcomeText(biz, link)!
    expect(text).toContain('*envío gratis* desde $20,00')
    expect(text).toContain('*free delivery* from $20.00')
  })
})
