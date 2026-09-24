import type { FileProblem } from './checkExport'

/** Everything the intake can refuse, including the checks that need no parsing. */
export type IntakeProblem =
  | FileProblem
  | { kind: 'too-big'; size: string }
  | { kind: 'unreadable' }
  | { kind: 'sample' }

interface Message {
  title: string
  body: string
  fix: string
  /** A line of the file itself, when seeing it explains the problem. */
  snippet?: { label: string; text: string }
}

const WHAT: Record<Extract<FileProblem, { kind: 'binary' }>['what'], string> = {
  spreadsheet: 'a spreadsheet',
  pdf: 'a PDF',
  archive: 'a compressed archive',
  other: 'not a text file',
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/**
 * What went wrong and what to do about it, in the reader's terms. Every
 * message ends in an action, because "invalid file" on its own is a dead end.
 */
function messageFor(problem: IntakeProblem, name: string): Message {
  switch (problem.kind) {
    case 'empty':
      return {
        title: 'This file is empty',
        body: `${name} has nothing in it, so the download probably didn’t finish.`,
        fix: 'Export your library again from Goodreads and choose the new file.',
      }
    case 'binary':
      return {
        title:
          problem.what === 'spreadsheet'
            ? 'This is a spreadsheet, not the CSV export'
            : `This is ${WHAT[problem.what]}, not a CSV`,
        body:
          problem.what === 'spreadsheet'
            ? `${name} was saved from Excel or Numbers. They quietly change ISBNs and dates, so only the original export is read.`
            : `${name} isn’t the file Goodreads exports.`,
        fix: 'Choose the .csv file Goodreads downloads, without opening it in another app first.',
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
        body: `It has no ${list(problem.missing)} column${problem.missing.length === 1 ? '' : 's'}, which every Goodreads export has.`,
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
        body: `${name} is ${problem.size}. A library of 5,000 books exports to about 2 MB.`,
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

/**
 * The intake's refusal: announced at once (role="alert"), sitting right above
 * the button that fixes it.
 */
export function FileError({ problem, fileName }: { problem: IntakeProblem; fileName: string | null }) {
  const message = messageFor(problem, fileName ? `“${fileName}”` : 'This file')
  return (
    <div className="file-error" role="alert">
      <p className="file-error-label">Can&rsquo;t use this file</p>
      <p className="file-error-title">{message.title}</p>
      <p className="file-error-body">{message.body}</p>
      {message.snippet && (
        <p className="file-error-snippet">
          <span className="file-error-snippet-label">{message.snippet.label}</span>
          <code>{message.snippet.text}</code>
        </p>
      )}
      <p className="file-error-fix">{message.fix}</p>
    </div>
  )
}
