import { createContext, useContext } from 'react'
import { en } from './i18n/en.ts'
import type { Lang, Messages } from './i18n/index.ts'

export interface Language {
  lang: Lang
  /** The words of that language. `t` is the usual short name for it. */
  t: Messages
  setLang: (lang: Lang) => void
}

/**
 * Pattern: React context. A dozen components, some of them five levels
 * down, need the words of the current language. Passing `t` through every
 * component in between ("prop drilling") would put a parameter on components
 * that never use it. A context lets any component ask for it directly, and
 * all of them re-render when the language changes.
 *
 * The default value is English, so a component rendered outside the
 * provider, in a test for instance, still has words.
 *
 * The context and its hook live here, apart from LanguageProvider.tsx: a
 * file that exports anything besides components cannot be hot-reloaded in
 * place.
 */
export const LanguageContext = createContext<Language>({ lang: 'en', t: en, setLang: () => {} })

export function useLanguage(): Language {
  return useContext(LanguageContext)
}
