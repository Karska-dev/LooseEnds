/**
 * Whether a request to /api/series came from this app's own page.
 *
 * Browsers attach Origin to every POST made with fetch, and a page on another
 * site cannot set it, so this stops other websites from spending our
 * Hardcover token through their visitors' browsers. A script outside a
 * browser can forge any of these headers: this is a first fence, not a lock.
 * Turnstile is the follow-up for that.
 *
 * Checked in order, first one present decides:
 *  1. Origin, compared with the Worker's own origin.
 *  2. Sec-Fetch-Site: some privacy tools strip Origin but leave this.
 *  3. Referer, reduced to its origin.
 * With none of them there is nothing to go on, and the request is refused.
 */
export function isSameOrigin(request: Request): boolean {
  const own = new URL(request.url).origin

  const origin = request.headers.get('origin')
  if (origin !== null) return origin === own

  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'

  const referer = request.headers.get('referer')
  if (referer !== null) return originOf(referer) === own

  return false
}

/** What the refused request claimed to be, for the log. Never the IP. */
export function claimedOrigin(request: Request): string {
  return (
    request.headers.get('origin') ??
    (request.headers.get('sec-fetch-site') !== null
      ? `sec-fetch-site: ${request.headers.get('sec-fetch-site')}`
      : null) ??
    originOf(request.headers.get('referer') ?? '') ??
    'none'
  )
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
