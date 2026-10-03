import { LANGUAGES } from './i18n/index.ts'
import { useLanguage } from './language.ts'

/**
 * EN / УКР, next to the look picker and built like it: a pill with both
 * languages at 900px and wider, one round button below that (see the notes
 * on SkinPicker). With only two languages the round button needs no menu:
 * it shows the other language and one press switches to it.
 *
 * Each label carries its own `lang`, so a screen reader says "УКР" with a
 * Ukrainian voice even while the page is in English.
 */
export function LanguagePicker() {
  const { lang, t, setLang } = useLanguage()
  const other = LANGUAGES.find((language) => language.id !== lang)!

  return (
    <>
      <div className="skins langs" role="group" aria-label={t.masthead.language}>
        {LANGUAGES.map((language) => (
          <button
            key={language.id}
            type="button"
            lang={language.id}
            aria-pressed={lang === language.id}
            aria-label={language.name}
            onClick={() => setLang(language.id)}
          >
            {language.short}
          </button>
        ))}
      </div>

      {/* Reuses the dial's round button, so it follows each look for free. */}
      <div className="skin-dial lang-dial">
        <button
          type="button"
          className="skin-dial-button"
          lang={other.id}
          aria-label={other.switchTo}
          onClick={() => setLang(other.id)}
        >
          {other.short}
        </button>
      </div>
    </>
  )
}
