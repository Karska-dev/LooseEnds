/**
 * Getting a lookup pass: run Cloudflare Turnstile once, trade its token with
 * the Worker for a pass (worker/pass.ts), reuse the pass until it nearly
 * expires.
 *
 * Turnstile's script is loaded only when a lookup starts, never on page
 * load: a visitor who only looks at their shelf never talks to Cloudflare's
 * challenge at all. Most people see nothing — the widget renders
 * "interaction-only" and stays invisible unless Cloudflare wants a click.
 */

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string
      action?: string
      appearance?: 'always' | 'execute' | 'interaction-only'
      language?: string
      callback?: (token: string) => void
      'error-callback'?: (code: string) => void
      'expired-callback'?: () => void
      'timeout-callback'?: () => void
    },
  ): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** Ask for a new pass this long before the old one runs out. */
const MARGIN_MS = 60 * 1000

/** Said to the reader when this step fails; failureKind() looks for "person". */
export const CHECK_FAILED = 'Couldn’t confirm you’re a person'

let slot: HTMLElement | null = null
let scriptLoad: Promise<TurnstileApi> | null = null
let current: { pass: string; expires: number } | null = null
let inFlight: Promise<string> | null = null

/** Where the widget may appear if Cloudflare asks for a click. Set by the lookup panel. */
export function setTurnstileSlot(element: HTMLElement | null): void {
  slot = element
}

/** A pass the server refused (expired, rotated secret): get a new one next time. */
export function forgetPass(): void {
  current = null
}

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptLoad) return scriptLoad
  scriptLoad = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile')))
    script.onerror = () => {
      scriptLoad = null
      reject(new Error('turnstile script failed to load'))
    }
    document.head.appendChild(script)
  })
  return scriptLoad
}

async function siteKey(): Promise<string> {
  const response = await fetch('/api/pass')
  const body = (await response.json().catch(() => ({}))) as { siteKey?: string; error?: string }
  if (!response.ok || !body.siteKey) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body.siteKey
}

function solve(api: TurnstileApi, key: string): Promise<string> {
  const container = slot ?? document.body
  const host = document.createElement('div')
  host.className = 'turnstile-widget'
  container.appendChild(host)

  return new Promise<string>((resolve, reject) => {
    let id = ''
    const done = () => {
      try {
        if (id) api.remove(id)
      } catch {
        // Already gone.
      }
      host.remove()
    }
    id = api.render(host, {
      sitekey: key,
      action: 'lookup',
      appearance: 'interaction-only',
      // If Cloudflare does ask for a click, it asks in the page's language.
      language: document.documentElement.lang || 'auto',
      callback: (token) => {
        done()
        resolve(token)
      },
      'error-callback': () => {
        done()
        reject(new Error(CHECK_FAILED))
      },
      'expired-callback': () => {
        done()
        reject(new Error(CHECK_FAILED))
      },
      'timeout-callback': () => {
        done()
        reject(new Error(CHECK_FAILED))
      },
    })
  })
}

async function fetchPass(): Promise<string> {
  const [api, key] = await Promise.all([loadScript(), siteKey()])
  const token = await solve(api, key)
  const response = await fetch('/api/pass', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    pass?: string
    expires?: number
    error?: string
    code?: string
  }
  if (!response.ok || !body.pass || !body.expires) {
    // Keep the server's words ("not configured", "Too many lookups") so the
    // panel can tell a busy server from a failed check.
    throw new Error(body.code === 'turnstile' ? CHECK_FAILED : (body.error ?? `HTTP ${response.status}`))
  }
  current = { pass: body.pass, expires: body.expires }
  return body.pass
}

/** A pass good for at least another minute; runs Turnstile only when needed. */
export async function lookupPass(): Promise<string> {
  if (current && current.expires - Date.now() > MARGIN_MS) return current.pass
  // Two callers at once (the cache prefetch and the first chunk) share one challenge.
  inFlight ??= fetchPass().finally(() => {
    inFlight = null
  })
  return inFlight
}
