import { describe, expect, it } from 'vitest'
import { activeMenuPromo, campaignsForAi, menuPromosFromText, menuPromosToText } from './menu-promos'
import { acceptOfferedProduct } from '../flows/question-answer'

const promos = menuPromosFromText(
  '2026-11-09 | 🎄 Preventa 5 %\n\n2026-12-24 | 🎄 Canastas navideñas\nsin fecha',
)

describe('menu promotions', () => {
  it('reads one per line, with an optional last day', () => {
    expect(promos).toEqual([
      { until: '2026-11-09', text: '🎄 Preventa 5 %' },
      { until: '2026-12-24', text: '🎄 Canastas navideñas' },
      { until: '', text: 'sin fecha' },
    ])
    expect(menuPromosFromText(menuPromosToText(promos))).toEqual(promos)
  })

  it('shows the first one still in date', () => {
    expect(activeMenuPromo(promos, '2026-11-09')).toBe('🎄 Preventa 5 %')
    expect(activeMenuPromo(promos, '2026-11-10')).toBe('🎄 Canastas navideñas')
    expect(activeMenuPromo(promos.slice(0, 2), '2026-12-25')).toBe('')
  })

  it('hands the AI the promotion and one reply per campaign word', () => {
    const seasonal = [
      { keywords: ['canasta'], reply: 'Preventa\nhasta el 9', until: '2026-11-09' },
      { keywords: ['canasta'], reply: 'General', until: '2026-12-24' },
      { keywords: ['pavo'], reply: 'Pavos', until: '2026-12-20' },
    ]
    const text = campaignsForAi(promos, seasonal, '2026-11-05')
    expect(text).toContain('Promoción: 🎄 Preventa 5 %')
    expect(text).toContain('canasta: Preventa hasta el 9')
    expect(text).not.toContain('General')
    expect(text).toContain('pavo: Pavos')
    expect(campaignsForAi([], [], '2026-11-05')).toBe('')
    expect(campaignsForAi(undefined, undefined, '2026-11-05')).toBe('')
  })
})

describe('a package size answers the offered product', () => {
  it('reads "1 funda grande" as the bag of the food asked about', () => {
    const food = 'comida de gato Royal Canin Kitten'
    expect(acceptOfferedProduct('1 funda grande', food)).toBe(`1 funda grande ${food}`)
    expect(acceptOfferedProduct('Sí, una caja de 12 unidades', food)).toBe(`1 caja de 12 unidades ${food}`)
    expect(acceptOfferedProduct('2 fundas', food)).toBe(`2 fundas ${food}`)
    expect(acceptOfferedProduct('una funda de basura', food)).toBeNull()
  })
})
