/**
 * The lookup pass: proof that this browser passed Cloudflare Turnstile a
 * moment ago, so /api/series answers people and not scripts.
 *
 * A Turnstile token is single-use and dies after five minutes, but one lookup
 * is several requests spread over a minute or more. So the token is spent
 * once, on POST /api/pass, and exchanged for this: a short-lived pass signed
 * with a key only the Worker holds, sent with every batch.
 *
 * Stateless on purpose — nothing to store, nothing to clean up. A pass can be
 * copied for its lifetime; the per-IP limit still applies to whoever uses it,
 * and a scraper has to solve Turnstile again every PASS_TTL_MS.
 */

export const PASS_TTL_MS = 15 * 60 * 1000

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const encoder = new TextEncoder()

/** A separate key per purpose: the pass is never signed with the raw secret. */
async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`looseends-lookup-pass-v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toBase64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(plain.length)
    for (let i = 0; i < plain.length; i += 1) bytes[i] = plain.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** `<expires ms>.<nonce>.<signature>` */
export async function issuePass(secret: string, now: number): Promise<{ pass: string; expires: number }> {
  const expires = now + PASS_TTL_MS
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(12)))
  const payload = `${expires}.${nonce}`
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload)),
  )
  return { pass: `${payload}.${toBase64Url(signature)}`, expires }
}

/** Valid signature and not yet expired. `crypto.subtle.verify` compares in constant time. */
export async function checkPass(pass: string | null, secret: string, now: number): Promise<boolean> {
  if (!pass) return false
  const parts = pass.split('.')
  if (parts.length !== 3) return false
  const [expiresText, nonce, signatureText] = parts
  const expires = Number(expiresText)
  if (!Number.isFinite(expires) || expires <= now || expires > now + PASS_TTL_MS) return false
  const signature = fromBase64Url(signatureText)
  if (!signature || nonce.length === 0) return false
  return crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    signature,
    encoder.encode(`${expiresText}.${nonce}`),
  )
}

export interface TurnstileOutcome {
  ok: boolean
  /** Cloudflare's error codes, or ours: "wrong-hostname", "unreachable". */
  codes: string[]
}

/**
 * Asks Cloudflare whether the token is genuine, unspent and was issued on our
 * own hostname — a token solved on someone else's page must not buy a pass.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  options: { ip?: string | null; hostname: string; fetcher?: typeof fetch },
): Promise<TurnstileOutcome> {
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (options.ip) form.append('remoteip', options.ip)

  let body: { success?: boolean; hostname?: string; 'error-codes'?: string[] }
  try {
    const response = await (options.fetcher ?? fetch)(SITEVERIFY, { method: 'POST', body: form })
    body = (await response.json()) as typeof body
  } catch {
    return { ok: false, codes: ['unreachable'] }
  }

  if (!body.success) return { ok: false, codes: body['error-codes'] ?? [] }
  // Cloudflare's test keys answer with "example.com"; only real keys name us.
  if (body.hostname && body.hostname !== options.hostname && body.hostname !== 'example.com') {
    return { ok: false, codes: ['wrong-hostname'] }
  }
  return { ok: true, codes: [] }
}
