/**
 * The five state colours every look defines, so a cover is at home in each.
 * The order matters: `tintIndex` points into it, and the share picture
 * (shareCard.ts) draws the same index in its own palette, so a book's cover
 * is the same colour on the page and on the picture.
 */
export const TINTS = ['var(--primary)', 'var(--ok)', 'var(--warn)', 'var(--accent)', 'var(--ink-soft)']

/**
 * Which tint a name gets (the same name is always the same one). Used by
 * the AI tab's series covers, the year tab's books and the share picture.
 *
 * Algorithm: a polynomial rolling hash (hash = hash × 31 + next letter), the
 * classic cheap way to turn a string into a number. It is deterministic,
 * which is the point: no colour has to be stored anywhere. `>>> 0` keeps
 * the number an unsigned 32-bit integer as it grows.
 *
 * Its own file because a component file that also exports a function cannot
 * be hot-reloaded in place.
 */
export function tintIndex(name: string): number {
  let hash = 0
  for (const letter of name) hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) >>> 0
  return hash % TINTS.length
}

export function tintFor(name: string): string {
  return TINTS[tintIndex(name)]!
}
