import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

const SKINS = [
  { id: 'quiet', label: 'Quiet' },
  { id: 'brutal', label: 'Bold' },
  { id: 'soft', label: 'Soft' },
] as const

/* The circles run top to bottom from calm to loud. */
const DIAL_ORDER = ['quiet', 'soft', 'brutal'] as const

type Skin = (typeof SKINS)[number]['id']

const KEY = 'looseends:skin'

function stored(): Skin {
  try {
    const value = localStorage.getItem(KEY)
    if (SKINS.some((skin) => skin.id === value)) return value as Skin
  } catch {
    // Private windows and blocked site data both throw. Not worth a fuss
    // over a theme: fall back to the default.
  }
  return 'quiet'
}

function labelOf(id: Skin): string {
  return SKINS.find((skin) => skin.id === id)!.label
}

/**
 * A per-viewer preference, kept in this browser only. It is not part of the
 * reader's library and never leaves the machine — which is why the intake
 * copy says the *library* is never uploaded or stored, rather than making a
 * blanket claim this would contradict.
 *
 * Two controls, one state. At 900px and wider the three-word pill stays in
 * the window corner, where there is room for it. Below that, CSS hides the
 * pill and shows the dial: one round button in the masthead that drops three
 * small circles, one per look. Both are rendered so neither has to know the
 * viewport width.
 */
export function SkinPicker() {
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
      <div className="skins" role="group" aria-label="Appearance">
        {SKINS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={skin === option.id}
            onClick={() => setSkin(option.id)}
          >
            {option.label}
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
          aria-label={`Change look (now ${labelOf(skin)})`}
          aria-expanded={open}
          aria-controls={open ? 'skin-dots' : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M10 2a8 8 0 0 0 0 16z" fill="currentColor" />
          </svg>
        </button>
        {open && (
          <div
            id="skin-dots"
            className="skin-dots"
            role="radiogroup"
            aria-label="Look"
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
                aria-label={labelOf(id)}
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
