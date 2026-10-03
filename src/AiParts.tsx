import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * The small things only the AI tab draws: a stand-in cover, the link to the
 * page a book was found on, the audiobook popover, and the "?" for a date
 * no page gave.
 */

/* The five state colours every skin defines, so a cover is at home in each. */
const TINTS = ['var(--primary)', 'var(--ok)', 'var(--warn)', 'var(--accent)', 'var(--ink-soft)']

/**
 * The AI lookup finds no cover art, and an empty slot would read as a
 * failure. So a looked-up series gets a made-up cover: its initial on a tint
 * picked from its name (the same series is always the same colour), with a
 * small spark that says where the list came from.
 *
 * Algorithm: a polynomial rolling hash (hash = hash × 31 + next letter), the
 * classic cheap way to turn a string into a number. It is deterministic,
 * which is the point: no colour has to be stored anywhere. `>>> 0` keeps
 * the number an unsigned 32-bit integer as it grows.
 */
export function AiCover({ name }: { name: string }) {
  let hash = 0
  for (const letter of name) hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) >>> 0
  const initial = Array.from(name.replace(/^(?:the|an?)\s+/i, ''))[0]?.toUpperCase() ?? ''
  return (
    <span
      className="cover cover-lg ai-cover"
      style={{ '--tint': TINTS[hash % TINTS.length] } as CSSProperties}
      aria-hidden="true"
    >
      <span className="ai-initial">{initial}</span>
      <svg className="ai-spark" viewBox="0 0 12 12">
        <path d="M6 0.5 L7.2 4.8 L11.5 6 L7.2 7.2 L6 11.5 L4.8 7.2 L0.5 6 L4.8 4.8 Z" />
      </svg>
    </span>
  )
}

/** Where a cover will go, for a series with no list yet. */
export function NoCover() {
  return <span className="cover cover-lg no-cover" aria-hidden="true" />
}

/**
 * "author.example": enough to judge a source at a glance. Null for anything
 * that is not an ordinary web address — these come off the open web, and a
 * link is only made from one a browser would open as a page.
 *
 * Security: an allow-list. Only http and https are accepted, everything
 * else is refused, rather than a list of bad schemes being blocked. A
 * `javascript:` address put in an href would run as code when clicked.
 */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The page a book, or a reading order, was read from. */
export function SourceLink({ url }: { url: string }) {
  const host = hostOf(url)
  if (!host) return null
  return (
    <a className="src" href={url} target="_blank" rel="noopener noreferrer">
      {host}
      <span aria-hidden="true"> &#8599;</span>
    </a>
  )
}

/** A release date no page gave. Not "no date yet": that would read as unannounced. */
export function UnknownDate() {
  return (
    <span
      className="unknown"
      role="img"
      title="Release date not found on the source page"
      aria-label="Release date not found on the source page"
    >
      ?
    </span>
  )
}

function Headphones() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4.5" height="7" rx="1.5" />
      <rect x="16.5" y="14" width="4.5" height="7" rx="1.5" />
    </svg>
  )
}

/**
 * The headphones on one book. When the page that listed the book also gave
 * the audiobook's year or publisher, the mark is a button and they open in a
 * small note: on hover with a mouse, on focus with a keyboard, on a tap on a
 * phone. Otherwise it is just the mark. Never a link: the lookup does not go
 * looking for audiobooks, it only repeats what the page said.
 *
 * Pattern: a disclosure. A real button that says whether it is open
 * (aria-expanded) and which element it opens (aria-controls), so a keyboard
 * and a screen reader get what a mouse gets. The function returned from
 * useEffect is its cleanup: it removes the listeners when the note closes.
 */
export function AiAudioMark({ audio }: { audio?: { year: string | null; publisher: string | null } | null }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const facts = [audio?.year, audio?.publisher].filter(Boolean).join(' · ')
  if (!facts) {
    const label = 'Audiobook mentioned on the source page'
    return (
      <span className="audio-mark" role="img" aria-label={label} title={label}>
        <Headphones />
      </span>
    )
  }

  return (
    <span className="au-wrap" ref={wrap} data-open={open ? '' : undefined}>
      <button
        type="button"
        className="au-btn audio-mark"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Audiobook: ${facts}`}
        onClick={() => setOpen((was) => !was)}
      >
        <Headphones />
      </button>
      <span className="au-pop" id={id} role="note">
        <span className="au-pop-h">Audiobook</span>
        <span>{facts}</span>
      </span>
    </span>
  )
}
