import { useEffect, useState } from 'react'
import { BACKGROUNDS_URL, parseBackgrounds } from './backgrounds'
import type { Background } from './backgrounds'

/** The backgrounds on offer. Empty until loaded, and empty if the file cannot be had: the picture is then plain. */
export function useBackgrounds(): Background[] {
  const [list, setList] = useState<Background[]>([])
  useEffect(() => {
    let current = true
    fetch(BACKGROUNDS_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => current && setList(parseBackgrounds(json)))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])
  return list
}
