import { describe, expect, it } from 'vitest'
import { isFetchableUrl, parseMediaInput, sniffImageType } from './library'

const base = { image_url: 'https://redes.ferrotiendaec.com/p/nav26.jpg', name: 'Canastas — post' }

describe('parseMediaInput', () => {
  it('accepts a full piece', () => {
    const r = parseMediaInput({ ...base, ref: 'NAV26-01', caption: '🎄 Hola', tags: ['Navidad', 'navidad', 'canastas'], valid_until: '2026-12-24' })
    expect('input' in r && r.input).toEqual({
      imageUrl: base.image_url,
      name: 'Canastas — post',
      ref: 'NAV26-01',
      caption: '🎄 Hola',
      tags: ['navidad', 'canastas'],
      validUntil: '2026-12-24',
    })
  })

  it('rejects what the CRM could not fetch or store', () => {
    expect(parseMediaInput(null)).toHaveProperty('error')
    expect(parseMediaInput({ name: 'x' })).toHaveProperty('error')
    expect(parseMediaInput({ ...base, name: ' ' })).toHaveProperty('error')
    expect(parseMediaInput({ ...base, ref: 'a b' })).toHaveProperty('error')
    expect(parseMediaInput({ ...base, valid_until: '24/12/2026' })).toHaveProperty('error')
  })
})

describe('isFetchableUrl', () => {
  it('only takes public https hosts', () => {
    expect(isFetchableUrl('https://abc.supabase.co/storage/v1/object/public/x.jpg')).toBe(true)
    expect(isFetchableUrl('http://example.com/x.jpg')).toBe(false)
    expect(isFetchableUrl('https://localhost/x.jpg')).toBe(false)
    expect(isFetchableUrl('https://127.0.0.1/x.jpg')).toBe(false)
    expect(isFetchableUrl('https://[::1]/x.jpg')).toBe(false)
    expect(isFetchableUrl('https://user:pw@example.com/x.jpg')).toBe(false)
    expect(isFetchableUrl('https://intranet/x.jpg')).toBe(false)
  })
})

describe('sniffImageType', () => {
  it('reads the real type from the first bytes', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect(sniffImageType(webp)).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('<html>'))).toBeNull()
  })
})
