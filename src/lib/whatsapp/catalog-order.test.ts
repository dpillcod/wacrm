import { describe, expect, it } from 'vitest'
import {
  buildOrderItems,
  formatOrderLines,
  formatOrderSummary,
} from './catalog-order'

const payload = {
  catalog_id: 'cat-1',
  product_items: [
    { product_retailer_id: 'SKU1', quantity: 2, item_price: 2.1, currency: 'USD' },
    { product_retailer_id: 'SKU2', quantity: '1', item_price: '0.25', currency: 'USD' },
  ],
}

describe('buildOrderItems', () => {
  it('uses the synced catalog name, falling back to the retailer id', () => {
    const items = buildOrderItems(payload, new Map([['SKU1', 'COCA COLA 2L']]))
    expect(items.map((i) => i.name)).toEqual(['COCA COLA 2L', 'SKU2'])
  })

  it('parses string quantities and prices from the webhook', () => {
    const items = buildOrderItems(payload, new Map())
    expect(items[1]).toMatchObject({ quantity: 1, unit_price: 0.25 })
  })

  it('treats a missing price as unknown, not zero', () => {
    const items = buildOrderItems(
      { product_items: [{ product_retailer_id: 'X', quantity: 3 }] },
      new Map(),
    )
    expect(items[0].unit_price).toBeNull()
  })
})

describe('formatting', () => {
  const items = buildOrderItems(payload, new Map([['SKU1', 'COCA COLA 2L'], ['SKU2', 'PIPAS']]))

  it('renders one line per item with the unit price', () => {
    expect(formatOrderLines(items)).toBe('2 x COCA COLA 2L ($2.10 c/u)\n1 x PIPAS ($0.25 c/u)')
  })

  it('adds a total only when every item is priced', () => {
    expect(formatOrderSummary(items)).toContain('Total: $4.45')
    const unpriced = buildOrderItems(
      { product_items: [{ product_retailer_id: 'X', quantity: 1 }] },
      new Map(),
    )
    expect(formatOrderSummary(unpriced)).not.toContain('Total')
  })

  it('includes the customer note when present', () => {
    expect(formatOrderSummary(items, ' sin hielo ')).toContain('Nota del cliente: sin hielo')
  })
})
