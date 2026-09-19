import { useEffect, useState } from 'react'

const SKINS = [
  { id: 'quiet', label: 'Quiet' },
  { id: 'brutal', label: 'Bold' },
  { id: 'soft', label: 'Soft' },
] as const

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

/**
 * A per-viewer preference, kept in this browser only. It is not part of the
 * reader's library and never leaves the machine — which is why the intake
 * copy says the *library* is never uploaded or stored, rather than making a
 * blanket claim this would contradict.
 */
export function SkinPicker() {
  const [skin, setSkin] = useState<Skin>(stored)

  useEffect(() => {
    document.documentElement.dataset.skin = skin
    try {
      localStorage.setItem(KEY, skin)
    } catch {
      // Preference just will not persist. The page still looks right.
    }
  }, [skin])

  return (
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
  )
}
