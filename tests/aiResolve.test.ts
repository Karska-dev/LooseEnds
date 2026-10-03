import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { forgetAiResults, lookUpWithAi, readAiCached } from '../src/aiResolve.ts'
import type { AiQuery, Post } from '../src/aiResolve.ts'
import type { AiSeriesResult } from '../src/shared/aiLookup.ts'

const SERIES: AiQuery[] = [
  { key: 'one', name: 'One', author: 'A' },
  { key: 'two', name: 'Two', author: 'B' },
  { key: 'three', name: 'Three', author: 'C' },
  { key: 'four', name: 'Four', author: 'D' },
]

function answer(name: string, status: AiSeriesResult['status'] = 'ok', detail?: string): AiSeriesResult {
  return {
    query: name,
    matchedName: status === 'ok' ? name : null,
    hardcoverId: null,
    totalBooks: null,
    volumes: [],
    status,
    ...(detail ? { detail } : {}),
    source: 'ai',
    checkedAt: '2026-10-03',
  }
}

/**
 * A server that answers each request with whatever `reply` makes of it.
 *
 * Pattern: a stub that also records (a spy). It gives canned answers and
 * keeps a list of what it was asked, so a test can check both what the
 * loop did with an answer and which requests it never sent.
 */
function server(reply: (names: string[], cachedOnly: boolean) => Response | Promise<Response>) {
  const asked: { names: string[]; cachedOnly: boolean }[] = []
  const post: Post = async (payload) => {
    const body = payload as { series: { name: string }[]; cachedOnly?: boolean }
    const names = body.series.map((item) => item.name)
    asked.push({ names, cachedOnly: body.cachedOnly === true })
    return reply(names, body.cachedOnly === true)
  }
  return { asked, post }
}

async function run(post: Post, pending = SERIES) {
  const heard: [string, string, string | undefined][] = []
  const started: string[] = []
  const { stopped } = await lookUpWithAi(pending, post, {
    onStart: (item) => started.push(item.key),
    onResult: (item, result) => heard.push([item.key, result.status, result.detail]),
  }, 0)
  return { heard, started, stopped }
}

beforeEach(forgetAiResults)

describe('opening the AI tab', () => {
  test('one request for the whole library, and what is known comes back by key', async () => {
    const { asked, post } = server(() =>
      Response.json({ results: [answer('Two'), answer('Four', 'not_found', 'too few verified books')], allowance: { left: 22, cap: 30 } }),
    )
    const { found, allowance } = await readAiCached(SERIES, post)

    assert.deepEqual(asked, [{ names: ['One', 'Two', 'Three', 'Four'], cachedOnly: true }])
    assert.deepEqual([...found.keys()], ['two', 'four'])
    assert.equal(found.get('four')?.status, 'not_found', 'a miss the server remembers is an answer too')
    assert.deepEqual(allowance, { left: 22, cap: 30 })
  })

  test('a failed request is silent: nothing known, no allowance', async () => {
    const refused = await readAiCached(SERIES, server(() => Response.json({ error: 'Too many lookups.' }, { status: 429 })).post)
    assert.equal(refused.found.size, 0)
    assert.equal(refused.allowance, null)

    const offline = await readAiCached(SERIES, async () => {
      throw new TypeError('Failed to fetch')
    })
    assert.equal(offline.found.size, 0)
  })

  test('what was heard this visit is not asked for again', async () => {
    const first = server(() => Response.json({ results: [answer('Two')] }))
    await readAiCached(SERIES, first.post)

    const second = server(() => Response.json({ results: [] }))
    const { found } = await readAiCached(SERIES, second.post)
    assert.deepEqual(second.asked[0].names, ['One', 'Three', 'Four'])
    assert.deepEqual([...found.keys()], ['two'])
  })
})

describe('looking up with AI', () => {
  test('one series per request, in the order given, each answer reported as it comes', async () => {
    const { asked, post } = server((names) => Response.json({ results: [answer(names[0])], allowance: { left: 9, cap: 30 } }))
    const { heard, started, stopped } = await run(post)

    assert.deepEqual(asked.map((request) => request.names), [['One'], ['Two'], ['Three'], ['Four']])
    assert.ok(asked.every((request) => !request.cachedOnly))
    assert.deepEqual(started, ['one', 'two', 'three', 'four'])
    assert.deepEqual(heard.map(([key, status]) => [key, status]), [['one', 'ok'], ['two', 'ok'], ['three', 'ok'], ['four', 'ok']])
    assert.equal(stopped, null)
  })

  test('a series that was not found is an answer, and the run carries on', async () => {
    const { post } = server((names) =>
      Response.json({ results: [names[0] === 'Two' ? answer('Two', 'not_found', 'too few verified books') : answer(names[0])] }),
    )
    const { heard, stopped } = await run(post)
    assert.equal(heard.length, 4)
    assert.equal(heard[1][1], 'not_found')
    assert.equal(stopped, null)
  })

  test('the allowance running out stops the run there', async () => {
    const { asked, post } = server((names) =>
      Response.json({
        results: [names[0] === 'Two' ? answer('Two', 'error', 'Daily AI lookup limit reached') : answer(names[0])],
        allowance: { left: 0, cap: 30 },
      }),
    )
    const { heard, stopped } = await run(post)
    assert.equal(stopped, 'budget')
    assert.equal(asked.length, 2, 'Three and Four were never asked about')
    assert.deepEqual(heard.map(([key, status]) => [key, status]), [['one', 'ok'], ['two', 'error']])
  })

  test('the month running out, and a server that is not set up, stop it too', async () => {
    const month = await run(server(() => Response.json({ results: [answer('One', 'error', 'AI lookup is out of searches for this month')] })).post)
    assert.equal(month.stopped, 'month')
    assert.equal(month.heard.length, 1)

    const unset = await run(server(() => Response.json({ error: 'AI lookup is not configured on this server.' }, { status: 500 })).post)
    assert.equal(unset.stopped, 'unset')
    assert.equal(unset.heard.length, 1)
    assert.match(unset.heard[0][2] ?? '', /not configured/)
  })

  test('being throttled stops it, in the server\'s own words', async () => {
    const { heard, stopped } = await run(server(() => Response.json({ error: 'Too many lookups. Try again in a minute.' }, { status: 429 })).post)
    assert.equal(stopped, 'busy')
    assert.equal(heard[0][2], 'Too many lookups. Try again in a minute.')
  })

  test('a failed check stops it rather than challenging the reader once per series', async () => {
    const { heard, stopped } = await run(async () => {
      throw new Error('Couldn’t confirm you’re a person')
    })
    assert.equal(stopped, 'check')
    assert.equal(heard.length, 1)
  })

  test('one series that cannot be reached is passed over; two in a row end the run', async () => {
    const unreachable = () => Response.json({ results: [answer('x', 'error', 'AI lookup could not be reached')] })
    const once = await run(server((names) => (names[0] === 'Two' ? unreachable() : Response.json({ results: [answer(names[0])] }))).post)
    assert.equal(once.stopped, null)
    assert.deepEqual(once.heard.map(([, status]) => status), ['ok', 'error', 'ok', 'ok'])

    forgetAiResults()
    const twice = await run(server((names) => (names[0] === 'One' ? Response.json({ results: [answer('One')] }) : unreachable())).post)
    assert.equal(twice.stopped, 'unreachable')
    assert.deepEqual(twice.heard.map(([key]) => key), ['one', 'two', 'three'])
  })

  test('an answer that is not JSON, or empty, is a failure and not a crash', async () => {
    const garbled = await run(server(() => new Response('<html>502</html>', { status: 502 })).post, SERIES.slice(0, 1))
    assert.equal(garbled.heard[0][1], 'error')
    assert.equal(garbled.heard[0][2], 'HTTP 502')

    const empty = await run(server(() => Response.json({ results: [] })).post, SERIES.slice(0, 1))
    assert.equal(empty.heard[0][1], 'error')
  })

  test('lookups are spaced out, so quick answers do not run into the rate limit', async () => {
    const starts: number[] = []
    const post: Post = async (payload) => {
      starts.push(Date.now())
      const name = (payload as { series: { name: string }[] }).series[0].name
      return Response.json({ results: [answer(name)] })
    }
    await lookUpWithAi(SERIES.slice(0, 3), post, { onResult: () => {} }, 60)
    assert.ok(starts[1] - starts[0] >= 55, 'the second waited for the gap')
    assert.ok(starts[2] - starts[1] >= 55)
  })

  test('a failure is filed under the series asked about', async () => {
    const { heard } = await run(server(() => Response.json({ results: [answer('Someone Else', 'ok')] })).post, SERIES.slice(0, 1))
    assert.deepEqual(heard.map(([key]) => key), ['one'])
  })
})
