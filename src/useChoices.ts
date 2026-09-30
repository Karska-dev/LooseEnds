import { useCallback, useState } from 'react'
import { NO_CHOICES, STORAGE_KEY, parseChoices, serializeChoices } from './choices'
import type { Choices } from './choices'

function load(): Choices {
  try {
    return parseChoices(localStorage.getItem(STORAGE_KEY))
  } catch {
    // Private windows and blocked site data both throw: start empty.
    return NO_CHOICES
  }
}

function save(choices: Choices) {
  try {
    if (choices.favourites.length || choices.aside.length || choices.back.length) {
      localStorage.setItem(STORAGE_KEY, serializeChoices(choices))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Not remembered this time; the page still works for this visit.
  }
}

/** Favourites and set aside, read once on load and written on every change. */
export function useChoices(): [Choices, (update: (current: Choices) => Choices) => void, () => void] {
  const [choices, setChoices] = useState<Choices>(load)

  const update = useCallback((change: (current: Choices) => Choices) => {
    setChoices((current) => {
      const next = change(current)
      if (next !== current) save(next)
      return next
    })
  }, [])

  const forget = useCallback(() => {
    save(NO_CHOICES)
    setChoices(NO_CHOICES)
  }, [])

  return [choices, update, forget]
}
