# Contributing

Small project, few rules. Open an issue before anything large; otherwise a
pull request is welcome.

## Setup

**You do not need a backend, a Cloudflare account, or a deployment.** Clone
the repo, add a Hardcover token for local use, and everything runs on your
machine.

```bash
git clone https://github.com/Karska-dev/LooseEnds.git
cd LooseEnds
npm install
cp .env.example .env.local   # add your Hardcover token
npm run dev
```

Open the printed URL, drop in a Goodreads export, and you have the whole app.
`npm run dev` serves `/api/series` from a middleware in `vite.config.ts`, so
series lookups work locally with no server to set up. There is no database
in development; every lookup goes straight to Hardcover.

The **AI lookup** tab is optional and needs two more things; without them it
says it is not configured and everything else works as before. See
[The AI lookup tab](#the-ai-lookup-tab-experimental) below.

### The token

Get your own from [hardcover.app](https://hardcover.app) → **account settings
→ Hardcover API**. Paste it into `.env.local` with no `Bearer ` in front — the
code adds that.

It is read only server-side and never reaches the browser. `.env.local` is
gitignored; keep it that way.

**This is for local development only.** Running your own copy on your own
machine is exactly what Hardcover's terms allow. Putting a public instance
online is a different question, and one to ask them about directly — their
answer for this project was specific to this deployment and does not come with
the code.

### Working on it

| | |
|---|---|
| `npm run dev` | Vite, with `/api/series` and `/api/ai-series` served locally |
| `npm test` | 303 tests on Node's own runner, no framework |
| `npm run lint` | oxlint |
| `npm run build` | typecheck, then build |
| `npm run ai-explain` | the AI lookup for one series, or the benchmark set |

`tests/fixtures/classics.csv` is a synthetic export covering every state the
board can show — useful for manual testing without using your own library.
See `tests/fixtures/README.md` for what it should produce.

## How it fits together

```
Goodreads CSV
   │  parsed in the browser, never uploaded
   ▼
goodreads.ts ── books with shelf, date, rating
   │
   ▼
series.ts ──── series extracted from "(Series Name, #2)" and grouped
   │
   ▼
turnstile.ts ─ POST /api/pass (once) ────┐  Turnstile check → 15-min pass
resolve.ts ─── POST /api/series + pass ──┤
   │                                      │  Cloudflare Worker
   │                            worker/index.ts (checks the pass)
   │                                      │
   │                           worker/cache.ts (D1) ──miss──▶ Hardcover
   │                                      │
   ◀──────────── volumes per series ──────┘
   ▼
state.ts ───── what's next, and is it out yet
   │
   ▼
App.tsx ────── the board
```

Everything about a reader stays in the browser. The Worker only ever sees a
list of **series names**, and the D1 cache holds only public bibliographic
facts.

Two modules are worth reading before changing anything:

- **`src/state.ts`** is a pure function: shelves plus volumes in, a verdict
  out. No I/O, which is why it is the best-tested part of the codebase. Four
  shipped bugs came from here, and each has a regression test named after it.
- **`src/shared/hardcover.ts`** is shared between the Worker and the Vite dev
  middleware, so a change to the resolver affects both. The HTTP handling
  around it is *not* shared — see the gotchas.

## The AI lookup tab (experimental)

A second way to find what's next in a series, beside Hardcover: a web search
finds pages about the series, a model reads them and lists the books, and
plain code keeps only what the pages actually say. It is labelled
experimental, can be wrong, and links every book to the page it came from.

It never mixes with Hardcover. It has its own endpoint, cache table, client
module and tab; nothing falls back from one source to the other. Only
favourites and set-asides are shared, because they are the reader's choices,
not lookup data.

```
AiLookupPanel.tsx ── the tab: before, during, after, stopped
   │
aiResolve.ts ─────── POST /api/ai-series + pass
   │                   1. on opening the tab: cached only, whole library, free
   │                   2. on the button: one series per request, in board order
   │                                      │
   │                             worker/ai.ts (same gate as /api/series,
   │                             own AI_LIMITER, 12 a minute)
   │                                      │
   │              worker/aiCache.ts (D1) ──miss──▶ src/shared/aiLookup.ts
   │              worker/aiBudget.ts (searches per UTC day)   │
   │                                      │      search → read → verify
   ◀──────── books per series, with sources ┘    (Tavily)  (model) (code)
   ▼
aiState.ts ───────── the reader's books matched to the list by title
```

### Running it locally

Add to `.env.local`:

- `TAVILY_KEY` — from [tavily.com](https://tavily.com), free plan, no card,
  1,000 searches a month. A lookup is one search, sometimes two.
- A local model through [Ollama](https://ollama.com): `ollama pull qwen3.5:9b`.
  `OLLAMA_MODEL` and `OLLAMA_URL` override the defaults (see `.env.example`).

Then `npm run dev`. In development the same pipeline runs with Ollama in place
of Workers AI and files in place of D1, with no daily allowance and no lookup
pass. Everything is recorded under the git-ignored `.dev-cache/` and replayed:

- `tavily/` — every search. Replayed, so a series costs a credit only once.
- `model/` — every model reply. Replayed, so a change to the checking rules
  can be re-scored without asking the model again.
- `ai-series/` — every finished answer, standing in for the D1 cache. Delete
  a file to look that series up again.

### The modules

- **`src/shared/aiLookup.ts`** is the whole pipeline, shared by the Worker,
  the dev middleware and the benchmark script. The search and the model are
  passed in as functions (`src/shared/aiProviders.ts` holds Tavily, Workers AI
  and Ollama), so tests run it against stubs.
- **The verify step is the point of the design.** The model proposes; code
  decides. A title must appear on the page it cites, and that page must be
  one the search returned. A date, an audiobook year or a publisher is kept
  only if it sits between that book's title and the next one on the page.
  Positions are voted on by the pages, with the model as one more vote.
  Fewer than two verified books means not found. `tests/aiLookup.test.ts`
  covers each rule.
- **`src/aiState.ts`** matches the reader's books to an AI list by title,
  not by number, because web sources often disagree on numbering (novellas
  counted or not). A list off by one would otherwise mark the wrong books
  as read.
- **The words** live under `ai` in `src/i18n/en.ts` and `uk.ts`, like the rest
  of the page. The server's failure details are read by `aiFailureKind`, not
  shown, so they stay as they are.

## Diagnostics

Two scripts, for the two things that actually go wrong in production.

```bash
# Why did this series match — or not? Replays the real matcher and prints
# every hit, which survive each filter, and every volume with its position.
# Mistborn is the useful one to try first: the search also returns "The
# Cosmere", which contains it and is larger and more read, so the output
# shows the name-similarity filter doing the work that popularity cannot.
npm run explain -- "Mistborn" --author "Brandon Sanderson"

# Force a cache miss, so the next lookup proves the deployed token works.
npm run evict -- ~/Downloads/goodreads_library_export.csv --run
```

And one for the AI lookup, which runs the real pipeline from your laptop and
compares each series with Hardcover, book by book:

```bash
npm run ai-explain -- "Zodiac Academy" --author "Caroline Peckham"
npm run ai-explain -- --all --limit 5      # a first try of the benchmark set
npm run ai-explain -- --all --model gemma4:e4b
npm run ai-explain -- --all --workers-ai   # the production model, via REST
```

`--all` reads the benchmark list from `.issue-bodies/ai-benchmark-series.json`,
which is the maintainer's and not in the repo; pass a series by name instead.
`--workers-ai` needs `WORKERS_AI_ACCOUNT_ID` and `WORKERS_AI_API_TOKEN`
(see `.env.example`) and spends the account's free neurons. A local model's
score does not predict the production model's, so this is the run to trust
before changing the checking rules.

All three import the real functions rather than reimplementing them. A diagnostic
that guesses at the logic will eventually disagree with it and tell you
something false.

### Words and languages

No component holds text of its own. Everything the page says is in
`src/i18n/en.ts`, and `src/i18n/uk.ts` is the same object in Ukrainian. The
type of the English one is the contract: add a line to `en.ts` and `uk.ts`
stops compiling until it has that line too.

- An entry is a string, or a function when the sentence depends on a number
  or a name: `books: (n) => …`. Each language builds the whole sentence
  itself, because Ukrainian has three noun forms after a number where English
  has two, and puts words in a different order. Do not assemble a sentence
  from translated pieces in a component.
- Components get the words with `const { t } = useLanguage()`
  (`src/language.ts`). Plain functions take `t` as an argument.
- A sentence with a link or bold text inside carries a tag, `<a>…</a>` or
  `<b>…</b>`, and is rendered with `<Rich>` (`src/Rich.tsx`).
- Book titles, series and authors are data and are never translated. Neither
  are Goodreads' own menu names, which the reader has to find on its
  English-only site.
- The server answers in English only. Its error texts are read by code
  (`failureKind`, `aiFailureKind`), not shown, so they stay as they are.

A third language is a new file shaped like `uk.ts`, one line in `CATALOGUES`
and one in `LANGUAGES` (`src/i18n/index.ts`). `tests/i18n.test.ts` then
checks it against the English one.

## Testing

`npm test` uses Node's built-in runner — no framework, no dev dependency.
Node strips the types natively, and `erasableSyntaxOnly` in the tsconfig
keeps the source strippable.

Unit-test fixtures are written as **real Goodreads title strings** run through
the real parser, so a change to series extraction fails loudly instead of
quietly invalidating every expectation.

### Testing by hand

`tests/fixtures/` also holds sample exports for driving the UI, which is the
only way to check things no unit test covers — layout, error messages, the
board's sort order:

- **`classics.csv`** — well-known series arranged so every board state appears
  at least once: finished, next-available, waiting-unannounced, reading-now,
  set-aside, a gap in the middle, an omnibus, a half-numbered volume, six
  standalones, and a series never started.
- **`bad-*.csv`** — six deliberately broken exports: empty, a saved HTML error
  page, the wrong schema, a header with no rows, ragged rows and unclosed
  quotes, and one that is valid CSV with hostile *content* (no titles, nested
  parentheses, `#0`, `#-1`, a 600-character title, emoji, duplicate rows).
  None of them crash; use them to check that every message is one a reader can
  act on.

`tests/fixtures/README.md` records what each produces, verified by running
them through the parser rather than predicted.

## Where this is fragile

Four things a contributor should know before trusting the output.

- **Matching is name-based, so it can mis-hit.** Series come out of Goodreads
  title strings and are matched to Hardcover by name, narrowed by author. The
  closest name wins before the most-read one, and when no hit is by the
  reader's author the search is repeated with the author's name added
  (`bestHit`, `searchSeries` in `src/shared/hardcover.ts`). A series whose
  Goodreads name really differs from Hardcover's, or a common name whose
  author Hardcover files differently, can still resolve to the wrong series,
  or to a user-created entry that lumps several together. `npm run explain`
  shows exactly which rule decided. The real answer is a way for the reader
  to correct a match (#25), which does not exist yet.

- **The upstream pacing is per Worker invocation, not global.** One invocation
  resolves at most ten series — usually about thirteen upstream requests, a
  few more when series need the second search, spaced 1.1 seconds apart:
  roughly 55/minute against Hardcover's 60. Two visitors resolving
  uncached series at the same moment can exceed it, because neither invocation
  knows about the other. The cache absorbs nearly all of this in practice, and
  exceeding the limit means throttling that resets. The proper fix is a shared
  token bucket in a Durable Object; it has not been needed.

- **English editions only, with two deliberate edges.** Side positions (#0.5,
  #1.5, #0) with no English edition are dropped from the volume list when the
  series has any English edition (`isForeignExtra` in `state.ts`). Main-line
  books are never dropped: one that exists only in another language stays,
  under its most-read title, because hiding it would call a series finished
  when it is only untranslated. A translation or duplicate that Hardcover
  keeps as its own record is shown as the book it is a copy of
  (`withOriginals`), which is where most English titles at odd positions
  come from. The API returns every language per position, and
  `SeriesEntry.cleanTitle` is kept for this: match the reader's own titles
  against the editions to infer their language, then use it for the whole
  series. Decide once per series, never per position, or a list comes back
  mixed.

- **The AI lookup can be wrong in ways the checks can't see.** Being on a page
  is not proof: a shared-world reading order lists several series as one, and
  a site may count novellas as books. The page voting catches most of this,
  not all. Web lists also often stop short of the newest book, which is why
  the AI tab says "You've read every book AI found" rather than "finished".
  Some sites refuse to give their text to the search, and the search itself
  returns unrelated pages about one call in ten; a result scoring under 0.3
  counts as a failed search, and the author-first second search usually
  recovers it.

## Gotchas

- **Dev and production share the resolver but not the HTTP handling.**
  `src/shared/hardcover.ts` is used by both, but the request handling around
  it lives separately in `vite.config.ts` and `worker/index.ts`. Anything one
  learns to understand — a new request field, a new cap — has to be taught to
  the other, or localhost quietly behaves differently from the deployed site.
- **Turnstile is a formality in development.** The page still asks for a
  lookup pass, but `vite.config.ts` hands out Cloudflare's always-pass test
  key and a dummy pass, and the dev `/api/series` doesn't check it. The real
  check (`worker/pass.ts`, `worker/index.ts`) is covered by `tests/pass.test.ts`.
- **The AI tab in development is not the AI tab in production.** A local
  model reads pages differently from Workers AI: the larger production model
  proposes more books, so the checks remove more. The dev server has no
  allowance and no pass, and replays saved searches. Re-run
  `npm run ai-explain -- --workers-ai` before trusting a change.
- **An AI lookup spends a search before the model can refuse.** When Workers
  AI's daily neurons run out, the search has already been made and counted.
  The search runs first; checking the model's state before it is not done yet.
- **There is no Hardcover cache in development.** Every lookup is a live Hardcover call,
  paced at 1.1 seconds, so a large library takes a while. That is expected,
  not a hang.
- **Log what you *did* find.** Several failures in this project were the same
  shape: an error that discarded its own explanation. A throttled request
  reported as "not found", a missing token read as `undefined`, a mis-named
  database binding indistinguishable from no cache at all. Handling a missing
  thing gracefully without logging what *was* present turns a configuration
  error into a behaviour change nobody notices.

## Using the Hardcover API responsibly

Hardcover is a small team giving away a good API.

**If you fork this and deploy it publicly, ask them yourself.** The approval
described in the README was given for this deployment, after a specific
conversation about how it behaves. It is not a blanket permission and it does
not come with the code. Their terms mention "localhost or APIs", so a private
instance on your own machine is already fine — a public site serving strangers
from your token is the part worth asking about. They answered within two days
and were generous about it; the message that worked said what the tool does,
what it never touches, and exactly how usage is kept low.

Whatever you build, please keep these intact.

- **Only public series metadata.** Never `me`, `user_books`, or any Hardcover
  user's library.
- **Cache before fetching.** 30 days once every volume in a series is
  published, 1 day while any is unreleased. Never cache a failure.
- **One request per 1.1 seconds**, five series per GraphQL query, backoff on
  429, and no retry on 401 or 403.
- **30 requests per minute per visitor IP**, so one client cannot spend the
  whole budget.
- **Link every title back** to its Hardcover page.

