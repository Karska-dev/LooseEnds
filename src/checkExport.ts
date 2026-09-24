import Papa from 'papaparse'
import type { ParseResult } from './goodreads'

/**
 * Why a file cannot be used, in the terms the reader needs to fix it — not the
 * parser's. Each kind maps to one message in FileError.
 */
export type FileProblem =
  | { kind: 'empty' }
  | { kind: 'binary'; what: 'spreadsheet' | 'pdf' | 'archive' | 'other' }
  | { kind: 'html'; firstLine: string }
  | { kind: 'columns'; missing: string[]; found: string[] }
  | { kind: 'no-books' }
  | { kind: 'damaged'; line: number; text: string }

/** Every Goodreads export has these; without them there is nothing to read. */
export const REQUIRED_COLUMNS = ['Title', 'Author', 'Exclusive Shelf'] as const

/** Enough to see the header and a few rows of any real export. */
export const SNIFF_BYTES = 64 * 1024

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte)
}

/**
 * Cheap checks on the start of the file, before the rest is read: a wrong file
 * is refused at once, whatever its size.
 */
export function sniffExport(bytes: Uint8Array): FileProblem | null {
  if (bytes.length === 0) return { kind: 'empty' }

  // .xlsx and .numbers are zip archives; .xls is an OLE compound file.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { kind: 'binary', what: 'spreadsheet' }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return { kind: 'binary', what: 'spreadsheet' }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: 'binary', what: 'pdf' }
  if (startsWith(bytes, [0x1f, 0x8b]) || startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf])) {
    return { kind: 'binary', what: 'archive' }
  }
  // Text never holds a NUL byte; anything that does is not a CSV.
  if (bytes.subarray(0, 1024).includes(0)) return { kind: 'binary', what: 'other' }

  return sniffText(new TextDecoder().decode(bytes))
}

/** The text checks, shared with the bundled sample. */
export function sniffText(text: string): FileProblem | null {
  const head = text.replace(/^﻿/, '').trimStart()
  if (head.length === 0) return { kind: 'empty' }

  const firstLine = head.split(/\r?\n/, 1)[0] ?? ''
  if (/^<(!doctype|html|\?xml|head|body)\b/i.test(head)) {
    return { kind: 'html', firstLine: firstLine.slice(0, 80) }
  }

  const header = Papa.parse<string[]>(firstLine, { header: false }).data[0] ?? []
  const found = header.map((field) => field.trim()).filter((field) => field.length > 0)
  const missing = REQUIRED_COLUMNS.filter((column) => !found.includes(column))
  if (missing.length > 0) return { kind: 'columns', missing, found }

  return null
}

/** What the full parse says about the file as a whole. */
export function checkParsed(result: ParseResult): FileProblem | null {
  if (result.damagedAt) return { kind: 'damaged', ...result.damagedAt }
  if (result.books.length === 0) return { kind: 'no-books' }
  return null
}

/**
 * Rows left out of a file that otherwise loaded, in one sentence — or null
 * when nothing was. Loading the rest beats refusing the whole library.
 */
export function leftOutNote(result: ParseResult): string | null {
  const broken = result.rowProblems
  const untitled = result.skipped
  const total = broken.length + untitled
  if (total === 0) return null

  const parts: string[] = []
  if (broken.length > 0) {
    const lines = broken.slice(0, 5).map((problem) => problem.line)
    const more = broken.length > lines.length ? ` and ${broken.length - lines.length} more` : ''
    parts.push(
      `${broken.length} with the wrong number of columns (line${broken.length === 1 ? '' : 's'} ${lines.join(', ')}${more})`,
    )
  }
  if (untitled > 0) parts.push(`${untitled} with no title`)

  return `${total} row${total === 1 ? '' : 's'} left out: ${parts.join(', ')}.`
}
