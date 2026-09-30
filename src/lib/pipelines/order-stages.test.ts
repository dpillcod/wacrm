import { describe, expect, it } from 'vitest'
import {
  csatReplyId,
  orderRefFromTitle,
  orderStageKind,
  parseCsatReplyId,
  stageMessage,
} from './order-stages'

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
    expect(stageMessage('ready', ref)).toContain('Su pedido N° 0015 ya está listo')
  })

  it('says nothing for new and quoted orders', () => {
    expect(stageMessage('new', '')).toBeNull()
    expect(stageMessage('quoted', '')).toBeNull()
  })
})

describe('csat reply ids', () => {
  it('round-trips the rating and the card', () => {
    expect(parseCsatReplyId(csatReplyId('mal', 'deal-123'))).toEqual({ key: 'mal', dealId: 'deal-123' })
    expect(parseCsatReplyId('followup_yes:abc')).toBeNull()
  })
})
