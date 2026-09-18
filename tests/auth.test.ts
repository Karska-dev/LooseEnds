import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { authHeader } from '../src/shared/hardcover.ts'

/**
 * Both token formats authenticate the same way. Sending a token without the
 * prefix returns 400 "Invalid Authorization format"; sending it twice returns
 * 401. Neither failure names the header, so these are pinned here.
 */
describe('authorization header', () => {
  test('a personal access token gets the bearer prefix', () => {
    assert.equal(authHeader('hc_pat_abc123'), 'Bearer hc_pat_abc123')
  })

  test('a legacy JWT gets the bearer prefix', () => {
    assert.equal(authHeader('eyJhbGciOi'), 'Bearer eyJhbGciOi')
  })

  test('a prefix copied along with the token is not doubled', () => {
    assert.equal(authHeader('Bearer hc_pat_abc123'), 'Bearer hc_pat_abc123')
  })

  test('surrounding whitespace never reaches the header', () => {
    assert.equal(authHeader('  hc_pat_abc123\n'), 'Bearer hc_pat_abc123')
  })
})
