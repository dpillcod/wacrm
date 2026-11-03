import { describe, expect, it } from 'vitest';
import { draftOrigin, parseDraftInput, readOrigin } from './drafts';

const base = { name: 'Lanzamiento Navidad', template_name: 'navidad_lanzamiento' };

describe('parseDraftInput', () => {
  it('accepts a full draft', () => {
    const r = parseDraftInput({
      ...base,
      template_language: 'es',
      header_image_url: 'https://ferrotiendaec.com/x.jpg',
      variables: ['{contact.name}', '5 %'],
      audience_tags: ['Clientes', 'Clientes', ' VIP '],
      text: 'Hola…',
      ref: 'NAV26-01',
    });
    expect('input' in r && r.input).toMatchObject({
      templateLanguage: 'es',
      headerImageUrl: 'https://ferrotiendaec.com/x.jpg',
      variables: { '1': { type: 'field', value: 'name' }, '2': { type: 'static', value: '5 %' } },
      audienceTags: ['Clientes', 'VIP'],
      ref: 'NAV26-01',
    });
  });

  it('rejects what a person could not send', () => {
    expect(parseDraftInput(null)).toHaveProperty('error');
    expect(parseDraftInput({ template_name: 'x' })).toHaveProperty('error');
    expect(parseDraftInput({ ...base, template_name: 'Navidad Promo' })).toHaveProperty('error');
    expect(parseDraftInput({ ...base, header_image_url: 'http://x.com/a.jpg' })).toHaveProperty('error');
    expect(parseDraftInput({ ...base, variables: ['ok', ''] })).toHaveProperty('error');
  });

  it('round-trips the origin', () => {
    const r = parseDraftInput({ ...base, audience_tags: ['VIP'], note: 'revisar' });
    if (!('input' in r)) throw new Error('expected input');
    expect(readOrigin(JSON.parse(JSON.stringify(draftOrigin(r.input, 'Publikt'))))).toEqual({
      source: 'Publikt',
      ref: null,
      note: 'revisar',
      text: null,
      headerMediaUrl: null,
      suggestedTags: ['VIP'],
    });
    expect(readOrigin(null)).toBeNull();
  });
});
