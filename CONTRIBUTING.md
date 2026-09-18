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
| `npm run dev` | Vite, with `/api/series` served locally |
| `npm test` | 47 tests on Node's own runner, no framework |
| `npm run lint` | oxlint |
| `npm run build` | typecheck, then build |

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
resolve.ts ─── POST /api/series  ─────────┐
   │                                      │  Cloudflare Worker
   │                            worker/index.ts
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

Both import the real functions rather than reimplementing them. A diagnostic
that guesses at the logic will eventually disagree with it and tell you
something false.

## Testing

`npm test` uses Node's built-in runner — no framework, no dev dependency.
Node strips the types natively, and `erasableSyntaxOnly` in the tsconfig
keeps the source strippable.

Fixtures are written as **real Goodreads title strings** run through the real
parser, so a change to series extraction fails loudly instead of quietly
invalidating every expectation. See `tests/fixtures/README.md` for the two
sample exports and what `classics.csv` should produce on the board.

## Where this is fragile

Three things a contributor should know before trusting the output.

- **Matching is name-based, so it can mis-hit.** Series come out of Goodreads
  title strings and are matched to Hardcover by name, narrowed by author. A
  series whose Goodreads name differs from Hardcover's by more than a plural
  may resolve to the wrong series, or to a user-created entry that lumps an
  author's whole output together. A generic one-word name is held up entirely
  by the author match. `npm run explain` shows exactly which filter decided.
  The real answer is a manual override table, which does not exist yet.

- **The upstream pacing is per Worker invocation, not global.** One invocation
  resolves at most ten series — about twelve upstream requests over thirteen
  seconds, roughly 55/minute against Hardcover's 60. Two visitors resolving
  uncached series at the same moment can exceed it, because neither invocation
  knows about the other. The cache absorbs nearly all of this in practice, and
  exceeding the limit means throttling that resets. The proper fix is a shared
  token bucket in a Durable Object; it has not been needed.

- **English editions only.** The API returns every language per position, and
  `SeriesEntry.cleanTitle` is kept for this: match the reader's own titles
  against the editions to infer their language, then use it for the whole
  series. Decide once per series, never per position, or a list comes back
  mixed.

## Gotchas

- **Dev and production share the resolver but not the HTTP handling.**
  `src/shared/hardcover.ts` is used by both, but the request handling around
  it lives separately in `vite.config.ts` and `worker/index.ts`. Anything one
  learns to understand — a new request field, a new cap — has to be taught to
  the other, or localhost quietly behaves differently from the deployed site.
- **There is no cache in development.** Every lookup is a live Hardcover call,
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

