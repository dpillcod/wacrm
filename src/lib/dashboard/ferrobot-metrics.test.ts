import { describe, expect, it } from 'vitest'
import { ferrobotMetrics, firstResponseMinutes, type MessageRow } from './ferrobot-metrics'

const now = new Date('2026-11-19T20:00:00Z') // 15:00 in Ecuador

describe('ferrobot metrics', () => {
  it('counts per local day, conversations once a day, and hours', () => {
    const messages: MessageRow[] = [
      { conversation_id: 'a', sender_type: 'customer', created_at: '2026-11-19T14:00:00Z' }, // 9:00
      { conversation_id: 'a', sender_type: 'bot', created_at: '2026-11-19T14:00:30Z' },
      { conversation_id: 'a', sender_type: 'customer', created_at: '2026-11-19T14:05:00Z' },
      { conversation_id: 'b', sender_type: 'customer', created_at: '2026-11-19T03:00:00Z' }, // 22:00 on the 18th
    ]
    const m = ferrobotMetrics(
      {
        messages,
        whatsappOrders: [
          { at: '2026-11-19T15:00:00Z', botConfirmed: true, lines: ['2 Coca-Cola 3 litros'] },
          { at: '2026-11-19T16:00:00Z', botConfirmed: false, lines: ['1 coca-cola 3 litros'] },
        ],
        webOrders: [{ at: '2026-11-18T15:00:00Z', lines: ['1x Arroz'] }],
        handoffs: [
          { at: '2026-11-19T15:00:00Z', conversationId: 'a' },
          { at: '2026-11-19T15:10:00Z', conversationId: 'a' },
        ],
        lineTags: ['Línea: juguetes', 'Línea: juguetes', 'servicio-pintura', 'VIP'],
      },
      3,
      now,
      -5,
    )
    expect(m.days.map((d) => d.day)).toEqual(['2026-11-17', '2026-11-18', '2026-11-19'])
    expect(m.days[2]).toEqual({ day: '2026-11-19', conversations: 1, inbound_messages: 2, orders_whatsapp: 2, orders_web: 0, bot_orders: 1, handoffs: 1 })
    expect(m.days[1]).toMatchObject({ conversations: 1, inbound_messages: 1, orders_web: 1 })
    expect(m.top_products[0]).toEqual({ label: 'Coca-Cola 3 litros', count: 2 })
    expect(m.hours[9].inbound).toBe(2)
    expect(m.hours[22].inbound).toBe(1)
    expect(m.first_response_minutes).toBe(0.5)
    expect(m.lines).toEqual([{ line: 'juguetes', chats: 2 }, { line: 'servicio-pintura', chats: 1 }])
  })

  it('first response: median, unanswered ones left out', () => {
    expect(firstResponseMinutes([], -5)).toBeNull()
    expect(
      firstResponseMinutes(
        [
          { conversation_id: 'a', sender_type: 'customer', created_at: '2026-11-19T14:00:00Z' },
          { conversation_id: 'a', sender_type: 'agent', created_at: '2026-11-19T14:10:00Z' },
          { conversation_id: 'b', sender_type: 'customer', created_at: '2026-11-19T14:00:00Z' },
          { conversation_id: 'b', sender_type: 'bot', created_at: '2026-11-19T14:02:00Z' },
          { conversation_id: 'c', sender_type: 'customer', created_at: '2026-11-19T14:00:00Z' },
        ],
        -5,
      ),
    ).toBe(6)
  })
})
