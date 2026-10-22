import { describe, expect, it } from 'vitest'
import { adLinkUrl, adOriginTag, findAdLink, normalizeAdCode, sanitizeAdLinks, stripAdCode, type AdLink } from './ad-links'

const link: AdLink = {
  code: 'TORTAS',
  name: 'Tortas de cumpleaños',
  channel: 'Estado de WhatsApp',
  message: 'Hola 👋 Vi su publicidad de tortas',
  createdAt: '2026-10-22T00:00:00.000Z',
}

describe('advertising links', () => {
  it('builds the wa.me link with the code at the end', () => {
    const url = adLinkUrl('593993679794', link)
    expect(url.startsWith('https://wa.me/593993679794?text=')).toBe(true)
    expect(decodeURIComponent(url.split('text=')[1])).toBe('Hola 👋 Vi su publicidad de tortas #TORTAS')
  })
  it('finds the ad by its code, in any case, and strips it for the bot', () => {
    const text = 'Hola 👋 Vi su publicidad de tortas #tortas'
    expect(findAdLink(text, [link])).toBe(link)
    expect(stripAdCode(text, link)).toBe('Hola 👋 Vi su publicidad de tortas')
    expect(findAdLink('quiero #TORTA', [link])).toBeNull()
    expect(findAdLink('sin código', [link])).toBeNull()
  })
  it('normalizes codes and cleans stored links', () => {
    expect(normalizeAdCode('pintura navideña!')).toBe('PINTURANAVIDENA')
    expect(normalizeAdCode('x')).toBe('')
    expect(sanitizeAdLinks([link, { ...link }, { code: '', name: 'x' }, 'bad'])).toEqual([link])
    expect(adOriginTag(link)).toBe('Origen: Estado de WhatsApp · Tortas de cumpleaños')
  })
})
