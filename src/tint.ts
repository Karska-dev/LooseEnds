/* The five state colours every skin defines, so a cover is at home in each. */
const TINTS = ['var(--primary)', 'var(--ok)', 'var(--warn)', 'var(--accent)', 'var(--ink-soft)']

/**
 * A made-up cover's tint, picked from a name (the same name is always the
 * same colour). Used by the AI tab's series covers and the year tab's books.
 *
 * Algorithm: a polynomial rolling hash (hash = hash × 31 + next letter), the
 * classic cheap way to turn a string into a number. It is deterministic,
 * which is the point: no colour has to be stored anywhere. `>>> 0` keeps
 * the number an unsigned 32-bit integer as it grows.
 *
 * Its own file because a component file that also exports a function cannot
 * be hot-reloaded in place.
 */
export function tintFor(name: string): string {
  let hash = 0
  for (const letter of name) hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) >>> 0
  return TINTS[hash % TINTS.length]!
}
