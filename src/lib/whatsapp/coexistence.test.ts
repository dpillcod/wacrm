import { describe, expect, it } from 'vitest'
import { describeCoexMessage, parseHistory, parseMessageEchoes, parseStateSync } from './coexistence'

const metadata = { display_phone_number: '593993679794', phone_number_id: '123' }

describe('parseMessageEchoes', () => {
  it('turns a message sent from the phone app into an outbound message to the customer', () => {
    const out = parseMessageEchoes({
      message_echoes: [
        { from: '593993679794', to: '593981234567', id: 'wamid.A', timestamp: '1761600000', type: 'text', text: { body: 'Ya le envío' } },
      ],
    })
    expect(out).toEqual([
      {
        id: 'wamid.A',
        customerPhone: '593981234567',
        direction: 'outbound',
        createdAt: new Date(1761600000 * 1000).toISOString(),
        contentType: 'text',
        text: 'Ya le envío',
      },
    ])
  })

  it('skips echoes without an id', () => {
    expect(parseMessageEchoes({ message_echoes: [{ to: '5939', type: 'text' }] })).toEqual([])
  })
})

describe('parseHistory', () => {
  it('tells business and customer messages apart by the business number', () => {
    const chunk = parseHistory({
      metadata,
      history: [
        {
          metadata: { progress: 40 },
          threads: [
            {
              id: '593981234567',
              messages: [
                { from: '593981234567', id: 'h1', timestamp: '1700000000', type: 'text', text: { body: 'Hola' } },
                { from: '593993679794', to: '593981234567', id: 'h2', timestamp: '1700000060', type: 'image', image: {} },
              ],
            },
          ],
        },
      ],
    })
    expect(chunk.progress).toBe(40)
    expect(chunk.error).toBeNull()
    expect(chunk.messages.map((m) => [m.id, m.direction, m.customerPhone, m.text])).toEqual([
      ['h1', 'inbound', '593981234567', 'Hola'],
      ['h2', 'outbound', '593981234567', '📷 Imagen'],
    ])
  })

  it('reports a declined history share', () => {
    const chunk = parseHistory({ metadata, history: [{ errors: [{ code: 2593109, title: 'History sharing declined' }] }] })
    expect(chunk.messages).toEqual([])
    expect(chunk.error).toContain('2593109')
  })
})

describe('parseStateSync', () => {
  it('reads added and removed contacts', () => {
    expect(
      parseStateSync({
        state_sync: [
          { type: 'contact', action: 'add', contact: { full_name: 'Rosa Duchi', first_name: 'Rosa', phone_number: '+593 98 123 4567' } },
          { type: 'contact', action: 'remove', contact: { phone_number: '593980000000' } },
          { type: 'other' },
        ],
      }),
    ).toEqual([
      { phone: '593981234567', name: 'Rosa Duchi', action: 'add' },
      { phone: '593980000000', name: '', action: 'remove' },
    ])
  })
})

describe('describeCoexMessage', () => {
  it('builds a maps link for a location', () => {
    expect(describeCoexMessage({ type: 'location', location: { latitude: -2.9, longitude: -79.0 } })).toEqual({
      contentType: 'location',
      text: '📍 https://maps.google.com/?q=-2.9,-79',
    })
  })
  it('falls back to the file name for documents', () => {
    expect(describeCoexMessage({ type: 'document', document: { filename: 'lista.pdf' } }).text).toBe('📄 lista.pdf')
  })
})
