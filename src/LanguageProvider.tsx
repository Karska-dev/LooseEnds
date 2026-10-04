import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CATALOGUES, LANGUAGE_KEY, pickLanguage } from './i18n/index.ts'
import type { Lang } from './i18n/index.ts'
import { LanguageContext } from './language.ts'

function initial(): Lang {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(LANGUAGE_KEY)
  } catch {
    // Private windows and blocked site data both throw: go by the browser.
  }
  return pickLanguage(stored, navigator.languages ?? [navigator.language])
}

/**
 * Holds the language for the whole page (src/language.ts explains why a
 * context).
 *
 * The choice is saved only when the reader uses the switch. Until then the
 * browser's own setting decides on every visit, so changing that setting
 * still changes the page.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  // The function form of useState runs once, before the first paint, so the
  // page never shows English for a moment and then changes.
  const [lang, setLangState] = useState<Lang>(initial)

  // Screen readers pick the voice, and browsers the hyphenation and the
  // "translate this page?" offer, from <html lang>.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(LANGUAGE_KEY, next)
    } catch {
      // Not remembered this time; the page still changes language.
    }
  }, [])

  // Technique: memoisation. Every component that reads the context
  // re-renders when this object changes, so it is rebuilt only when the
  // language does, not on each render of the provider.
  const value = useMemo(() => ({ lang, t: CATALOGUES[lang], setLang }), [lang, setLang])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}
