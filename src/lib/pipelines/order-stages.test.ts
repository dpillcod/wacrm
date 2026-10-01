import { describe, expect, it } from 'vitest'
import {
  csatReplyId,
  csatThanks,
  orderRefFromTitle,
  orderStageKind,
  parseCsatReplyId,
  stageMessage,
  statusReply,
  isOrderStatusQuestion,
} from './order-stages'
import { DEFAULT_BUSINESS_SETTINGS } from '../business/settings'
import { DEMO_STORE } from '../business/__fixtures__/demo-store'

describe('orderStageKind', () => {
  it('matches the board columns loosely', () => {
    expect(orderStageKind('Nuevo')).toBe('new')
    expect(orderStageKind('Listo / En camino')).toBe('ready')
    expect(orderStageKind('EN CAMINO')).toBe('ready')
    expect(orderStageKind('Entregado')).toBe('delivered')
    expect(orderStageKind('Canceladó')).toBe('cancelled')
    expect(orderStageKind('Otra cosa')).toBeNull()
  })
})

describe('stageMessage', () => {
  it('names the order when the card title carries its number', () => {
    const ref = orderRefFromTitle('Pedido N° 0015 — Juan')
    expect(ref).toBe('N° 0015')
    expect(stageMessage('ready', ref, DEMO_STORE)).toContain('Su pedido N° 0015 ya está listo')
  })

  it('says nothing for new and quoted orders', () => {
    expect(stageMessage('new', '', DEMO_STORE)).toBeNull()
    expect(stageMessage('quoted', '', DEMO_STORE)).toBeNull()
  })
})

describe('csat reply ids', () => {
  it('round-trips the rating and the card', () => {
    expect(parseCsatReplyId(csatReplyId('mal', 'deal-123'))).toEqual({ key: 'mal', dealId: 'deal-123' })
    expect(parseCsatReplyId('followup_yes:abc')).toBeNull()
  })
})

describe('csatThanks', () => {
  it('asks only delighted customers for a Google review', () => {
    const url = DEMO_STORE.googleReviewUrl
    expect(csatThanks('excelente', DEMO_STORE)).toContain(url)
    expect(csatThanks('bien', DEMO_STORE)).not.toContain(url)
    expect(csatThanks('mal', DEMO_STORE)).not.toContain(url)
  })

  it('skips the review ask when the business has no review link', () => {
    expect(csatThanks('excelente', DEFAULT_BUSINESS_SETTINGS)).toBe(DEFAULT_BUSINESS_SETTINGS.orderBoard.csatGood)
  })
})

describe('statusReply', () => {
  it('answers by the order column, naming the order', () => {
    expect(statusReply('ready', 'N° 0015', DEMO_STORE)).toContain('N° 0015 ya está listo')
    expect(statusReply(null, 'N° 1', DEMO_STORE)).toContain('lo está revisando')
  })
})

describe('isOrderStatusQuestion', () => {
  it.each([
    '¿Dónde está mi pedido?',
    'hola, cuándo llega mi compra',
    'Estado de mi orden por favor',
    'mi pedido ya está listo?',
    'buenas, que pasó con mi pedido',
    'aún no ha llegado mi pedido',
  ])('recognises "%s"', (text) => {
    expect(isOrderStatusQuestion(text)).toBe(true)
  })

  it.each([
    'quiero hacer un pedido',
    '2 leches y 1 pan',
    'donde queda la tienda',
    'hola',
    'Quiero hacer un pedido: 2 cuadernos, 1 esfero, 3 lápices, 1 borrador, 1 regla, 1 compás y 1 mochila grande azul',
  ])('ignores "%s"', (text) => {
    expect(isOrderStatusQuestion(text)).toBe(false)
  })
})
