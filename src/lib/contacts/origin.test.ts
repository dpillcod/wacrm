import { describe, expect, it } from 'vitest'
import { originNote, originTagName } from './origin'

describe('originTagName', () => {
  it('names the kind of source and the network', () => {
    expect(originTagName({ source_type: 'ad', source_url: 'https://fb.me/abc' })).toBe('Origen: Anuncio Facebook')
    expect(originTagName({ source_type: 'post', source_url: 'https://www.instagram.com/p/xyz' })).toBe(
      'Origen: Publicación Instagram',
    )
  })

  it('falls back to a generic network when the link says nothing', () => {
    expect(originTagName({ source_type: 'ad' })).toBe('Origen: Anuncio Meta')
  })
})

describe('originNote', () => {
  it('includes the headline and the link when Meta sends them', () => {
    expect(originNote({ source_type: 'ad', headline: 'Útiles escolares -20%', source_url: 'https://fb.me/abc' })).toBe(
      '📣 Escribió desde un anuncio «Útiles escolares -20%».\nhttps://fb.me/abc',
    )
  })
})
