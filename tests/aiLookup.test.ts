import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  aiLookupSeries,
  choosePages,
  excerpt,
  fallbackQueryFor,
  mentionsSeries,
  markReleasedInferred,
  pagesFromTavily,
  parseDraft,
  plainText,
  searchQueryFor,
  supportedDate,
  toSeriesResult,
  verifyAgainstPages,
} from '../src/shared/aiLookup.ts'
import type { Draft, DraftBook, Page, VerifiedBook } from '../src/shared/aiLookup.ts'

const AUTHOR_SITE: Page = {
  url: 'https://author.example/series/hollow-crown',
  title: 'The Hollow Crown series',
  text: `# The Hollow Crown

Reading order: the author recommends reading the novella A Winter Vigil after book two, not before.

1. A Throne of Ash — published March 4, 2021. Audiobook from Tantor Audio, 2022.
2. A Crown of Salt — published 12 October 2022.
2.5 A Winter Vigil (novella) — 2023.
3. A Reign of Glass — coming 2027-02-09.
4. Untitled fourth book — to be announced.`,
}

const FAN_WIKI: Page = {
  url: 'https://wiki.example/hollow-crown',
  title: 'Hollow Crown wiki',
  text: 'Books: A Throne of Ash (2021), A Crown of Salt (2022), A Reign of Glass. See also The Bridesmaid, an unrelated novel.',
}

const PAGES = [AUTHOR_SITE, FAN_WIKI]

function book(title: string, position: number | null, releaseDate: string | null, extra: Partial<DraftBook> = {}): DraftBook {
  return { title, position, releaseDate, source: 'P1', audiobook: null, ...extra }
}

function draftOf(books: DraftBook[], readingOrder: Draft['readingOrder'] = null): Draft {
  return { seriesName: 'The Hollow Crown', readingOrder, books }
}

describe('verifyAgainstPages', () => {
  test('keeps a book whose title and date are on the page it cites', () => {
    const { books, dropped } = verifyAgainstPages(draftOf([book('A Throne of Ash', 1, '2021-03-04')]), PAGES)
    assert.equal(dropped.length, 0)
    assert.equal(books.length, 1)
    assert.equal(books[0].releaseDate, '2021-03-04')
    assert.equal(books[0].dateVerified, true)
    assert.equal(books[0].url, AUTHOR_SITE.url)
  })

  test('drops an invented title', () => {
    const { books, dropped } = verifyAgainstPages(
      draftOf([book('A Throne of Ash', 1, '2021'), book('A Dynasty of Thorns', 5, '2028')]),
      PAGES,
    )
    assert.deepEqual(books.map((item) => item.title), ['A Throne of Ash'])
    assert.equal(dropped[0].title, 'A Dynasty of Thorns')
    assert.match(dropped[0].reason, /not on any fetched page/)
  })

  test('a title only counts as whole words: "Bride" is not found inside "Bridesmaid"', () => {
    const { books, dropped } = verifyAgainstPages(draftOf([book('Bride', 1, null, { source: 'P2' })]), PAGES)
    assert.equal(books.length, 0)
    assert.equal(dropped.length, 1)
  })

  test('a date that is not next to the title on the page is dropped, the book is kept', () => {
    const { books, datesDropped } = verifyAgainstPages(draftOf([book('A Reign of Glass', 3, '2019-06-01')]), [FAN_WIKI])
    assert.equal(books.length, 1)
    assert.equal(books[0].releaseDate, null)
    assert.equal(books[0].dateVerified, false)
    assert.equal(datesDropped, 1)
  })

  test('a wrong date from the model gives way to the year a page writes after the title', () => {
    const { books } = verifyAgainstPages(draftOf([book('A Crown of Salt', 2, '2019-06-01')]), PAGES)
    assert.equal(books[0].releaseDate, '2022')
    assert.equal(books[0].url, FAN_WIKI.url)
  })

  test('a date is kept only as precisely as the page writes it', () => {
    // The page gives a bare year for the novella; the model added a month and day.
    const { books } = verifyAgainstPages(draftOf([book('A Winter Vigil', 2.5, '2023-11-20')]), PAGES)
    assert.equal(books[0].releaseDate, '2023')
  })

  test('a book cited to the wrong page is kept if another fetched page has it', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('A Winter Vigil', 2.5, '2023', { source: 'P2' })]),
      PAGES,
    )
    assert.equal(books.length, 1)
    assert.equal(books[0].url, AUTHOR_SITE.url)
    assert.equal(books[0].resourced, true)
  })

  test('a source label that names no fetched page does not smuggle a book in', () => {
    const { books } = verifyAgainstPages(draftOf([book('A Dynasty of Thorns', 5, null, { source: 'P9' })]), PAGES)
    assert.equal(books.length, 0)
  })

  test('a book no page numbers and the model could not place is dropped', () => {
    const { books, dropped } = verifyAgainstPages(draftOf([book('A Crown of Salt', null, '2022')]), [FAN_WIKI])
    assert.equal(books.length, 0)
    assert.match(dropped[0].reason, /position/)
  })

  test('the number comes from the page, not from the model', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('A Crown of Salt', 7, null), book('A Winter Vigil', null, null)]),
      PAGES,
    )
    assert.deepEqual(books.map((item) => [item.title, item.position, item.positionFrom]), [
      ['A Crown of Salt', 2, 'pages'],
      ['A Winter Vigil', 2.5, 'pages'],
    ])
  })

  test('only the model numbered it: kept, and marked as the model\'s word', () => {
    const { books } = verifyAgainstPages(draftOf([book('A Crown of Salt', 2, null)]), [FAN_WIKI])
    assert.equal(books[0].position, 2)
    assert.equal(books[0].positionFrom, 'model')
  })

  test('audiobook year and publisher are kept only when the page gives them', () => {
    const { books } = verifyAgainstPages(
      draftOf([
        book('A Throne of Ash', 1, '2021', { audiobook: { year: '2022', publisher: 'Tantor Audio' } }),
        book('A Crown of Salt', 2, '2022', { audiobook: { year: '2023', publisher: 'Podium' } }),
      ]),
      [AUTHOR_SITE],
    )
    assert.equal(books[0].hasAudio, true)
    assert.deepEqual(books[0].audio, { year: '2022', publisher: 'Tantor Audio' })
    // Book one's "Audiobook" line is not book two's: evidence stops at the
    // next title.
    assert.equal(books[1].hasAudio, false)
    assert.equal(books[1].audio, null)
  })

  test('a book does not borrow the date of the book listed after it', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('A Crown of Salt', 2, '2027-02-09'), book('A Reign of Glass', 3, '2027-02-09')]),
      PAGES,
    )
    // Its own line says 2022, the fan wiki says (2022): never 2027.
    assert.equal(books[0].releaseDate, '2022')
    assert.equal(books[1].releaseDate, '2027-02-09')
  })

  test('no audiobook claim, no audiobook mark', () => {
    const { books } = verifyAgainstPages(draftOf([book('A Reign of Glass', 3, '2027-02-09')]), PAGES)
    assert.equal(books[0].hasAudio, false)
    assert.equal(books[0].audio, null)
  })

  test('a reading-order note is kept when the page says it', () => {
    const { readingOrder } = verifyAgainstPages(
      draftOf(
        [book('A Throne of Ash', 1, '2021')],
        { note: 'The author recommends reading the novella A Winter Vigil after book two.', source: 'P1' },
      ),
      PAGES,
    )
    assert.equal(readingOrder?.url, AUTHOR_SITE.url)
  })

  test('a reading-order note the page does not make is dropped', () => {
    const { readingOrder } = verifyAgainstPages(
      draftOf(
        [book('A Throne of Ash', 1, '2021')],
        { note: 'Start with the prequel trilogy, then continue chronologically through the saga.', source: 'P2' },
      ),
      PAGES,
    )
    assert.equal(readingOrder, null)
  })

  test('books come back in series order, duplicates removed', () => {
    const { books } = verifyAgainstPages(
      draftOf([
        book('A Reign of Glass', 3, null),
        book('A Throne of Ash', 1, null),
        book('A Winter Vigil', 2.5, null),
        book('A Throne of Ash', 1, null),
      ]),
      PAGES,
    )
    assert.deepEqual(books.map((item) => item.position), [1, 2.5, 3])
  })
})

describe('numbers and dates read off real-looking pages', () => {
  const page = (name: string, text: string): Page => ({ url: `https://${name}.example/x`, title: name, text })
  const titles = (names: string[]) => draftOf(names.map((name) => book(name, null, null)))

  test('a bibliography line: "1 Title (2023) · 2 Title (2024)"', () => {
    const { books } = verifyAgainstPages(
      titles(['My Dark Romeo', 'My Dark Desire', 'My Dark Prince']),
      [page('biblio', 'A series by L J Shen and Parker S Huntington · 1 My Dark Romeo (2023) · 2 My Dark Desire (2024) · 3 My Dark Prince (2025). thumb.')],
      'Dark Prince Road',
    )
    assert.deepEqual(books.map((item) => [item.position, item.title, item.releaseDate]), [
      [1, 'My Dark Romeo', '2023'],
      [2, 'My Dark Desire', '2024'],
      [3, 'My Dark Prince', '2025'],
    ])
  })

  test('the number after the title, with the series name between: "(Dark Prince Road #3)"', () => {
    const { books } = verifyAgainstPages(
      titles(['My Dark Prince', 'My Dark Desire', 'My Dark Romeo']),
      [page('catalogue', 'My Dark Prince (Dark Prince Road #3) by Parker S. · My Dark Desire (Dark Prince Road #2) by Parker S. · My Dark Romeo (Dark Prince Road #1) by Parker S. · The Anti')],
      'Dark Prince Road',
    )
    assert.deepEqual(books.map((item) => [item.position, item.title]), [
      [1, 'My Dark Romeo'],
      [2, 'My Dark Desire'],
      [3, 'My Dark Prince'],
    ])
  })

  test('a page that writes the number after each title is read that way throughout', () => {
    const { books } = verifyAgainstPages(
      titles(['Broken Bonds', 'Savage Bonds', 'Blood Bonds']),
      [page('review', 'Review Reading order: Broken Bonds #1 Savage Bonds #2 Blood Bonds #3')],
      'The Bonds that Tie',
    )
    assert.deepEqual(books.map((item) => item.position), [1, 2, 3])
    assert.deepEqual(books.map((item) => item.title), ['Broken Bonds', 'Savage Bonds', 'Blood Bonds'])
  })

  test('"Title (Series Book 1) · Title (Series Book 2)": the number belongs to the title before it', () => {
    const { books } = verifyAgainstPages(
      titles(['Broken Bonds', 'Savage Bonds', 'Blood Bonds', 'Forced Bonds']),
      [page('guide', 'Broken Bonds (The Bonds that Tie Book 1) · Savage Bonds (The Bonds that Tie Book 2) · Blood Bonds (The Bonds that Tie Book 3) · Forced Bonds (The')],
      'The Bonds that Tie',
    )
    assert.deepEqual(books.map((item) => [item.position, item.title]), [
      [1, 'Broken Bonds'],
      [2, 'Savage Bonds'],
      [3, 'Blood Bonds'],
    ])
  })

  test('one careless blog does not outvote two careful lists', () => {
    const { books } = verifyAgainstPages(
      titles(['Broken Bonds', 'Savage Bonds', 'Blood Bonds', 'Forced Bonds']),
      [
        page('biblio', '1 Broken Bonds (2021) · 2 Savage Bonds (2021) · 3 Blood Bonds (2021) · 4 Forced Bonds (2022)'),
        page('guide', 'Broken Bonds (The Bonds that Tie Book 1) · Savage Bonds (The Bonds that Tie Book 2) · Blood Bonds (The Bonds that Tie Book 3) · Forced Bonds (The Bonds that Tie Book 4)'),
        page('blog', 'Reading order: Broken Bonds #1 Blood Bonds #2 Forced Bonds #3 Savage Bonds #4'),
      ],
      'The Bonds that Tie',
    )
    assert.deepEqual(books.map((item) => item.title), ['Broken Bonds', 'Savage Bonds', 'Blood Bonds', 'Forced Bonds'])
  })

  test('a prequel at "0.5." keeps its half', () => {
    const { books } = verifyAgainstPages(
      titles(["The Alien's Future", "The Alien's Ransom"]),
      [page('biblio', "Series Drixonian Warriors 0.5. The Alien's Future (2021) 1. The Alien's Ransom (2020) 2. The Alien's")],
      'Drixonian Warriors',
    )
    assert.deepEqual(books.map((item) => [item.position, item.releaseDate]), [
      [0.5, '2021'],
      [1, '2020'],
    ])
  })

  test('an author\'s list of everything she wrote: the number tied to the series by name is the one', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('Cruel King', 0, null), book('Deviant King', 1, null), book('Steel Princess', 2, null), book('Royal Elite Epilogue', 3, null)]),
      [
        page('author', '1. Cruel King (Royal Elite #0)\n2. Deviant King(Royal Elite #1)\n3. Steel Princess(Royal Elite #2)\n8. Reign of a King(Kingdom Duet #1)\n10. Royal Elite Epilogue (Royal Elite #3)'),
        page('tracker', '3 Steel Princess 4 Twisted Kingdom 5 Royal Elite Epilogue'),
      ],
      'Royal Elite',
    )
    assert.deepEqual(books.map((item) => [item.position, item.title]), [
      [0, 'Cruel King'],
      [1, 'Deviant King'],
      [2, 'Steel Princess'],
      [3, 'Royal Elite Epilogue'],
    ])
  })

  test('one page against the model: the number that fits the rest of the series wins', () => {
    // The page counts every book the author wrote; the model read the series.
    const authorList = verifyAgainstPages(
      draftOf([book('Kiss the Villain', 1, null), book('Hunt the Villain', 2, null), book('Crave the Villain', 3, null)]),
      [page('author', '33. Kiss the Villain 34. Hunt the Villain 35. Crave the Villain'), page('blog', '1. Kiss the Villain 2. Hunt the Villain')],
      'Villain',
    )
    assert.deepEqual(authorList.books.map((item) => item.position), [1, 2, 3])

    // The other way round: the model's number would collide, the page's fits.
    const duology = verifyAgainstPages(
      draftOf([book('One Dark Window', 1, null), book('Two Twisted Crowns', 1, null)]),
      [page('wiki', 'One Dark Window (2022) is the first book. 2. Two Twisted Crowns')],
      'The Shepherd King',
    )
    assert.deepEqual(duology.books.map((item) => [item.position, item.title]), [
      [1, 'One Dark Window'],
      [2, 'Two Twisted Crowns'],
    ])
  })

  test('a first book named after its series is not mistaken for the series label', () => {
    // "Bride #2: Mate" numbers Mate, not Bride.
    const bride = verifyAgainstPages(
      draftOf([book('Bride', 1, null), book('Mate', 2, null)]),
      [page('shop', 'Bride #2: Mate by Ali Hazelwood'), page('biblio', '1 Bride (2024) · 2 Mate (2025)'), page('blog', 'Mate (Bride, #2) is out now')],
      'Bride',
    )
    assert.deepEqual(bride.books.map((item) => [item.position, item.title, item.releaseDate]), [
      [1, 'Bride', '2024'],
      [2, 'Mate', '2025'],
    ])

    const omega = verifyAgainstPages(
      draftOf([book('Tormented Omega', 1, null), book('Claimed Omega', 2, null), book('Stray Omega', 3, null)]),
      [page('author', 'Tormented Omega #2: Claimed Omega · Tormented Omega #3: Stray Omega'), page('list', '1. Tormented Omega 2. Claimed Omega')],
      'Tormented Omega',
    )
    assert.deepEqual(omega.books.map((item) => [item.position, item.title]), [
      [1, 'Tormented Omega'],
      [2, 'Claimed Omega'],
      [3, 'Stray Omega'],
    ])
  })

  test('a wiki\'s section numbers do not beat the model when nothing else numbers the books', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('The Wolf King', 1, null), book('The Night Prince', 2, null), book('The Wolf Queen', 3, null)]),
      [page('wiki', 'Contents 1.1 The Wolf King 1.2 The Night Prince 2 Characters'), page('author', 'The Wolf King, The Night Prince and The Wolf Queen')],
      'The Wolf King',
    )
    assert.deepEqual(books.map((item) => item.position), [1, 2, 3])
  })

  test('one page that ties a wrong number to the series does not outvote two lists and the model', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('A Court of Mist and Fury', 2, null), book('A Court of Wings and Ruin', 3, null)]),
      [
        page('a', '2. A Court of Mist and Fury 3. A Court of Wings and Ruin'),
        page('b', '2 A Court of Mist and Fury (2016) 3 A Court of Wings and Ruin (2017)'),
        page('shop', 'A Court of Thorns and Roses 2: A Court of Wings and Ruin special edition'),
      ],
      'A Court of Thorns and Roses',
    )
    assert.deepEqual(books.map((item) => [item.position, item.title]), [
      [2, 'A Court of Mist and Fury'],
      [3, 'A Court of Wings and Ruin'],
    ])
  })

  test('"Book 4 –", "Series 4:" and "(Book #4 of Series)" all say four', () => {
    const { books } = verifyAgainstPages(
      titles(['Shadow Princess']),
      [
        page('author', 'Book 3 – The Reckoning (also available on Audible)\n\nBook 4 – Shadow princess (also available on Audible)'),
        page('publisher', 'Zodiac Academy 4: Shadow Princess\n\n(Book #4 of Zodiac Academy)\n\nCaroline Peckham'),
      ],
      'Zodiac Academy',
    )
    assert.equal(books[0].position, 4)
  })

  test('when pages disagree, the number most pages give wins over a world-wide reading order', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('Shadow Princess', 9, null)]),
      [
        page('guide', 'The full reading order: 8. Warrior Fae 9. Shadow Princess 10. Cursed Fates'),
        page('author', 'Book 4 – Shadow Princess'),
        page('publisher', 'Zodiac Academy 4: Shadow Princess'),
      ],
      'Zodiac Academy',
    )
    assert.equal(books[0].position, 4)
  })

  test('a sister series listed alongside is dropped: two titles cannot share a number', () => {
    const { books, dropped } = verifyAgainstPages(
      draftOf([book('The Awakening', 1, null), book('Ruthless Fae', 2, null), book('Dark Fae', 1, null)]),
      [
        page('guide', 'Zodiac Academy #1: The Awakening · Zodiac Academy #2: Ruthless Fae · Ruthless Boys of the Zodiac #1: Dark Fae'),
        page('author', 'Book 1 – The Awakening\n\nBook 2 – Ruthless Fae'),
      ],
      'Zodiac Academy',
    )
    assert.deepEqual(books.map((item) => item.title), ['The Awakening', 'Ruthless Fae'])
    assert.equal(dropped[0].title, 'Dark Fae')
    assert.match(dropped[0].reason, /same number/)
  })

  test('books numbered far past the end of the series are dropped', () => {
    const { books, dropped } = verifyAgainstPages(
      draftOf([book('One', 1, null), book('Two', 2, null), book('Three', 3, null), book('Caged Wolf', 20, null), book('Alpha Wolf', 21, null)]),
      [page('guide', '1. One 2. Two 3. Three … 20. Caged Wolf 21. Alpha Wolf')],
    )
    assert.deepEqual(books.map((item) => item.position), [1, 2, 3])
    assert.equal(dropped.length, 2)
    assert.match(dropped[0].reason, /jumps/)
  })

  test('one missing book is a gap, not a jump: the rest is kept', () => {
    const { books } = verifyAgainstPages(
      draftOf([book('One', 1, null), book('Two', 2, null), book('Four', 4, null)]),
      [page('list', '1. One 2. Two 4. Four')],
    )
    assert.deepEqual(books.map((item) => item.position), [1, 2, 4])
  })
})

describe('supportedDate', () => {
  const near = (text: string) => [text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()]

  test('reads the usual ways a page writes a date', () => {
    assert.equal(supportedDate('2024-12-06', near('Published December 6, 2024')), '2024-12-06')
    assert.equal(supportedDate('2024-12-06', near('Out 6th Dec 2024')), '2024-12-06')
    assert.equal(supportedDate('2024-12-06', near('Release: 2024-12-06')), '2024-12-06')
    assert.equal(supportedDate('2024-12-06', near('12/06/2024')), '2024-12-06')
  })

  test('falls back to the month, then the year, then nothing', () => {
    assert.equal(supportedDate('2024-12-06', near('Coming December 2024')), '2024-12')
    assert.equal(supportedDate('2023-11-20', near('a novella, 2023')), '2023')
    assert.equal(supportedDate('2024-12-06', near('Book 6 of 12, 2024')), '2024')
    assert.equal(supportedDate('2024-12-06', near('Published in 2019')), null)
  })

  test('refuses anything that is not a date', () => {
    assert.equal(supportedDate('soon', near('soon 2024')), null)
  })
})

describe('markReleasedInferred', () => {
  const at = (position: number, releaseDate: string | null): VerifiedBook => ({
    title: `Book ${position}`,
    position,
    positionFrom: 'pages',
    releaseDate,
    url: 'https://x.example',
    dateVerified: releaseDate !== null,
    resourced: false,
    hasAudio: false,
    audio: null,
  })
  const TODAY = '2026-10-02'

  test('an undated book before a published one counts as out', () => {
    const inferred = markReleasedInferred([at(1, '1951'), at(2, null), at(3, '1953-01-01')], TODAY)
    assert.deepEqual([...inferred], [1])
  })

  test('an undated last book stays unannounced', () => {
    const inferred = markReleasedInferred([at(1, '2011'), at(2, null)], TODAY)
    assert.equal(inferred.size, 0)
  })

  test('a later book that is only announced proves nothing', () => {
    const inferred = markReleasedInferred([at(1, null), at(2, '2027-02-09')], TODAY)
    assert.equal(inferred.size, 0)
  })

  test('a bare year that has not ended yet proves nothing either', () => {
    const inferred = markReleasedInferred([at(1, null), at(2, '2026')], TODAY)
    assert.equal(inferred.size, 0)
  })
})

describe('toSeriesResult', () => {
  test('is a SeriesResult the board can read, marked as AI', () => {
    const { books, readingOrder } = verifyAgainstPages(
      draftOf([book('A Throne of Ash', 1, '2021-03-04'), book('A Winter Vigil', 2.5, '2023'), book('A Reign of Glass', 3, '2027-02-09')]),
      PAGES,
    )
    const result = toSeriesResult({ name: 'Hollow Crown' }, 'The Hollow Crown', books, readingOrder, '2026-10-02')
    assert.equal(result.source, 'ai')
    assert.equal(result.status, 'ok')
    assert.equal(result.matchedName, 'The Hollow Crown')
    assert.equal(result.hardcoverId, null)
    // The novella is listed but does not count as a main-line book.
    assert.equal(result.totalBooks, 2)
    assert.equal(result.volumes.length, 3)
    assert.equal(result.volumes[0].editions[0].coverUrl, null)
    assert.equal(result.volumes[0].evidence.url, AUTHOR_SITE.url)
  })
})

describe('aiLookupSeries', () => {
  const today = '2026-10-02'
  const reply = (draft: Draft) => async () => JSON.stringify(draft)

  test('search, extract, verify: a made-up book never reaches the result', async () => {
    const { result, report } = await aiLookupSeries(
      { name: 'The Hollow Crown', author: 'A. N. Author' },
      {
        today,
        search: async () => PAGES,
        runModel: reply(
          draftOf([
            book('A Throne of Ash', 1, '2021-03-04'),
            book('A Crown of Salt', 2, '2022-10-12'),
            book('A Dynasty of Thorns', 5, '2028'),
          ]),
        ),
      },
    )
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.volumes.map((volume) => volume.editions[0].title), ['A Throne of Ash', 'A Crown of Salt'])
    assert.equal(report.drafted, 3)
    assert.equal(report.kept, 2)
    assert.equal(report.searches, 1)
    assert.equal(report.modelCalls, 1)
  })

  test('Goodreads and Amazon pages are never read', async () => {
    let seen = ''
    await aiLookupSeries(
      { name: 'The Hollow Crown' },
      {
        today,
        search: async () => [
          { url: 'https://www.goodreads.com/series/1', title: 'Goodreads', text: 'A Throne of Ash' },
          { url: 'https://www.amazon.co.uk/dp/1', title: 'Amazon', text: 'A Throne of Ash' },
          AUTHOR_SITE,
        ],
        runModel: async (request) => {
          seen = request.user
          return JSON.stringify(draftOf([]))
        },
      },
    )
    assert.ok(!seen.includes('goodreads.com'))
    assert.ok(!seen.includes('amazon.'))
    assert.ok(seen.includes(AUTHOR_SITE.url))
  })

  test('a search that came back about something else is asked once more, differently', async () => {
    const asked: string[] = []
    const { result, report } = await aiLookupSeries(
      { name: 'The Hollow Crown', author: 'A. N. Author' },
      {
        today,
        search: async (text) => {
          asked.push(text)
          return asked.length === 1
            ? [{ url: 'https://dictionary.example/hollow', title: 'hollow', text: 'hollow: having a space inside' }]
            : PAGES
        },
        runModel: reply(draftOf([book('A Throne of Ash', 1, '2021'), book('A Crown of Salt', 2, '2022')])),
      },
    )
    assert.deepEqual(asked, ['"The Hollow Crown" A. N. Author book series in order', fallbackQueryFor({ name: 'The Hollow Crown', author: 'A. N. Author' })])
    assert.equal(report.searches, 2)
    assert.equal(result.status, 'ok')
  })

  test('a search that found the series is not repeated', async () => {
    let searches = 0
    await aiLookupSeries(
      { name: 'The Hollow Crown', author: 'A. N. Author' },
      { today, search: async () => { searches += 1; return PAGES }, runModel: reply(draftOf([])) },
    )
    assert.equal(searches, 1)
  })

  test('no usable pages: not found, and the model is never called', async () => {
    let called = false
    const { result } = await aiLookupSeries(
      { name: 'Nothing' },
      {
        today,
        search: async () => [{ url: 'https://x.example', title: 'x', text: '' }],
        runModel: async () => {
          called = true
          return '{}'
        },
      },
    )
    assert.equal(result.status, 'not_found')
    assert.equal(called, false)
  })

  test('one verified book is not a series', async () => {
    const { result } = await aiLookupSeries(
      { name: 'The Hollow Crown' },
      { today, search: async () => PAGES, runModel: reply(draftOf([book('A Throne of Ash', 1, '2021')])) },
    )
    assert.equal(result.status, 'not_found')
    assert.match(result.detail ?? '', /too few/)
  })

  test('a reply that is not JSON is a miss, not a crash', async () => {
    const { result } = await aiLookupSeries(
      { name: 'The Hollow Crown' },
      { today, search: async () => PAGES, runModel: async () => 'I could not find that series.' },
    )
    assert.equal(result.status, 'not_found')
  })
})

describe('helpers', () => {
  test('the search names the series in quotes, with the author', () => {
    assert.equal(
      searchQueryFor({ name: 'Zodiac Academy', author: 'Caroline Peckham' }),
      '"Zodiac Academy" Caroline Peckham book series in order',
    )
    assert.equal(searchQueryFor({ name: 'Dune' }), '"Dune" book series in order')
  })

  test('a long page is cut around the first mention of the series', () => {
    const page = `${'menu '.repeat(2000)}The Hollow Crown: 1. A Throne of Ash${' footer'.repeat(2000)}`
    const cut = excerpt(page, 'The Hollow Crown', 1000)
    assert.equal(cut.length, 1000)
    assert.ok(cut.includes('A Throne of Ash'))
  })

  test('JSON wrapped in a code fence or prose is still read', () => {
    const draft = parseDraft('Here you go:\n```json\n{"seriesName":"X","readingOrder":null,"books":[]}\n```')
    assert.deepEqual(draft, { seriesName: 'X', readingOrder: null, books: [] })
    assert.equal(parseDraft('{"books": "none"}'), null)
  })

  test('a Tavily result keeps its excerpt, with or without the page text', () => {
    const pages = pagesFromTavily({
      results: [
        { url: 'https://a.example', title: 'A', content: 'snippet only', raw_content: null },
        { url: 'https://b.example', title: 'B', content: 'snippet', raw_content: 'full text' },
      ],
    })
    assert.equal(pages[0].text, 'snippet only')
    assert.equal(pages[0].snippet, 'snippet only')
    assert.equal(pages[1].text, 'snippet\n\nfull text')
  })

  test('a page far too long to be a book list is read only from the top', () => {
    const novel = `Praise for the author. ${'A whole chapter of the book. '.repeat(20_000)}THE END`
    const [page] = pagesFromTavily({ results: [{ url: 'https://pdf.example/x', title: 'X', content: 'snippet', raw_content: novel }] })
    assert.ok(page.text.startsWith('snippet\n\nPraise for the author.'))
    assert.ok(page.text.length <= 100_010)
    assert.ok(!page.text.includes('THE END'))
  })

  test('tabs, hard spaces and runs of spaces become one space', () => {
    assert.equal(plainText('1.\tAsh\u00a0\u00a0and   Ember \n  2. Salt'), '1. Ash and Ember\n2. Salt')
  })

  test('links and images are reduced to the words a reader sees', () => {
    const markdown =
      'Book 2 –\u00a0[Ruthless Fae](https://www.amazon.com/gp/product/B07VJ383S6)\u00a0(also available on [Audible](https://www.amazon.com/dp/B097S6JH9H/ref=tmm_(aud)_swatch))\n\n' +
      '[![Image 23: cover](https://img.example/a_COV.jpg)](https://shop.example/detail/1)\n\nSee https://example.com/more for more.'
    assert.equal(plainText(markdown), 'Book 2 – Ruthless Fae (also available on Audible)\n\nSee for more.')
  })

  test('"also available on Audible" next to a title is an audiobook mention', () => {
    const page: Page = {
      url: 'https://author.example/books',
      title: 'Books',
      text: plainText('Book 1 – [The Awakening](https://a.example/1) (also available on [Audible](https://a.example/2))\n\nBook 2 – [Ruthless Fae](https://a.example/3)'),
    }
    const { books } = verifyAgainstPages(
      {
        seriesName: null,
        readingOrder: null,
        books: [
          { title: 'The Awakening', position: 1, releaseDate: null, source: 'P1', audiobook: { year: null, publisher: null } },
          { title: 'Ruthless Fae', position: 2, releaseDate: null, source: 'P1', audiobook: { year: null, publisher: null } },
        ],
      },
      [page],
    )
    assert.equal(books[0].hasAudio, true)
    assert.equal(books[1].hasAudio, false)
  })
})

describe('mentionsSeries', () => {
  const page = (text: string, score?: number): Page => ({ url: 'https://example.com/a', title: 'A page', text, score })

  test('a page that names the series is about it', () => {
    assert.equal(mentionsSeries([page('The Hollow Crown books in order')], 'The Hollow Crown'), true)
  })

  test('"The" in front and "Trilogy" behind are not part of the name', () => {
    assert.equal(mentionsSeries([page('All three Hollow Crown novels, ranked')], 'The Hollow Crown Trilogy'), true)
  })

  test('pages about something else are not', () => {
    assert.equal(mentionsSeries([page('Ten cosy mysteries for autumn')], 'The Hollow Crown'), false)
    assert.equal(mentionsSeries([], 'The Hollow Crown'), false)
  })

  test('a search that rates all it found as beside the point is believed', () => {
    const text = 'A list that happens to say hollow crown once'
    assert.equal(mentionsSeries([page(text, 0.04), page(text, 0.02)], 'The Hollow Crown'), false)
    assert.equal(mentionsSeries([page(text, 0.04), page(text, 0.6)], 'The Hollow Crown'), true)
  })
})

describe('choosePages', () => {
  const page = (name: string, text: string, snippet = ''): Page => ({ url: `https://${name}.example`, title: name, text, snippet })
  const undated = (name: string) => page(name, 'Book one. Book two. Book three.')
  const dated = (name: string) => page(name, 'One (2019), two (2020), three (2021), four (2022), five (2023).')

  test('keeps the search order when one of the first pages has dates', () => {
    const found = [undated('a'), dated('b'), undated('c'), undated('d'), dated('e')]
    assert.deepEqual(choosePages(found).map((item) => item.title), ['a', 'b', 'c', 'd'])
  })

  test('gives the last full place to a dated page when the first ones have none', () => {
    const found = [undated('a'), undated('b'), undated('c'), undated('d'), undated('e'), dated('f')]
    assert.deepEqual(choosePages(found).map((item) => item.title), ['a', 'b', 'c', 'f'])
  })

  test('a source the search could not fetch is still read, as its excerpt', () => {
    const blocked = page('biblio', '1 Broken Bonds (2021) · 2 Savage Bonds (2021)', '1 Broken Bonds (2021) · 2 Savage Bonds (2021)')
    const chosen = choosePages([blocked, undated('a')])
    assert.deepEqual(chosen.map((item) => item.title), ['biblio', 'a'])
    assert.equal(chosen[0].text, '1 Broken Bonds (2021) · 2 Savage Bonds (2021)')
  })

  test('a fifth full page is cut back to its excerpt, not dropped', () => {
    const found = [dated('a'), undated('b'), undated('c'), undated('d'), page('e', 'the excerpt\n\nthe whole long page', 'the excerpt')]
    const chosen = choosePages(found)
    assert.equal(chosen.length, 5)
    assert.equal(chosen[4].text, 'the excerpt')
  })

  test('never picks Goodreads, Amazon or a page with no text', () => {
    const found = [
      { url: 'https://www.goodreads.com/series/1', title: 'gr', text: 'x' },
      { url: 'https://www.amazon.com/dp/1', title: 'amz', text: 'x' },
      page('empty', ' '),
      undated('a'),
    ]
    assert.deepEqual(choosePages(found).map((item) => item.title), ['a'])
  })
})
