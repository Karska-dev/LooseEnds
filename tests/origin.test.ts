import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { claimedOrigin, isSameOrigin } from '../worker/origin.ts'

const API = 'https://looseends.karska-dev.workers.dev/api/series'

function post(headers: Record<string, string>, url = API): Request {
  return new Request(url, { method: 'POST', headers, body: '{}' })
}

describe('same-origin check on /api/series', () => {
  test('the app’s own page is allowed', () => {
    assert.equal(isSameOrigin(post({ origin: 'https://looseends.karska-dev.workers.dev' })), true)
  })

  test('another site is refused', () => {
    assert.equal(isSameOrigin(post({ origin: 'https://example.com' })), false)
  })

  test('a lookalike host is refused', () => {
    assert.equal(
      isSameOrigin(post({ origin: 'https://looseends.karska-dev.workers.dev.evil.test' })),
      false,
    )
  })

  test('http is not https', () => {
    assert.equal(isSameOrigin(post({ origin: 'http://looseends.karska-dev.workers.dev' })), false)
  })

  test('Origin decides even when the other headers disagree', () => {
    const request = post({
      origin: 'https://example.com',
      'sec-fetch-site': 'same-origin',
      referer: 'https://looseends.karska-dev.workers.dev/',
    })
    assert.equal(isSameOrigin(request), false)
  })

  test('without Origin, Sec-Fetch-Site same-origin is allowed', () => {
    assert.equal(isSameOrigin(post({ 'sec-fetch-site': 'same-origin' })), true)
  })

  test('without Origin, Sec-Fetch-Site cross-site is refused', () => {
    assert.equal(isSameOrigin(post({ 'sec-fetch-site': 'cross-site' })), false)
  })

  test('with only a Referer, its origin is compared', () => {
    assert.equal(isSameOrigin(post({ referer: 'https://looseends.karska-dev.workers.dev/?x=1' })), true)
    assert.equal(isSameOrigin(post({ referer: 'https://example.com/page' })), false)
  })

  test('a malformed Referer is refused, not thrown', () => {
    assert.equal(isSameOrigin(post({ referer: 'not a url' })), false)
  })

  test('no headers at all is refused', () => {
    assert.equal(isSameOrigin(post({})), false)
  })

  test('local wrangler dev compares against its own origin', () => {
    const local = post({ origin: 'http://localhost:8787' }, 'http://localhost:8787/api/series')
    assert.equal(isSameOrigin(local), true)
  })

  test('the log names what the caller claimed', () => {
    assert.equal(claimedOrigin(post({ origin: 'https://example.com' })), 'https://example.com')
    assert.equal(claimedOrigin(post({ 'sec-fetch-site': 'cross-site' })), 'sec-fetch-site: cross-site')
    assert.equal(claimedOrigin(post({ referer: 'https://example.com/a/b' })), 'https://example.com')
    assert.equal(claimedOrigin(post({})), 'none')
  })
})
