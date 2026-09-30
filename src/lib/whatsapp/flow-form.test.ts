import { describe, expect, it } from 'vitest'
import { formatFormReply, parseFormReply } from './flow-form'

describe('parseFormReply', () => {
  it('keeps the form fields and drops the flow token', () => {
    expect(
      parseFormReply('{"flow_token":"run-1","nombre":" Ana Pérez ","cedula":"0105280069","correo":"ana@x.com"}'),
    ).toEqual({ nombre: 'Ana Pérez', cedula: '0105280069', correo: 'ana@x.com' })
  })

  it('returns null for empty or broken payloads', () => {
    expect(parseFormReply('{"flow_token":"x"}')).toBeNull()
    expect(parseFormReply('no es json')).toBeNull()
    expect(parseFormReply(undefined)).toBeNull()
  })
})

describe('formatFormReply', () => {
  it('uses display labels when given', () => {
    expect(formatFormReply({ nombre: 'Ana', cedula: '0105' }, { nombre: 'Nombre', cedula: 'Cédula o RUC' })).toBe(
      'Nombre: Ana\nCédula o RUC: 0105',
    )
  })
})
