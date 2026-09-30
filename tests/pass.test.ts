import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { PASS_TTL_MS, checkPass, issuePass, verifyTurnstile } from '../worker/pass.ts'
import worker from '../worker/index.ts'

const SECRET = 'test-secret'
const NOW = Date.UTC(2026, 8, 30, 19, 0, 0)

describe('lookup pass', () => {
  test('a fresh pass is accepted until it expires', async () => {
    const { pass, expires } = await issuePass(SECRET, NOW)
    assert.equal(expires, NOW + PASS_TTL_MS)
    assert.equal(await checkPass(pass, SECRET, NOW), true)
    assert.equal(await checkPass(pass, SECRET, expires - 1), true)
    assert.equal(await checkPass(pass, SECRET, expires), false)
  })

  test('tampered, foreign or malformed passes are refused', async () => {
    const { pass } = await issuePass(SECRET, NOW)
    const [, nonce, signature] = pass.split('.')
    const later = `${NOW + PASS_TTL_MS + 60_000}.${nonce}.${signature}`
    assert.equal(await checkPass(later, SECRET, NOW), false, 'expiry pushed out')
    assert.equal(await checkPass(pass, 'other-secret', NOW), false, 'signed elsewhere')
    for (const bad of [null, '', 'dev', 'a.b', 'x.y.z', `${NOW + 1000}..sig`]) {
      assert.equal(await checkPass(bad, SECRET, NOW), false, String(bad))
    }
  })

  test('two passes issued at once differ', async () => {
    const a = await issuePass(SECRET, NOW)
    const b = await issuePass(SECRET, NOW)
    assert.notEqual(a.pass, b.pass)
  })
})

function fakeSiteverify(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
}

describe('verifyTurnstile', () => {
  const options = (body: unknown) => ({ hostname: 'looseends.example', fetcher: fakeSiteverify(body) })

  test('accepts a success on our own hostname', async () => {
    const out = await verifyTurnstile('tok', SECRET, options({ success: true, hostname: 'looseends.example' }))
    assert.deepEqual(out, { ok: true, codes: [] })
  })

  test('refuses a token solved on another site', async () => {
    const out = await verifyTurnstile('tok', SECRET, options({ success: true, hostname: 'evil.example' }))
    assert.deepEqual(out, { ok: false, codes: ['wrong-hostname'] })
  })

  test("passes Cloudflare's reasons through", async () => {
    const out = await verifyTurnstile('tok', SECRET, options({ success: false, 'error-codes': ['timeout-or-duplicate'] }))
    assert.deepEqual(out, { ok: false, codes: ['timeout-or-duplicate'] })
  })

  test('an unreachable Cloudflare is a refusal, not a pass', async () => {
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const out = await verifyTurnstile('tok', SECRET, { hostname: 'x', fetcher: failing })
    assert.deepEqual(out, { ok: false, codes: ['unreachable'] })
  })
})

describe('the Worker', () => {
  const ORIGIN = 'https://looseends.example'
  const post = (path: string, headers: Record<string, string> = {}, body: unknown = { series: [{ name: 'Dune' }] }) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const env = (extra: Record<string, unknown> = {}) =>
    ({ HARDCOVER_TOKEN: '', ASSETS: { fetch: async () => new Response('') }, ...extra }) as never

  test('without the secret, lookups fail closed', async () => {
    const response = await worker.fetch(post('/api/series'), env())
    assert.equal(response.status, 500)
  })

  test('without a pass, a lookup is refused before anything else happens', async () => {
    const response = await worker.fetch(post('/api/series'), env({ TURNSTILE_SECRET_KEY: SECRET }))
    assert.equal(response.status, 401)
    assert.equal(((await response.json()) as { code?: string }).code, 'pass')
  })

  test('with a live pass, the lookup goes ahead', async () => {
    const { pass } = await issuePass(SECRET, Date.now())
    const request = post('/api/series', { 'x-lookup-pass': pass }, { series: [{ name: 'Dune' }], cachedOnly: true })
    const response = await worker.fetch(request, env({ TURNSTILE_SECRET_KEY: SECRET }))
    assert.equal(response.status, 200)
  })

  test('GET /api/pass hands out the public site key, never the secret', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/pass`),
      env({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: 'site-key' }),
    )
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.ok(text.includes('site-key'))
    assert.ok(!text.includes(SECRET))
  })
})
