// ============================================================
// A file name for a customer's media when the team opens or saves it:
// the original name when WhatsApp gave one, otherwise one built from
// the media id — always with the extension that matches its type, so
// the computer knows which program opens it ("1234" → "archivo-1234.pdf").
// ============================================================

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
}

export function extensionFor(mime: string): string | null {
  return EXTENSIONS[mime.split(';')[0].trim().toLowerCase()] ?? null
}

export function mediaFilename(name: string | null | undefined, mime: string, mediaId: string): string {
  const ext = extensionFor(mime)
  const clean = (name ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (clean) {
    return ext && !clean.toLowerCase().endsWith(`.${ext}`) && !/\.[a-z0-9]{2,5}$/i.test(clean) ? `${clean}.${ext}` : clean
  }
  return `archivo-${mediaId.slice(-8)}${ext ? `.${ext}` : ''}`
}
