/**
 * One line of JSON per interesting event. A handled 500 produces no stack
 * trace and no console output on its own, so anything we do not log here is
 * invisible in production — which is how a missing binding looked like
 * silence rather than a problem.
 *
 * Technique: structured logging. Each event is an object with named fields,
 * not a sentence, so the log can be filtered and counted by field later
 * (every `ai.resolved` where `searches` was 2) instead of searched as text.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': status === 200 ? 'public, max-age=3600' : 'no-store',
      ...extraHeaders,
    },
  })
}
