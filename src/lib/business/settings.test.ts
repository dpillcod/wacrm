import { describe, expect, it } from 'vitest'
import { DEFAULT_BUSINESS_SETTINGS, mergeSettings, renderText, sanitizeSettings } from './settings'

describe('mergeSettings', () => {
  it('keeps defaults for missing keys and merges nested objects', () => {
    const s = mergeSettings(DEFAULT_BUSINESS_SETTINGS, { name: 'X', texts: { idleNudge: 'hola' } })
    expect(s.name).toBe('X')
    expect(s.texts.idleNudge).toBe('hola')
    expect(s.texts.captureFailed).toBe(DEFAULT_BUSINESS_SETTINGS.texts.captureFailed)
    expect(s.orderBoard.pipelineName).toBe('Pedidos')
  })

  it('ignores values of the wrong type', () => {
    const s = mergeSettings(DEFAULT_BUSINESS_SETTINGS, { utcOffsetHours: '-5', staffPhones: 'x', texts: 3 })
    expect(s.utcOffsetHours).toBe(-5)
    expect(s.staffPhones).toEqual([])
    expect(s.texts).toEqual(DEFAULT_BUSINESS_SETTINGS.texts)
  })

  it('falls back to the defaults for garbage', () => {
    expect(mergeSettings(DEFAULT_BUSINESS_SETTINGS, null)).toEqual(DEFAULT_BUSINESS_SETTINGS)
    expect(mergeSettings(DEFAULT_BUSINESS_SETTINGS, [1, 2])).toEqual(DEFAULT_BUSINESS_SETTINGS)
  })
})

describe('sanitizeSettings', () => {
  it('checks list items, not just that a list is a list', () => {
    const s = sanitizeSettings({
      openingHours: [[8, 22], [7, 'x'], [22, 7], null, [0, 24], [7, 22], [7, 22], [1, 2]],
      staffPhones: [' 0999 ', '', 5],
      crossSell: [{ keyword: ' Pan ', suggestion: 'queso' }, { keyword: '', suggestion: 'x' }, 'x'],
      phoneCountryCode: '+593',
      utcOffsetHours: 99,
    })
    expect(s.openingHours).toEqual([[8, 22], null, null, null, [0, 24], [7, 22], [7, 22]])
    expect(s.staffPhones).toEqual(['0999'])
    expect(s.crossSell).toEqual([{ keyword: 'pan', suggestion: 'queso' }])
    expect(s.phoneCountryCode).toBe('593')
    expect(s.utcOffsetHours).toBe(14)
  })

  it('pads a partial week as closed, keeps an empty one as always open', () => {
    expect(sanitizeSettings({ openingHours: [[8, 12]] }).openingHours).toHaveLength(7)
    expect(sanitizeSettings({ openingHours: [] }).openingHours).toEqual([])
  })
})

describe('renderText', () => {
  it('fills placeholders and tidies the gap an empty one leaves', () => {
    expect(renderText('Su pedido {pedido} está listo.', { pedido: 'N° 5' })).toBe('Su pedido N° 5 está listo.')
    expect(renderText('Su pedido {pedido} está listo.', { pedido: '' })).toBe('Su pedido está listo.')
    expect(renderText('Pedido {pedido}, gracias', {})).toBe('Pedido, gracias')
  })
})
