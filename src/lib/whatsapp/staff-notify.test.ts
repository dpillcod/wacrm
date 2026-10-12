import { describe, expect, it } from 'vitest'
import { staffAlertText } from './staff-notify'

describe('staffAlertText', () => {
  it('keeps the order on several lines and links the chat', () => {
    expect(
      staffAlertText({
        contactName: 'Ana Torres',
        summary: '📞 0991234567\nPedido N° 0016\n1. 2 × LECHE · $0,99 c/u',
        link: 'https://crm.example.com/inbox?c=abc',
      }),
    ).toBe(
      '🔔 *Aviso para el personal* — Ana Torres\n\n📞 0991234567\nPedido N° 0016\n1. 2 × LECHE · $0,99 c/u\n\n👉 Abrir en el CRM: https://crm.example.com/inbox?c=abc',
    )
  })
  it('works without a name or link', () => {
    expect(staffAlertText({ contactName: ' ', summary: '' })).toBe('🔔 *Aviso para el personal*\n\n(sin detalle)')
  })
})
