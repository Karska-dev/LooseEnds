import type { IntakeProblem } from '../checkExport'
import type { Shelf } from '../goodreads'
import type { AiMiss } from '../state'

/**
 * Everything the page says, in English.
 *
 * Pattern: a message catalogue. The words live here, apart from the
 * components that show them, and each language is one object of the same
 * shape. This file is also the definition of that shape: `Messages` below is
 * simply "whatever `en` is", so adding a line here makes uk.ts fail to
 * compile until the same line exists there. No test can forget a string the
 * compiler refuses to build without.
 *
 * Most entries are plain strings. An entry is a function when the sentence
 * depends on a number or a name, because languages disagree about where
 * those go and what they do to the words around them ("1 book", "2 books";
 * Ukrainian has three forms). Passing the number in and getting a whole
 * sentence back lets each language build it its own way. The alternative,
 * gluing translated fragments together in the component, only works for
 * languages shaped like English.
 *
 * A few strings carry a tag such as <b>…</b> or <a>…</a>. The Rich component
 * (src/Rich.tsx) turns those into elements, so a sentence with a link in the
 * middle is still translated as one sentence.
 *
 * Book titles, series names and authors are never translated: they come from
 * the reader's export and from the lookups.
 */

/** What the intake says about a file it cannot use. */
export interface FileMessage {
  title: string
  body: string
  fix: string
  /** A line of the file itself, when seeing it explains the problem. */
  snippet?: { label: string; text: string }
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** Small numbers read better as words: "Four series", not "4 series". */
function word(n: number, capital = false): string {
  const text = n < WORDS.length ? WORDS[n] : String(n)
  return capital ? text : text.toLowerCase()
}

const s = (n: number) => (n === 1 ? '' : 's')
const pick = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "A", "A and B", "A, B and C". */
function and(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function or(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** "A", "A and B", "A, B and C", then "A, B, C and 2 more". */
function listNames(names: string[]): string {
  if (names.length === 0) return ''
  const shown = names.length > 3 ? names.slice(0, 3) : names
  const rest = names.length - shown.length
  return and(rest > 0 ? [...shown, `${rest} more`] : shown)
}

function sentence(parts: string[]): string {
  const joined = and(parts)
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`
}

function fileMessage(problem: IntakeProblem, file: string | null): FileMessage {
  const name = file ? `“${file}”` : 'This file'
  switch (problem.kind) {
    case 'empty':
      return {
        title: 'This file is empty',
        body: `${name} has nothing in it, so the download probably didn’t finish.`,
        fix: 'Export your library again from Goodreads and choose the new file.',
      }
    case 'binary': {
      const what = { spreadsheet: 'a spreadsheet', pdf: 'a PDF', archive: 'a compressed archive', other: 'not a text file' }
      return {
        title:
          problem.what === 'spreadsheet'
            ? 'This is a spreadsheet, not the CSV export'
            : `This is ${what[problem.what]}, not a CSV`,
        body:
          problem.what === 'spreadsheet'
            ? `${name} was saved from Excel or Numbers. They quietly change ISBNs and dates, so only the original export is read.`
            : `${name} isn’t the file Goodreads exports.`,
        fix: 'Choose the .csv file Goodreads downloads, without opening it in another app first.',
      }
    }
    case 'html':
      return {
        title: 'This is a web page, not your export',
        body: `${name} holds a saved page instead of your library — usually because the download link had expired.`,
        fix: 'On Goodreads, go back to Import and export and click Export Library again.',
        snippet: { label: 'Line 1', text: problem.firstLine },
      }
    case 'columns':
      return {
        title: 'This CSV isn’t a Goodreads export',
        body: `It has no ${or(problem.missing)} column${s(problem.missing.length)}, which every Goodreads export has.`,
        fix: 'Use the library export from the Import and export page on Goodreads.',
        snippet:
          problem.found.length > 0
            ? { label: 'Its columns', text: problem.found.slice(0, 8).join(', ') + (problem.found.length > 8 ? ', …' : '') }
            : undefined,
      }
    case 'no-books':
      return {
        title: 'The export has no books in it',
        body: `${name} has the right columns but no rows under them.`,
        fix: 'If your Goodreads library isn’t empty, export it again — the file may have been cut short.',
      }
    case 'damaged':
      return {
        title: `This file is damaged near line ${problem.line}`,
        body: 'A quotation mark opens there and never closes, so everything after it would be read wrong. Nothing was loaded.',
        fix: 'Export again from Goodreads. If you edited the file by hand, undo that edit.',
        snippet: { label: `Line ${problem.line}`, text: problem.text.slice(0, 90) + (problem.text.length > 90 ? '…' : '') },
      }
    case 'too-big':
      return {
        title: 'This file is far too big to be an export',
        body: `${name} is ${describeSize(problem.bytes)}. A library of 5,000 books exports to about 2 MB.`,
        fix: 'Check you chose the library export rather than something else.',
      }
    case 'unreadable':
      return {
        title: 'This file couldn’t be read',
        body: `The browser couldn’t open ${name}.`,
        fix: 'Export it again from Goodreads and choose the new file.',
      }
    case 'sample':
      return {
        title: 'The sample library didn’t load',
        body: 'It comes from this site, and the request failed.',
        fix: 'Reload the page, or try your own export instead.',
      }
  }
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

function missVerdict(miss: AiMiss, retryDay: string | null): [label: string, text: string] {
  const again = retryDay ? ` Can be looked up again from ${retryDay}.` : ''
  switch (miss) {
    case 'not_confirmed':
      return ['Not confirmed', `The pages found didn’t agree on the books.${again}`]
    case 'not_found':
      return ['Not found', `The search found nothing about this series.${again}`]
    case 'allowance':
      return ['Waiting', 'Today’s shared allowance ran out before this one.']
    case 'month':
      return ['Waiting', 'This month’s searches ran out before this one.']
    case 'failed':
      return ['No answer', 'The lookup couldn’t be reached for this one.']
  }
}

const CHECK_TITLE = 'Couldn’t confirm you’re a person'
const CHECK_BODY =
  'Cloudflare’s quick check didn’t go through, so nothing was looked up. Try again — if a box appears, tick it.'

export const en = {
  /** Short month names, January first (src/dates.ts). */
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  /** A time of day on the reader's clock, written the way their browser writes times. */
  clock: (time: Date) => time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),

  masthead: {
    tagline: ['You’ve read four.', 'There are seven.', 'Here’s book five.'],
    language: 'Language',
    appearance: 'Appearance',
    look: 'Look',
    skins: { quiet: 'Quiet', brutal: 'Bold', soft: 'Soft' },
    changeLook: (now: string) => `Change look (now ${now})`,
  },

  intake: {
    heading: 'Your Goodreads export',
    /* The names in bold are Goodreads' own menu items. Goodreads has no
       Ukrainian interface, so they stay as the reader will see them there. */
    steps: [
      'On Goodreads, open <b>My Books</b>',
      'In the left sidebar under Tools, choose <b>Import and export</b>',
      'Click <b>Export Library</b>, wait a few seconds, then download the file',
    ],
    desktopOnly:
      'Desktop browser only — the Goodreads app has no export. Don’t open the file in Excel first; it quietly changes ISBNs and dates.',
    choose: 'Choose your export file',
    chooseAnother: 'Choose a different file',
    or: 'or',
    sample: 'Try a sample library',
    privacy:
      'Your library is read here in your browser. It is never uploaded and never stored. Favourites and set-asides are remembered in this browser.',
  },

  fileError: {
    label: 'Can’t use this file',
    message: fileMessage,
  },

  shelf: {
    sampleName: 'a sample library',
    exportName: 'Your export',
    books: (n: number) => `${n} book${s(n)}`,
    legend: { read: 'read', reading: 'reading', to_read: 'to read', dnf: 'did not finish' },
    change: 'Use a different file',
    forget: 'Forget my choices',
    forgotten: 'Choices forgotten',
    inSeries: (n: number) => `${pick(n, 'book belongs', 'books belong')} to a series`,
    standalone: (n: number) => `${n} more ${pick(n, 'stands', 'stand')} alone`,
    /** `lines` holds the first few line numbers; `broken` may be more than that. */
    leftOut: (rows: { total: number; broken: number; lines: number[]; untitled: number }) => {
      const parts: string[] = []
      if (rows.broken > 0) {
        const more = rows.broken > rows.lines.length ? ` and ${rows.broken - rows.lines.length} more` : ''
        parts.push(
          `${rows.broken} with the wrong number of columns (line${s(rows.broken)} ${rows.lines.join(', ')}${more})`,
        )
      }
      if (rows.untitled > 0) parts.push(`${rows.untitled} with no title`)
      return `${rows.total} row${s(rows.total)} left out: ${parts.join(', ')}.`
    },
  },

  board: {
    heading: 'Series',
    sources: 'Where series data comes from',
    aiTab: 'AI lookup',
    experimental: 'experimental',
    heartHint: (max: number) => `Heart up to ${max} series to keep them at the top.`,
    favourites: 'Favourites',
    favouritesCount: (n: number, max: number) => `${n} of ${max}`,
    everythingElse: 'Everything else',
    favouritesFull: (max: number) => `Your top ${max} is full — remove a heart above to choose another.`,
    notStarted: (n: number) =>
      `${n} series in your export ${pick(n, 'has', 'have')} nothing read yet, so ${pick(n, 'it is', 'they are')} not listed here.`,
    standaloneTitle: 'Not in a series',
    standaloneMeta: (n: number) => `${n} book${s(n)} · standalone`,
    standaloneNote:
      'No series in the Goodreads title. A few may be series books Goodreads never labelled — worth a look if one of yours is missing above.',
  },

  tiles: {
    group: 'Show in the list',
    label: {
      ready: 'Ready to read',
      reading: 'Reading now',
      waiting: 'Waiting on author',
      finished: 'Finished',
      aside: 'Set aside',
    },
    aria: (label: string, n: number, shown: boolean) =>
      `${label}, ${n} series, ${shown ? 'shown in' : 'hidden from'} the list`,
    showing: (n: number) => `Showing ${n} series`,
    hidden: (labels: string[]) => `${and(labels)} hidden`,
    showAll: 'Show all',
  },

  row: {
    hasAudio: 'Has audiobooks',
    hasAudioAi: 'Audiobooks mentioned on the source pages',
    favourite: (name: string) => `Favourite: ${name}`,
    setAside: 'set aside',
    bringBack: 'bring back',
    setAsideNamed: (name: string) => `Set aside ${name}`,
    bringBackNamed: (name: string) => `Bring back ${name}`,
    /** After the bold count of books read: "2 of 5". */
    ofTotal: (total: number) => `of ${total}`,
    /** "1 read · 2 on your list": the closed row before any lookup has run. */
    shelfSummary: (count: Record<Shelf, number>) => {
      const parts = [
        count.read > 0 && `${count.read} read`,
        count.reading > 0 && `${count.reading} reading now`,
        count.to_read > 0 && `${count.to_read} on your list`,
        count.dnf > 0 && `${count.dnf} did not finish`,
      ].filter(Boolean)
      return parts.length > 0 ? parts.join(' · ') : 'none read'
    },
    readingOrder: 'Reading order',
    noVolumes: 'No volume list yet. Run the lookup first.',
    foundByAi: (day: string) => `Found by AI on ${day}, from the pages linked above. It can be wrong.`,
  },

  volume: {
    /** What the reader's own shelf says, on the right of each book. */
    shelf: (shelf: Shelf, when: string | null): string => {
      switch (shelf) {
        case 'read':
          return when ? `read ${when}` : 'read'
        case 'reading':
          return 'reading now'
        case 'dnf':
          return 'did not finish'
        case 'to_read':
          return 'on your list'
      }
    },
    due: (when: string) => `due ${when}`,
    yourCopy: (title: string) => `your copy: ${title}`,
    sideStory: 'side story',
    /** Before the link to the page a book was read from: "from tor.com". */
    from: 'from',
    audioDue: (day: string) => `Audiobook due ${day}`,
    audioAvailable: 'Audiobook available',
    audioOn: (day: string) => `audiobook ${day}`,
    audioMentioned: 'Audiobook mentioned on the source page',
    audioFacts: (facts: string) => `Audiobook: ${facts}`,
    audiobook: 'Audiobook',
    stars: (rating: number) => `${rating} of 5`,
    unknownDate: 'Release date not found on the source page',
  },

  verdict: {
    readingNow: 'You’re reading it now',
    finished: 'You’ve finished it',
    finishedAi: 'You’ve read every book AI found',
    partial: 'Nothing left to read here, but the volume list looks incomplete',
    onYourList: 'already on your list',
    notInLibrary: 'not in your library yet',
    youAreOn: (position: number) => `you’re on ${position}`,
    next: 'Next',
    due: (when: string) => `Due ${when}`,
    noDate: 'No date yet',
    miss: missVerdict,
  },

  /** One line per series while a lookup runs (src/lookupWords.ts). */
  brief: {
    reading: 'Reading',
    onNumber: (position: number) => `you’re on #${position}`,
    onIt: 'you’re on it',
    next: 'Next',
    due: 'Due',
    waiting: 'Waiting',
    numbered: (position: number, title: string) => `#${position} ${title}`,
    finished: 'Finished',
    allRead: 'all read',
    lastOne: 'the last one',
    caughtUp: 'Caught up',
    nothingLeft: 'nothing left to read',
    notConfirmed: 'Not confirmed',
    pagesDisagreed: 'the pages didn’t agree',
    notFound: 'Not found',
    nothingToday: 'nothing about it today',
  },

  /** The Hardcover lookup, told as a sentence (src/LookupPanel.tsx). */
  lookup: {
    beforeTitle: (total: number) => `Ready to look up ${total} series`,
    beforeBody:
      'We’ll ask Hardcover what comes next in each one. It takes a few seconds, and only the series names and authors are sent.',
    go: (total: number) => `Look up ${total} series`,
    asking: 'Asking about',
    heardSoFar: (heard: number, total: number) => `Heard back about ${heard} of ${total} so far.`,
    spoken: (heard: number, total: number) => `Looking up series: ${heard} of ${total} done.`,
    afterTitle: (ready: number) =>
      ready > 0 ? `${word(ready, true)} series ${pick(ready, 'has', 'have')} a next book waiting` : 'You’re all caught up',
    /** The lists are series names: the ones being read, waiting, and finished. */
    afterBody: (names: { reading: string[]; waiting: string[]; complete: string[] }) => {
      const { reading, waiting, complete } = names
      const parts: string[] = []
      if (reading.length === 1) parts.push(`you’re partway through ${reading[0]}`)
      else if (reading.length > 1) parts.push(`you’re partway through ${word(reading.length)} series`)
      if (waiting.length === 1) parts.push(`${waiting[0]} is waiting on its author`)
      else if (waiting.length > 1) parts.push(`${word(waiting.length)} are waiting on their authors`)
      if (complete.length === 1) parts.push(`you’ve finished ${complete[0]}`)
      else if (complete.length > 1) parts.push(`you’ve finished ${word(complete.length)}`)
      return parts.length > 0 ? sentence(parts) : null
    },
    unsetTitle: 'Series lookup isn’t set up here',
    unsetBody: 'This server isn’t fully configured yet, so nothing can be looked up.',
    budgetTitle: 'Today’s new lookups are used up',
    budgetBody: (heard: number, total: number) =>
      `${heard > 0 ? `We have ${heard} of your ${total} series.` : `None of your ${total} series could be looked up.`} The rest are new to this site, and it has used its share of Hardcover for today. They’ll work again after midnight UTC.`,
    checkTitle: CHECK_TITLE,
    checkBody: CHECK_BODY,
    busyTitle: 'Hardcover is busy right now',
    unreachableTitle: 'Couldn’t reach Hardcover',
    /** `secs` is the countdown to the next try; null when the failure is not a rate limit. */
    failedBody: (heard: number, total: number, failedNames: string[], secs: number | null) => {
      const heardLine =
        heard > 0 ? `We heard back about ${heard} of your ${total} series.` : `None of your ${total} series came back.`
      if (secs === null) return `${heardLine} Try again — it is usually temporary.`
      const who = heard > 0 ? listNames(failedNames) : 'They'
      return secs > 0 ? `${heardLine} ${who} can try again in ${secs} seconds.` : `${heardLine} ${who} can try again now.`
    },
    retry: 'Try again now',
    showWhatWeHave: (heard: number) => `Show the ${heard} we have`,
  },

  /** The AI lookup (src/AiLookupPanel.tsx). */
  ai: {
    allowance: (left: number, cap: number) => `<b>${left}</b> of ${cap} shared AI lookups left today`,
    go: (total: number, pending: number) =>
      pending === total ? `Look up ${total} series with AI` : `Look up ${pending} more with AI`,
    known: (names: string[]) =>
      `${listNames(names)} ${pick(names.length, 'was', 'were')} looked up before, so ${pick(names.length, 'it’s', 'they’re')} already below.`,
    checkingTitle: (total: number) => `Look up your ${total} series with AI`,
    checkingBody: 'Checking which of them have been looked up before…',
    beforeTitle: (total: number, pending: number) =>
      `Look up your ${pending === total ? '' : 'other '}${pending} series with AI`,
    beforeBody:
      'An experiment. For each series, AI searches the web, reads the author’s and publisher’s pages it finds, and lists the books. It can get things wrong, so every book links to the page it came from.',
    fine: 'Series names and authors are sent to a search service (Tavily) and to Cloudflare’s AI. Your books and ratings stay in this browser. Results are separate from Hardcover’s and never replace them.',
    duringTitle: 'Searching the web for',
    duringBody: (answered: number, total: number) =>
      `Heard back about ${answered} of ${total} so far. Each one takes a little while: a search, then AI reads what it found.`,
    spoken: (answered: number, total: number) => `Looking up series with AI: ${answered} of ${total} done.`,
    afterTitle: (found: number, total: number) =>
      found === 0
        ? `AI couldn’t find ${total === 1 ? 'your series' : 'any of your series'}`
        : found === total
          ? total === 1
            ? 'AI found your series'
            : `AI found all ${word(total)} of your series`
          : `AI found ${word(found)} of your ${word(total)} series`,
    afterBody: (ready: number, missed: string[]) => {
      const parts: string[] = []
      if (ready > 0) parts.push(`${word(ready, true)} ${pick(ready, 'has', 'have')} a next book waiting.`)
      if (missed.length > 0) parts.push(`${listNames(missed)} couldn’t be confirmed from the pages found.`)
      return parts.length > 0 ? parts.join(' ') : null
    },
    stamp: 'Found by AI. It can be wrong: check the linked page before you buy.',
    budgetTitle: 'Today’s AI lookups are used up',
    /** `cap` is null when the server did not say; `when` is a clock time. */
    budgetBody: (n: { cap: number | null; when: string; answered: number; pending: number; total: number }) =>
      `Everyone using Loose Ends shares ${n.cap ?? 'a small number of'} new AI lookups a day. They start again at ${n.when} your time. ` +
      (n.answered > 0
        ? `${word(n.answered, true)} of your series ${pick(n.answered, 'is', 'are')} already below. The other ${word(n.pending)} can be looked up after ${n.when}.`
        : `Your ${word(n.total)} series can be looked up after ${n.when}.`),
    monthTitle: 'This month’s AI lookups are used up',
    monthBody: (answered: number, pending: number) =>
      'The search this experiment runs on gives a fixed number of free searches a month, and they are gone. ' +
      (answered > 0
        ? `What was looked up before is below; the other ${word(pending)} can be looked up next month.`
        : 'Your series can be looked up next month.'),
    unsetTitle: 'AI lookup isn’t set up here',
    unsetBody: 'This server isn’t configured for it yet, so nothing new can be looked up.',
    checkTitle: CHECK_TITLE,
    checkBody: CHECK_BODY,
    busyTitle: 'Too many lookups at once',
    busyBody: (answered: number, total: number) =>
      `We heard back about ${answered} of your ${total} series. Give it a minute, then carry on.`,
    unreachableTitle: 'Couldn’t reach the AI lookup',
    unreachableBody: (answered: number, total: number) =>
      (answered > 0
        ? `We heard back about ${answered} of your ${total} series. `
        : `None of your ${total} series came back. `) + 'Try again — it is usually temporary.',
    tryAgain: 'Try again',
    tryAgainNow: 'Try again now',
  },

  footer: {
    hardcover:
      'Series data and covers from <a>Hardcover</a>. Only series names and authors are sent, to look them up; your books and ratings stay in this browser, and so do your favourites and set-asides. Pressing Look up runs Cloudflare Turnstile, a quick check that you’re a person; it sees your browser, not your books.',
    ai: 'AI lookup is an experiment. Series names and authors are sent to <a>Tavily</a> to search the web, and to Cloudflare Workers AI to read what it finds. Book lists come from the linked pages and may be wrong. Your books and ratings stay in this browser, and so do your favourites and set-asides. Opening this tab runs Cloudflare Turnstile, a quick check that you’re a person; it sees your browser, not your books.',
  },

  /** When the page itself breaks (src/ErrorBoundary.tsx). */
  crash: {
    heading: 'Something went wrong',
    what: 'The page hit an error it could not recover from. Nothing was sent anywhere and nothing was saved — reloading starts fresh.',
    report:
      'If it happens again with the same export, that file is probably the cause, and it would be useful to know about: <a>open an issue</a>. Please don’t attach the export itself — it is your whole reading history.',
    reload: 'Reload',
  },
}

/** The shape every language has to fill. */
export type Messages = typeof en
