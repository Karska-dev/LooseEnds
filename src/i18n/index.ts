import { en } from './en.ts'
import { uk } from './uk.ts'
import type { Messages } from './en.ts'

export type { FileMessage, Messages } from './en.ts'

export type Lang = 'en' | 'uk'

export const CATALOGUES: Record<Lang, Messages> = { en, uk }

/**
 * What the switch shows. Each language is named in itself, not in the
 * language the page is in right now: someone looking for Ukrainian on an
 * English page is looking for the word «УКР», not "Ukrainian".
 */
export const LANGUAGES: readonly { id: Lang; short: string; name: string; switchTo: string }[] = [
  { id: 'en', short: 'EN', name: 'English', switchTo: 'Switch to English' },
  { id: 'uk', short: 'УКР', name: 'Українська', switchTo: 'Перейти на українську' },
]

export const LANGUAGE_KEY = 'looseends:lang'

const isLang = (value: unknown): value is Lang => value === 'en' || value === 'uk'

/**
 * Which language the page opens in.
 *
 *   1. What the reader chose with the switch, if they ever did.
 *   2. Otherwise the first language in the browser's list that the page has.
 *   3. Otherwise English.
 *
 * Algorithm: language negotiation, in its simplest form. A browser sends an
 * ordered list of what its user reads ("uk-UA", "uk", "en-US", "en"); only
 * the part before the hyphen is compared, so "uk-UA" matches "uk". The full
 * version (RFC 4647) also handles scripts and regions, which two languages
 * do not need.
 *
 * Pattern: a pure function. Storage and the browser are read by the caller
 * and passed in, so this can be tested without either.
 */
export function pickLanguage(stored: string | null, preferred: readonly string[]): Lang {
  if (isLang(stored)) return stored
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLang(base)) return base
  }
  return 'en'
}
