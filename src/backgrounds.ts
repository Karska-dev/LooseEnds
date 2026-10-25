/**
 * The photographs behind a share picture, listed in public/backgrounds.json.
 *
 * Why a manifest and not a list in the code: adding a background is then one
 * file and one line, and the photographer's name travels with the photo it
 * belongs to. The file is read like the saved answers are: defensively, so a
 * bad entry is skipped and a bad file means "no backgrounds", never a crash.
 */
export interface Background {
  id: string
  /** Under public/, e.g. "backgrounds/library.jpg". */
  file: string
  /** Dark photographs get the dark palette, so the text stays readable. */
  dark: boolean
  /** Named on the picture, in the share text and on the credits screen. Generated backgrounds have none. */
  photographer?: string
}

export const BACKGROUNDS_URL = '/backgrounds.json'

/** Only plain files inside backgrounds/: the manifest is data, never a path to walk out of the folder. */
const SAFE_FILE = /^backgrounds\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|svg)$/

export function parseBackgrounds(value: unknown): Background[] {
  const list = (value as { backgrounds?: unknown } | null)?.backgrounds
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: Background[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { id, file, dark, photographer } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    if (typeof file !== 'string' || !SAFE_FILE.test(file) || file.includes('..')) continue
    seen.add(id)
    const name = typeof photographer === 'string' ? photographer.trim() : ''
    out.push({ id, file, dark: dark === true, ...(name ? { photographer: name } : {}) })
  }
  return out
}
