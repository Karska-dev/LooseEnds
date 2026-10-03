/**
 * Dates as the page writes them. A date here is always "YYYY-MM-DD" text,
 * and `months` is the twelve short names of the language in use.
 *
 * Trade-off: fixed month names, not Intl.DateTimeFormat. The browser can
 * format a date in any language by itself, but what it prints depends on the
 * browser's version of the language data: September is "Sep" in one and
 * "Sept" in the next. Twelve words per language are little to keep, and then
 * the page and the tests read the same everywhere.
 */

/** "2022-02-19" → "Feb 2022": the day is noise at this distance. */
export function monthYear(date: string, months: readonly string[]): string {
  const [year, month] = date.split('-')
  const name = months[Number(month) - 1]
  return name ? `${name} ${year}` : year
}

/** "14 Oct": for a day close enough that the year goes without saying. */
export function dayMonth(date: string, months: readonly string[]): string {
  const [, month, day] = date.split('-')
  const name = months[Number(month) - 1]
  return name && day ? `${Number(day)} ${name}` : date
}

/** "12 Mar 2027": an audiobook date is usually a real day, so say the day. */
export function dayMonthYear(date: string, months: readonly string[]): string {
  const [year, month, day] = date.split('-')
  const name = months[Number(month) - 1]
  return name && day ? `${Number(day)} ${name} ${year}` : monthYear(date, months)
}
