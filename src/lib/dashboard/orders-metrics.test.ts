import { describe, expect, it } from 'vitest'
import {
  csatCounts,
  dailyOrderSeries,
  localDayKey,
  productKey,
  satisfactionPct,
  topProducts,
  webOrderLines,
  whatsappOrderLines,
} from './orders-metrics'

describe('localDayKey', () => {
  it('buckets by Cuenca local date (UTC-5)', () => {
    // 03:00Z on the 29th is still the evening of the 28th in Ecuador.
    expect(localDayKey('2026-09-29T03:00:00Z', -5)).toBe('2026-09-28')
    expect(localDayKey('2026-09-29T06:00:00Z', -5)).toBe('2026-09-29')
  })
})

describe('dailyOrderSeries', () => {
  it('zero-fills every day and counts each channel', () => {
    const now = new Date('2026-09-29T15:00:00Z')
    const s = dailyOrderSeries(3, ['2026-09-29T14:00:00Z', '2026-09-28T20:00:00Z'], ['2026-09-29T13:00:00Z'], now)
    expect(s).toEqual([
      { day: '2026-09-27', whatsapp: 0, web: 0 },
      { day: '2026-09-28', whatsapp: 1, web: 0 },
      { day: '2026-09-29', whatsapp: 1, web: 1 },
    ])
  })
})

describe('products', () => {
  it('ignores quantity, case and accents when counting', () => {
    expect(productKey('2 Coca-Cola de 3 litros')).toBe('coca cola de 3 litros')
    expect(productKey('2x COCA COLA DE 3 LITROS')).toBe('coca cola de 3 litros')
    const top = topProducts(['2 Coca-Cola de 3 litros', '1x coca cola de 3 litros', '10 panes'])
    expect(top[0]).toEqual({ label: 'Coca-Cola de 3 litros', count: 2 })
    expect(top[1].label).toBe('panes')
  })

  it('splits WhatsApp and web order texts into lines', () => {
    expect(whatsappOrderLines('1 leche\n\n2 panes')).toEqual(['1 leche', '2 panes'])
    expect(webOrderLines('2x A, 1x B')).toEqual(['2x A', '1x B'])
    expect(webOrderLines('(sin detalle)')).toEqual([])
  })
})

describe('csat', () => {
  it('counts ratings found in card notes', () => {
    const c = csatCounts([
      'Lista…\n\nCalificación del cliente: ⭐ Excelente',
      'Calificación del cliente: 👎 Mal',
      null,
    ])
    expect(c).toEqual({ excelente: 1, bien: 0, mal: 1 })
    expect(satisfactionPct(c)).toBe(50)
    expect(satisfactionPct({ excelente: 0, bien: 0, mal: 0 })).toBeNull()
  })
})
