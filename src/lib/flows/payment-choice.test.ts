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

describe('Nov 8 chats', () => {
  it('asks for photos → catalog', async () => {
    const { isShowMeRequest, isUrgentAvailability } = await import('./engine')
    expect(isShowMeRequest('Tienes fotos y si haces delivery?')).toBe(true)
    expect(isShowMeRequest('Mejor que me envíe delivery si me puede enviar Fotitos por favor con los precios y una cuenta para poder depositarle')).toBe(true)
    expect(isShowMeRequest('le envío foto de mi lista')).toBe(false)
    expect(isUrgentAvailability('Pero dispone en este momento\nPorque lo necesito hoy')).toBe(true)
    expect(isUrgentAvailability('2 sacos de cemento')).toBe(false)
    expect(isPriceQuestion('Y los precios por favor?')).toBe(true)
  })
})

describe('isPriceQuestion (Nov 10 chats)', () => {
  it('reads "¿qué costo tiene?" as a price question', () => {
    expect(isPriceQuestion('No, que costo tiene')).toBe(true)
    expect(isPriceQuestion('Y el costo?')).toBe(true)
    expect(isPriceQuestion('1 chapa para dormitorio')).toBe(false)
  })
})
