import { describe, expect, it } from 'vitest'
import { claimAckId, claimBody, claimedText, claimTitle, localClock, parseClaim, parseStaffAckId, staffAlertText } from './staff-notify'

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

describe('"Yo lo atiendo" (claim a customer)', () => {
  it('the button carries the conversation; the plain Recibido still works', () => {
    expect(claimAckId('abc-123')).toBe('staff_ack:abc-123')
    expect(parseStaffAckId('staff_ack:abc-123')).toEqual({ conversationId: 'abc-123' })
    expect(parseStaffAckId('staff_ack')).toEqual({ conversationId: null })
    expect(parseStaffAckId('csat_good')).toBeNull()
    expect(parseStaffAckId(null)).toBeNull()
  })

  it('reads back who took the customer', () => {
    const claim = parseClaim({
      title: claimTitle('Diego', 'Ana López'),
      body: claimBody('Diego', '593981414182'),
      created_at: '2026-11-17T15:00:00Z',
    })
    expect(claim).toEqual({ phone: '593981414182', who: 'Diego', at: '2026-11-17T15:00:00Z' })
    expect(parseClaim({ title: '🧾 Pedido N° 0041', body: null, created_at: '' })).toBeNull()
  })

  it('tells the rest of the team, in local time', () => {
    const text = claimedText('Diego', 'Ana', '0991234567')
    expect(text).toContain('🙋 *Diego atiende a Ana* (0991234567).')
    expect(text).toContain('*Ayúdenle a que no se le olvide.*')
    expect(localClock('2026-11-17T15:05:00Z', -5)).toBe('10:05')
  })
})
