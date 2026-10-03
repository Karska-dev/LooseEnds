/**
 * The two outside services the AI lookup talks to, as functions it can be
 * handed: a web search (Tavily) and a model that reads the results (Workers
 * AI in production, Ollama on a laptop). src/shared/aiLookup.ts knows
 * neither by name, which is what lets the tests run with stubs.
 *
 * Pattern: adapter. Each function below wraps one service's own API in the
 * shape the lookup asks for (SearchFn, ModelFn). Swapping Workers AI for
 * Ollama is choosing another adapter; the lookup does not change. Everything
 * specific to a vendor — URLs, status codes, field names — stays in this file.
 */

import { pagesFromTavily, tavilyRequestBody } from './aiLookup.ts'
import type { ModelFn, SearchFn } from './aiLookup.ts'

/**
 * Why a lookup could not be made. Never a fact about the series, so never
 * cached: the same question may well work in a minute, or next month.
 *
 * Pattern: typed errors. `kind` is one of a small fixed set, so the caller
 * decides what to do by checking the kind, and the message is free to be
 * reworded for the log. Each service's failures are translated into these
 * kinds here, so nothing further in knows what an HTTP 432 is.
 */
export class LookupError extends Error {
  /**
   * - month: the search plan's allowance for the month is used up
   * - limit: the model's allowance for the day is used up
   * - key: the search or the model refused our credentials
   * - busy: rate limited, or the service is failing; worth trying again
   * - unreachable: no answer at all
   */
  kind: 'month' | 'limit' | 'key' | 'busy' | 'unreachable'

  constructor(kind: LookupError['kind'], message: string) {
    super(message)
    this.name = 'LookupError'
    this.kind = kind
  }
}

const TAVILY = 'https://api.tavily.com/search'

/**
 * Counts what a lookup really sent, for the daily allowance and the log.
 *
 * Pattern: a collecting parameter. One object is handed down to the code
 * that does the work and filled in as it goes, so the totals survive even
 * when the lookup ends by throwing — which a return value would not.
 */
export interface AiMeter {
  searches: number
  credits: number
  inputTokens: number
  outputTokens: number
}

export function newAiMeter(): AiMeter {
  return { searches: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
}

/**
 * One Tavily search per call, one credit each. A dropped connection or a
 * rate limit is retried once; anything else is reported as it is.
 *
 * Pattern: a factory that returns a closure. tavilySearch(key) gives back
 * the function that searches; the key and the meter stay captured inside
 * it, so the lookup calls search(text) and never holds a secret.
 *
 * Technique: a bounded retry. Only failures that may pass by themselves are
 * tried again, and only once. A refused key or a spent plan would fail the
 * same way, so those are thrown at once.
 */
export function tavilySearch(key: string, meter?: AiMeter, fetcher: typeof fetch = fetch): SearchFn {
  return async (query) => {
    let last: LookupError = new LookupError('unreachable', 'The search could not be reached.')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))

      let response: Response
      try {
        if (meter) meter.searches += 1
        response = await fetcher(TAVILY, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(tavilyRequestBody(query)),
        })
      } catch {
        continue
      }

      if (response.status === 401 || response.status === 403) {
        throw new LookupError('key', `The search rejected the key (HTTP ${response.status}).`)
      }
      // Tavily's own codes for "this plan, or pay-as-you-go limit, is spent".
      if (response.status === 432 || response.status === 433) {
        throw new LookupError('month', 'The search allowance for this month is used up.')
      }
      if (response.status === 429 || response.status >= 500) {
        last = new LookupError('busy', `The search is busy (HTTP ${response.status}).`)
        continue
      }
      if (!response.ok) {
        throw new LookupError('busy', `The search answered HTTP ${response.status}.`)
      }

      const body = (await response.json()) as { usage?: { credits?: number } }
      if (meter) meter.credits += Number(body.usage?.credits ?? 1)
      return pagesFromTavily(body)
    }
    throw last
  }
}

/** The part of the Workers AI binding this uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/** Start here: it follows a JSON schema, and reads four pages for about 200 neurons. */
export const DEFAULT_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/**
 * Workers AI in JSON mode. The reply comes back already parsed; the lookup
 * expects text and checks it itself, so it is turned back into text here.
 */
export function workersAiModel(ai: AiBinding, model: string, meter?: AiMeter): ModelFn {
  return async (request) => {
    let output: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    try {
      output = (await ai.run(model, {
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: { type: 'json_schema', json_schema: request.schema },
        // A long series is some 60 tokens a book; this leaves room for forty.
        max_tokens: 2500,
        temperature: 0,
      })) as typeof output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Past the day's free allocation the binding fails rather than bills.
      if (/neurons|allocation|limit|quota|4006|3036/i.test(message)) {
        throw new LookupError('limit', `The model's allowance for today is used up (${message.slice(0, 120)}).`)
      }
      throw new LookupError('busy', `The model could not answer (${message.slice(0, 160)}).`)
    }
    if (meter) {
      meter.inputTokens += output.usage?.prompt_tokens ?? 0
      meter.outputTokens += output.usage?.completion_tokens ?? 0
    }
    const reply = output.response
    return typeof reply === 'string' ? reply : JSON.stringify(reply ?? null)
  }
}

/**
 * A local model through Ollama, for development. Streamed, so a slow model
 * cannot outlast the wait for a response; and with a context large enough
 * for the pages, because Ollama's default cuts long prompts off silently.
 */
export function ollamaModel(url: string, model: string, meter?: AiMeter): ModelFn {
  const endpoint = `${url.replace(/\/$/, '')}/api/chat`
  const ask = async (request: Parameters<ModelFn>[0], think: boolean): Promise<string> => {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          format: request.schema,
          stream: true,
          options: { num_ctx: 16384, temperature: 0 },
          ...(think ? { think: false } : {}),
        }),
      })
    } catch {
      throw new LookupError('unreachable', `Ollama is not answering at ${url}. Is it running?`)
    }
    if (!response.ok || !response.body) {
      const text = await response.text()
      // Models without a thinking mode refuse the "think" setting outright.
      if (think && /think/i.test(text)) return ask(request, false)
      if (response.status === 404) throw new LookupError('key', `Ollama has no model "${model}". Run: ollama pull ${model}`)
      throw new LookupError('busy', `Ollama answered HTTP ${response.status}: ${text.slice(0, 160)}`)
    }

    // Technique: reading a stream line by line. Chunks arrive cut at any
    // byte, so the last, unfinished line waits in `buffered` until the rest
    // of it comes; only whole lines are parsed.
    let reply = ''
    let buffered = ''
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const part = JSON.parse(line) as {
          error?: string
          message?: { content?: string }
          done?: boolean
          prompt_eval_count?: number
          eval_count?: number
        }
        if (part.error) throw new LookupError('busy', `Ollama: ${part.error}`)
        reply += part.message?.content ?? ''
        if (part.done && meter) {
          meter.inputTokens += part.prompt_eval_count ?? 0
          meter.outputTokens += part.eval_count ?? 0
        }
      }
    }
    return reply
  }
  return (request) => ask(request, true)
}
