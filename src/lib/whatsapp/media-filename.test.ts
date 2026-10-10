import { describe, expect, it } from 'vitest'
import { mediaFilename } from './media-filename'

describe('mediaFilename', () => {
  it('keeps the original name', () => {
    expect(mediaFilename('Tarea de matemáticas.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '123')).toBe(
      'Tarea de matemáticas.docx',
    )
  })
  it('adds the extension when the name has none', () => {
    expect(mediaFilename('copias para imprimir', 'application/pdf', '123')).toBe('copias para imprimir.pdf')
  })
  it('builds a name from the media id when there is none', () => {
    expect(mediaFilename(null, 'image/jpeg; charset=binary', '1234567890123')).toBe('archivo-67890123.jpg')
    expect(mediaFilename('', 'application/x-unknown', 'abc')).toBe('archivo-abc')
  })
  it('strips characters a file name cannot have', () => {
    expect(mediaFilename('a/b:c?.pdf', 'application/pdf', '1')).toBe('a_b_c_.pdf')
  })
})
