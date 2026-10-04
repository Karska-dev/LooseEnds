import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useLanguage } from './language.ts'

/* The pill's order. The names are in the catalogue (masthead.skins). */
const SKINS = ['quiet', 'brutal', 'soft'] as const

/* The circles run top to bottom from calm to loud. */
const DIAL_ORDER = ['quiet', 'soft', 'brutal'] as const

type Skin = (typeof SKINS)[number]

const KEY = 'looseends:skin'

function stored(): Skin {
  try {
    const value = localStorage.getItem(KEY)
    if (SKINS.some((skin) => skin === value)) return value as Skin
  } catch {
    // Private windows and blocked site data both throw. Not worth a fuss
    // over a theme: fall back to the default.
  }
  return 'quiet'
}

/**
 * A per-viewer preference, kept in this browser only. It is not part of the
 * reader's library and never leaves the machine — which is why the intake
 * copy says the *library* is never uploaded or stored, rather than making a
 * blanket claim this would contradict.
 *
 * Two controls, one state. At 900px and wider the three-word pill sits in
 * the window's top corner, where there is room for it. Below that, CSS hides the
 * pill and shows the dial: one round button in the masthead that drops three
 * small circles, one per look. Both are rendered so neither has to know the
 * viewport width.
 */
export function SkinPicker() {
  const { t } = useLanguage()
  const labels = t.masthead.skins
  const [skin, setSkin] = useState<Skin>(stored)
  const [open, setOpen] = useState(false)
  const dialRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dotRefs = useRef<Partial<Record<Skin, HTMLButtonElement | null>>>({})

  useEffect(() => {
    document.documentElement.dataset.skin = skin
    try {
      localStorage.setItem(KEY, skin)
    } catch {
      // Preference just will not persist. The page still looks right.
    }
  }, [skin])

  // Open: focus lands on the current look. Any press outside folds it away.
  useEffect(() => {
    if (!open) return
    dotRefs.current[skin]?.focus()
    const away = (event: PointerEvent) => {
      if (!dialRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
    // Only on opening: moving between circles must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function close() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function pick(id: Skin) {
    setSkin(id)
    close()
  }

  function onDotsKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
      : 0
    if (!step) return
    event.preventDefault()
    const here = DIAL_ORDER.indexOf(document.activeElement?.getAttribute('data-look') as Skin)
    const next = DIAL_ORDER[(Math.max(here, 0) + step + DIAL_ORDER.length) % DIAL_ORDER.length]
    dotRefs.current[next]?.focus()
  }

  return (
    <>
      <div className="skins" role="group" aria-label={t.masthead.appearance}>
        {SKINS.map((id) => (
          <button key={id} type="button" aria-pressed={skin === id} onClick={() => setSkin(id)}>
            {labels[id]}
          </button>
        ))}
      </div>

      <div
        className="skin-dial"
        ref={dialRef}
        onBlur={(event) => {
          // Tabbing out of the circles folds them away too.
          if (open && !dialRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          className="skin-dial-button"
          aria-label={t.masthead.changeLook(labels[skin])}
          aria-expanded={open}
          aria-controls={open ? 'skin-dots' : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          {/* A painter's palette. The half-filled circle that was here is the
              usual sign for a light/dark switch, which this is not: light or
              dark follows the device, and this button changes the look. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="21"
            height="21"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          >
            <path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.9-.9 1.9-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.7-.5-1.1 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
            <circle cx="7.6" cy="12" r="1.25" fill="currentColor" stroke="none" />
            <circle cx="10" cy="8" r="1.25" fill="currentColor" stroke="none" />
            <circle cx="14.6" cy="7.8" r="1.25" fill="currentColor" stroke="none" />
          </svg>
        </button>
        {open && (
          <div
            id="skin-dots"
            className="skin-dots"
            role="radiogroup"
            aria-label={t.masthead.look}
            onKeyDown={onDotsKey}
          >
            {DIAL_ORDER.map((id) => (
              <button
                key={id}
                ref={(node) => {
                  dotRefs.current[id] = node
                }}
                type="button"
                role="radio"
                aria-checked={skin === id}
                aria-label={labels[id]}
                tabIndex={skin === id ? 0 : -1}
                data-look={id}
                className={`skin-dot skin-dot-${id}`}
                onClick={() => pick(id)}
              >
                <span aria-hidden="true">Aa</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
