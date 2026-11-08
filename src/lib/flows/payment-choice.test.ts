import { describe, expect, it } from 'vitest'
import { paymentChoiceOf } from './engine'
import { isPriceQuestion } from './price-question'

describe('paymentChoiceOf', () => {
  it('reads a short payment answer', () => {
    expect(paymentChoiceOf('En efectivo')).toBe('en efectivo')
    expect(paymentChoiceOf('por transferencia porfa')).toBe('por transferencia')
    expect(paymentChoiceOf('con tarjeta')).toBe('con tarjeta')
  })
  it('ignores questions and longer messages', () => {
    expect(paymentChoiceOf('¿Aceptan tarjeta?')).toBeNull()
    expect(paymentChoiceOf('Listo')).toBeNull()
    expect(paymentChoiceOf('le pago en efectivo cuando llegue el motorizado a mi casa en la tarde')).toBeNull()
  })
})

describe('isPriceQuestion (Nov 5 chats)', () => {
  it('catches the ways customers asked', () => {
    expect(isPriceQuestion('Cuál es el valor?')).toBe(true)
    expect(isPriceQuestion('Quiero saber precio')).toBe(true)
    expect(isPriceQuestion('Mándeme precio y moedelos  porfa')).toBe(true)
    expect(isPriceQuestion('2 aguas grandes')).toBe(false)
  })
})
