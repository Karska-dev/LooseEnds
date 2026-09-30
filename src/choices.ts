/**
 * The reader's own choices about their series — favourites and set aside —
 * remembered in this browser. Nothing here ever leaves it: localStorage, not
 * a cookie, because a cookie would ride along on every request to the Worker.
 *
 * Every function is pure: it takes the saved choices and returns new ones.
 * Reading and writing storage lives in useChoices.ts.
 */

export const MAX_FAVOURITES = 5

export const STORAGE_KEY = 'looseends:choices'

export interface Choices {
  /** Series keys, in the order they were hearted. */
  favourites: string[]
  /** Set aside by hand. */
  aside: string[]
  /**
   * Brought back by hand. Beats the automatic set-aside a lookup gives a
   * series abandoned part-way (a DNF), which would otherwise come back on
   * every visit.
   */
  back: string[]
}

export const NO_CHOICES: Choices = { favourites: [], aside: [], back: [] }

function keys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))]
}

/** Whatever is in storage, made safe: bad JSON or a bad shape is simply no choices. */
export function parseChoices(raw: string | null): Choices {
  if (!raw) return NO_CHOICES
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return NO_CHOICES
    const record = data as Record<string, unknown>
    return {
      // More than five can only come from a hand-edited value; keep the first five.
      favourites: keys(record.favourites).slice(0, MAX_FAVOURITES),
      aside: keys(record.aside),
      back: keys(record.back),
    }
  } catch {
    return NO_CHOICES
  }
}

export function serializeChoices(choices: Choices): string {
  return JSON.stringify({ v: 1, ...choices })
}

export function hasChoices(choices: Choices): boolean {
  return choices.favourites.length > 0 || choices.aside.length > 0 || choices.back.length > 0
}

/**
 * Favourites in the library that is open, in hearted order. Saved favourites
 * whose series is not in this library are neither shown nor counted.
 */
export function presentFavourites(choices: Choices, present: ReadonlySet<string>): string[] {
  return choices.favourites.filter((key) => present.has(key))
}

export function isFull(choices: Choices, present: ReadonlySet<string>): boolean {
  return presentFavourites(choices, present).length >= MAX_FAVOURITES
}

const without = (list: string[], key: string) => list.filter((item) => item !== key)
const withKey = (list: string[], key: string) => (list.includes(key) ? list : [...list, key])

/**
 * Hearting. Any change to the favourites saves only those in the open
 * library ("what you see is what you saved"), so favourites from another
 * export can never come back and push the total past five.
 *
 * A heart also brings the series back if it was set aside.
 */
export function addFavourite(choices: Choices, key: string, present: ReadonlySet<string>): Choices {
  const current = presentFavourites(choices, present)
  if (current.includes(key) || current.length >= MAX_FAVOURITES) return choices
  return {
    favourites: [...current, key],
    aside: without(choices.aside, key),
    back: withKey(choices.back, key),
  }
}

export function removeFavourite(choices: Choices, key: string, present: ReadonlySet<string>): Choices {
  if (!choices.favourites.includes(key)) return choices
  return { ...choices, favourites: without(presentFavourites(choices, present), key) }
}

/** Setting a favourite aside takes its heart away. */
export function setAside(choices: Choices, key: string, present: ReadonlySet<string>): Choices {
  const favourites = choices.favourites.includes(key)
    ? without(presentFavourites(choices, present), key)
    : choices.favourites
  return { favourites, aside: withKey(choices.aside, key), back: without(choices.back, key) }
}

export function bringBack(choices: Choices, key: string): Choices {
  return { ...choices, aside: without(choices.aside, key), back: withKey(choices.back, key) }
}

/**
 * Which series sit under Set aside: the lookup's own suggestions (`auto`) and
 * the reader's, minus anything brought back or hearted. The reader always
 * has the last word, and a favourite is never set aside.
 */
export function asideKeys(choices: Choices, auto: ReadonlySet<string>): Set<string> {
  const out = new Set([...auto, ...choices.aside])
  for (const key of choices.back) out.delete(key)
  for (const key of choices.favourites) out.delete(key)
  return out
}
