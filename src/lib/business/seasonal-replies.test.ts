import { describe, expect, it } from 'vitest'
import {
  findSeasonalReply,
  localDate,
  sanitizeSeasonalReplies,
  seasonalRepliesFromText,
  seasonalRepliesToText,
} from './seasonal-replies'

const TEXT = `canasta, canastas | 2026-11-09
🎄 Tenemos canastas navideñas.
Reserve hoy.
---
pavo, Asado
🦃 Pavos para Navidad.`

describe('seasonal replies', () => {
  it('reads and writes the settings text', () => {
    const rules = seasonalRepliesFromText(TEXT)
    expect(rules).toEqual([
      { keywords: ['canasta', 'canastas'], until: '2026-11-09', reply: '🎄 Tenemos canastas navideñas.\nReserve hoy.' },
      { keywords: ['pavo', 'asado'], until: '', reply: '🦃 Pavos para Navidad.' },
    ])
    expect(seasonalRepliesFromText(seasonalRepliesToText(rules))).toEqual(rules)
  })

  it('drops rules without words or reply, and bad dates', () => {
    expect(sanitizeSeasonalReplies([{ keywords: [], reply: 'x' }, { keywords: ['a'], reply: '' }])).toEqual([])
    expect(sanitizeSeasonalReplies([{ keywords: ['a'], reply: 'x', until: 'mañana' }])[0].until).toBe('')
    expect(sanitizeSeasonalReplies('nope')).toEqual([])
  })

  it('matches whole words, without accents, while in date', () => {
    const rules = seasonalRepliesFromText(TEXT)
    expect(findSeasonalReply(rules, '¿Tienen CANASTAS navideñas?', '2026-10-28')?.index).toBe(0)
    expect(findSeasonalReply(rules, 'quiero un pavo', '2026-12-30')?.index).toBe(1)
    expect(findSeasonalReply(rules, 'canasta', '2026-11-10')).toBeNull()
    expect(findSeasonalReply(rules, 'canastilla de bebé', '2026-10-28')).toBeNull()
  })

  it('local date uses the business offset', () => {
    expect(localDate(-5, Date.parse('2026-10-28T03:00:00Z'))).toBe('2026-10-27')
  })
})
