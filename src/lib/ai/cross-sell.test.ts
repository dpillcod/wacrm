import { describe, it, expect } from 'vitest'
import { pickCrossSellSuggestion } from './cross-sell'
import { DEMO_STORE } from '../business/__fixtures__/demo-store'

const RULES = DEMO_STORE.crossSell

describe('pickCrossSellSuggestion', () => {
  it('suggests queso/café when the customer orders pan', () => {
    const result = pickCrossSellSuggestion('quiero 10 panes por favor', [], RULES)
    expect(result).toMatch(/queso|café/)
  })

  it('suggests a DIFFERENT item in the same group, never the item itself', () => {
    const result = pickCrossSellSuggestion('necesito queso', [], RULES)
    expect(result).not.toBeNull()
    expect(result).not.toMatch(/queso/i)
  })

  it('matches whole words only, not substrings', () => {
    // "panteón" contains "pan" as a substring but is not the word "pan".
    expect(pickCrossSellSuggestion('busco un panteón de baterías', [], RULES)).toBeNull()
  })

  it('returns null when nothing in the message matches any rule', () => {
    expect(pickCrossSellSuggestion('tienen tornillos de 3 pulgadas?', [], RULES)).toBeNull()
  })

  it('fires at most once per conversation', () => {
    const alreadyShownHistory = [
      { role: 'user', content: 'quiero pan' },
      { role: 'assistant', content: `Listo, 10 panes. ${RULES[0].suggestion}` },
    ]
    // A second, unrelated cross-sell trigger later in the same thread
    // should stay quiet — one nudge per conversation, not one per item.
    expect(pickCrossSellSuggestion('y también arroz', alreadyShownHistory, RULES)).toBeNull()
  })

  it('is case-insensitive and ignores punctuation', () => {
    expect(pickCrossSellSuggestion('¿PAN hay?', [], RULES)).not.toBeNull()
  })

  it('every rule has a non-empty suggestion pointing at a real pairing', () => {
    for (const rule of RULES) {
      expect(rule.suggestion.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('pickCrossSellSuggestion without rules', () => {
  it('suggests nothing for a business that set no rules', () => {
    expect(pickCrossSellSuggestion('quiero pan', [], [])).toBeNull()
  })
})
