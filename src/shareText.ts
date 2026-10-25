/**
 * The text that goes with a picture when it is shared: a caption, and under
 * it the photo credit when a photograph is behind the picture. Unsplash does
 * not require a credit, but naming the photographer is good manners, so the
 * credit travels with the picture wherever it is posted.
 *
 * Pure on purpose: the Share button hands this string to the phone's share
 * sheet, and the words come already translated.
 */
export function shareText(caption: string, credit?: string): string {
  const text = caption.trim()
  return credit?.trim() ? `${text}\n\n${credit.trim()}` : text
}
