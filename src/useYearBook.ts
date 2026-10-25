import { useCallback, useState } from 'react'
import { STORAGE_KEY, decisionsFor, parseYearBook, serializeYearBook, withDecisions } from './yearBook'
import type { YearBook, YearDecisions } from './yearBook'

function load(): YearBook {
  try {
    return parseYearBook(localStorage.getItem(STORAGE_KEY))
  } catch {
    // Private windows and blocked site data both throw: start with no decisions.
    return {}
  }
}

function save(yearBook: YearBook) {
  try {
    if (Object.keys(yearBook).length > 0) localStorage.setItem(STORAGE_KEY, serializeYearBook(yearBook))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Not remembered this time; the page still works for this visit.
  }
}

/** One year's decisions, read once on load and written on every change. */
export function useYearBook(
  year: number,
): [YearDecisions, (update: (current: YearDecisions) => YearDecisions) => void, () => void] {
  const [yearBook, setYearBook] = useState<YearBook>(load)

  const update = useCallback(
    (change: (current: YearDecisions) => YearDecisions) => {
      setYearBook((current) => {
        const before = decisionsFor(current, year)
        const after = change(before)
        if (after === before) return current
        const next = withDecisions(current, year, after)
        save(next)
        return next
      })
    },
    [year],
  )

  const forget = useCallback(() => {
    setYearBook((current) => {
      const next = withDecisions(current, year, { months: {}, duels: {} })
      save(next)
      return next
    })
  }, [year])

  return [decisionsFor(yearBook, year), update, forget]
}
