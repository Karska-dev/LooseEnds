import { Fragment } from 'react'
import type { ReactNode } from 'react'

/**
 * A translated sentence with an element in the middle of it: a link, or a
 * word in bold. The catalogue writes "open <b>My Books</b>" and this turns
 * the tag into whatever `tags.b` returns.
 *
 * Why not build the sentence in the component, text before the link, then
 * the link, then text after? Because that fixes the word order, and the
 * link is not at the same place in every language. This way the translator
 * moves the whole sentence and the tag travels with its words.
 *
 * Security: the text is never treated as HTML. It is cut into pieces of
 * plain text, and React escapes plain text, so a "<script>" in a catalogue
 * would be shown as those eight characters and nothing would run. Only tags
 * named in `tags` become elements, and their content is text too.
 */
export function Rich({
  text,
  tags,
}: {
  text: string
  tags: Record<string, (content: string) => ReactNode>
}) {
  const parts: ReactNode[] = []
  let last = 0
  // <name>…</name>, where \1 is "the same name again".
  for (const match of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const render = tags[match[1]]
    parts.push(<Fragment key={match.index}>{render ? render(match[2]) : match[2]}</Fragment>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
