import type { IntakeProblem } from '../checkExport'
import type { Shelf } from '../goodreads'
import type { AiMiss } from '../state'
import type { FileMessage, Messages } from './en.ts'

/**
 * Everything the page says, in Ukrainian. The same shape as en.ts, which the
 * `Messages` type on the export below enforces.
 *
 * Three things English does not have to think about decide how the
 * sentences here are built:
 *
 *  - A noun after a number has three forms, not two: 1 книга, 2 книги,
 *    5 книг, and then 21 книга again. `forms` below picks one.
 *  - A title cannot be declined. "Ви читаєте Dune" is fine, but most cases
 *    would need an ending the English title cannot take, so sentences keep
 *    titles in the nominative, in «quotes», or after a colon.
 *  - Number words decline too (дві, двох), so they are used only where the
 *    form is known; elsewhere a digit is clearer than a wrong ending.
 *
 * Goodreads' own menu names stay in English: its site has no Ukrainian
 * interface, and the reader has to find the words they will actually see.
 */

/**
 * Algorithm: CLDR plural rules. Unicode's language data sorts every number
 * into a category per language; for Ukrainian 1, 21, 31 are "one", 2–4 and
 * 22–24 are "few", and the rest "many". Intl.PluralRules is the browser's
 * built-in copy of that table, so the rule is not rewritten here with
 * remainders, where 11–14 are the classic mistake.
 */
const rules = new Intl.PluralRules('uk')

function forms(n: number, one: string, few: string, many: string): string {
  const kind = rules.select(n)
  return kind === 'one' ? one : kind === 'few' ? few : many
}

const series = (n: number) => forms(n, 'серію', 'серії', 'серій')
const books = (n: number) => `${n} ${forms(n, 'книга', 'книги', 'книг')}`

/* Feminine, to agree with «серія». Nominative (also the accusative here),
   then the form shared by the genitive and the locative. */
const NOMINATIVE = ['', 'одна', 'дві', 'три', 'чотири', 'п’ять', 'шість', 'сім', 'вісім', 'дев’ять', 'десять']
const OBLIQUE = ['', 'одній', 'двох', 'трьох', 'чотирьох', 'п’яти', 'шести', 'семи', 'восьми', 'дев’яти', 'десяти']

const nominative = (n: number) => (n < NOMINATIVE.length ? NOMINATIVE[n] : String(n))
const oblique = (n: number) => (n < OBLIQUE.length ? OBLIQUE[n] : String(n))

const quoted = (name: string) => `«${name}»`

/** "A", "A та B", "A, B та C". */
function and(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} та ${items[items.length - 1]}`
}

/** «A», «A» та «B», then «A», «B», «C» та ще 2. */
function listNames(names: string[]): string {
  if (names.length === 0) return ''
  const shown = (names.length > 3 ? names.slice(0, 3) : names).map(quoted)
  const rest = names.length - shown.length
  return and(rest > 0 ? [...shown, `ще ${rest}`] : shown)
}

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** Clauses in one sentence; the last one is set against the others with «а». */
function sentence(parts: string[]): string {
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, а ${parts[parts.length - 1]}`
  return `${capital(joined)}.`
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`
    : `${Math.round(bytes / 1024)} КБ`
}

function fileMessage(problem: IntakeProblem, file: string | null): FileMessage {
  // The file as the subject of a sentence, and as its object.
  const subject = file ? `Файл ${quoted(file)}` : 'Цей файл'
  const object = file ? `файл ${quoted(file)}` : 'цей файл'
  switch (problem.kind) {
    case 'empty':
      return {
        title: 'Цей файл порожній',
        body: `${subject} нічого не містить — мабуть, завантаження не завершилося.`,
        fix: 'Експортуйте бібліотеку з Goodreads ще раз і виберіть новий файл.',
      }
    case 'binary': {
      const title = {
        spreadsheet: 'Це електронна таблиця, а не CSV-експорт',
        pdf: 'Це PDF, а не CSV',
        archive: 'Це архів, а не CSV',
        other: 'Це не текстовий файл, а потрібен CSV',
      }
      return {
        title: title[problem.what],
        body:
          problem.what === 'spreadsheet'
            ? `${subject} збережено з Excel або Numbers. Вони непомітно змінюють ISBN і дати, тому читається лише оригінальний експорт.`
            : `${subject} — не той, який експортує Goodreads.`,
        fix: 'Виберіть файл .csv, який завантажує Goodreads, не відкриваючи його перед цим в іншій програмі.',
      }
    }
    case 'html':
      return {
        title: 'Це вебсторінка, а не ваш експорт',
        body: `${subject} містить збережену сторінку замість вашої бібліотеки — зазвичай тому, що посилання на завантаження вже не діяло.`,
        fix: 'На Goodreads поверніться до Import and export і ще раз натисніть Export Library.',
        snippet: { label: 'Рядок 1', text: problem.firstLine },
      }
    case 'columns':
      return {
        title: 'Цей CSV — не експорт Goodreads',
        body:
          problem.missing.length === 1
            ? `У ньому немає колонки ${problem.missing[0]}, а в кожному експорті Goodreads вона є.`
            : `У ньому немає колонок ${and(problem.missing)}, а в кожному експорті Goodreads вони є.`,
        fix: 'Візьміть експорт бібліотеки зі сторінки Import and export на Goodreads.',
        snippet:
          problem.found.length > 0
            ? { label: 'Його колонки', text: problem.found.slice(0, 8).join(', ') + (problem.found.length > 8 ? ', …' : '') }
            : undefined,
      }
    case 'no-books':
      return {
        title: 'В експорті немає жодної книги',
        body: `${subject} має правильні колонки, але жодного рядка під ними.`,
        fix: 'Якщо ваша бібліотека на Goodreads не порожня, зробіть експорт ще раз — можливо, файл обірвався.',
      }
    case 'damaged':
      return {
        title: `Файл пошкоджено біля рядка ${problem.line}`,
        body: 'Там відкриваються лапки, які ніде не закриваються, тож усе після них прочиталося б неправильно. Нічого не завантажено.',
        fix: 'Зробіть експорт із Goodreads ще раз. Якщо ви редагували файл вручну, скасуйте цю правку.',
        snippet: { label: `Рядок ${problem.line}`, text: problem.text.slice(0, 90) + (problem.text.length > 90 ? '…' : '') },
      }
    case 'too-big':
      return {
        title: 'Цей файл завеликий для експорту',
        body: `${subject} важить ${describeSize(problem.bytes)}. Бібліотека з 5000 книг займає близько 2 МБ.`,
        fix: 'Перевірте, чи ви вибрали саме експорт бібліотеки.',
      }
    case 'unreadable':
      return {
        title: 'Цей файл не вдалося прочитати',
        body: `Браузер не зміг відкрити ${object}.`,
        fix: 'Зробіть експорт із Goodreads ще раз і виберіть новий файл.',
      }
    case 'sample':
      return {
        title: 'Приклад бібліотеки не завантажився',
        body: 'Він береться з цього сайту, і запит не вдався.',
        fix: 'Перезавантажте сторінку або спробуйте власний експорт.',
      }
  }
}

function missVerdict(miss: AiMiss, retryDay: string | null): [label: string, text: string] {
  const again = retryDay ? ` Знову можна буде пошукати з ${retryDay}.` : ''
  switch (miss) {
    case 'not_confirmed':
      return ['Не підтверджено', `Знайдені сторінки розійшлися щодо списку книг.${again}`]
    case 'not_found':
      return ['Не знайдено', `Пошук нічого не знайшов про цю серію.${again}`]
    case 'allowance':
      return ['Очікує', 'Спільний ліміт на сьогодні закінчився раніше, ніж дійшла черга до цієї серії.']
    case 'month':
      return ['Очікує', 'Пошуки на цей місяць закінчилися раніше, ніж дійшла черга до цієї серії.']
    case 'failed':
      return ['Немає відповіді', 'Для цієї серії не вдалося зв’язатися з пошуком.']
  }
}

/** "ви на 2-й" for a whole number; a side story (2.5) cannot take the ending. */
const youAreOn = (position: number) =>
  Number.isInteger(position) ? `ви на ${position}-й` : `ви на книзі ${position}`

/** "Є відповідь про 3 із 8 ваших серій." and what is said when there is none. */
function heardLine(heard: number, total: number): string {
  if (heard > 0) return `Є відповідь про ${heard} із ${total} ваших серій.`
  return total === 1 ? 'Про вашу серію відповіді немає.' : `Про жодну з ${total} ваших серій відповіді немає.`
}

const CHECK_TITLE = 'Не вдалося підтвердити, що ви людина'
const CHECK_BODY =
  'Швидка перевірка Cloudflare не пройшла, тож пошук не відбувся. Спробуйте ще раз — якщо з’явиться прапорець, поставте його.'

export const uk: Messages = {
  /* Fixed abbreviations rather than Intl.DateTimeFormat: see src/dates.ts. */
  months: ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'],
  clock: (time) => time.toLocaleTimeString('uk-UA', { hour: 'numeric', minute: '2-digit' }),

  masthead: {
    tagline: ['Ви прочитали чотири.', 'Усього їх сім.', 'Ось п’ята книга.'],
    language: 'Мова',
    appearance: 'Вигляд',
    look: 'Вигляд',
    skins: { quiet: 'Тиха', brutal: 'Смілива', soft: 'М’яка' },
    changeLook: (now) => `Змінити вигляд (зараз: ${now})`,
  },

  intake: {
    heading: 'Ваш експорт із Goodreads',
    steps: [
      'На Goodreads відкрийте <b>My Books</b>',
      'У лівій колонці, в розділі Tools, виберіть <b>Import and export</b>',
      'Натисніть <b>Export Library</b>, зачекайте кілька секунд і завантажте файл',
    ],
    desktopOnly:
      'Лише в браузері на комп’ютері — у застосунку Goodreads експорту немає. Не відкривайте файл в Excel: він непомітно змінює ISBN і дати.',
    choose: 'Вибрати файл експорту',
    chooseAnother: 'Вибрати інший файл',
    or: 'або',
    sample: 'Спробувати на прикладі',
    privacy:
      'Вашу бібліотеку читає ваш браузер, просто тут. Вона нікуди не надсилається і ніде не зберігається. Улюблені та відкладені серії запам’ятовуються в цьому браузері.',
  },

  fileError: {
    label: 'Цей файл не підходить',
    message: fileMessage,
  },

  shelf: {
    sampleName: 'приклад бібліотеки',
    exportName: 'Ваш експорт',
    books,
    legend: { read: 'прочитано', reading: 'читаю', to_read: 'у планах', dnf: 'не дочитано' },
    change: 'Вибрати інший файл',
    forget: 'Забути мій вибір',
    forgotten: 'Вибір забуто',
    inSeries: (n) => forms(n, 'книга належить до серії', 'книги належать до серій', 'книг належать до серій'),
    standalone: (n) => `ще ${n} — поза серіями`,
    leftOut: (rows) => {
      const parts: string[] = []
      if (rows.broken > 0) {
        const more = rows.broken > rows.lines.length ? ` і ще ${rows.broken - rows.lines.length}` : ''
        parts.push(
          `${rows.broken} — з неправильною кількістю колонок (${rows.broken === 1 ? 'рядок' : 'рядки'} ${rows.lines.join(', ')}${more})`,
        )
      }
      if (rows.untitled > 0) parts.push(`${rows.untitled} — без назви`)
      return `Пропущено ${rows.total} ${forms(rows.total, 'рядок', 'рядки', 'рядків')}: ${parts.join(', ')}.`
    },
  },

  board: {
    heading: 'Серії',
    sources: 'Звідки дані про серії',
    aiTab: 'Пошук ШІ',
    experimental: 'експеримент',
    heartHint: (max) => `Позначте сердечком до ${max} серій, щоб тримати їх угорі.`,
    favourites: 'Улюблені',
    favouritesCount: (n, max) => `${n} із ${max}`,
    everythingElse: 'Усі інші',
    favouritesFull: (max) => `Усі ${max} місць зайнято — зніміть сердечко вище, щоб вибрати іншу.`,
    notStarted: (n) =>
      n === 1
        ? 'В 1 серії з вашого експорту ще нічого не прочитано, тож тут її немає.'
        : `У ${n} серіях із вашого експорту ще нічого не прочитано, тож тут їх немає.`,
    standaloneTitle: 'Поза серіями',
    standaloneMeta: (n) => `${books(n)} · ${forms(n, 'окрема', 'окремі', 'окремі')}`,
    standaloneNote:
      'У назві на Goodreads серії немає. Деякі можуть бути книгами із серій, які Goodreads не позначив, — варто глянути, якщо вище бракує однієї з ваших.',
  },

  tiles: {
    group: 'Показувати у списку',
    label: {
      ready: 'Можна читати',
      reading: 'Читаю зараз',
      waiting: 'Чекаю на автора',
      finished: 'Дочитані',
      aside: 'Відкладені',
    },
    aria: (label, n, shown) =>
      `${label}, ${n} ${forms(n, 'серія', 'серії', 'серій')}, ${shown ? 'показано у списку' : 'приховано зі списку'}`,
    showing: (n) => `Показано ${n} ${series(n)}`,
    // "Дочитані та відкладені приховано": only the first label keeps its capital.
    hidden: (labels) => `${and(labels.map((label, index) => (index === 0 ? label : label.toLowerCase())))} приховано`,
    showAll: 'Показати всі',
  },

  row: {
    hasAudio: 'Є аудіокниги',
    hasAudioAi: 'На сторінках-джерелах згадано аудіокниги',
    favourite: (name) => `Улюблена: ${name}`,
    setAside: 'відкласти',
    bringBack: 'повернути',
    setAsideNamed: (name) => `Відкласти: ${name}`,
    bringBackNamed: (name) => `Повернути: ${name}`,
    ofTotal: (total) => `із ${total}`,
    shelfSummary: (count: Record<Shelf, number>) => {
      const parts = [
        count.read > 0 && `${count.read} прочитано`,
        count.reading > 0 && `${count.reading} читаю зараз`,
        count.to_read > 0 && `${count.to_read} у планах`,
        count.dnf > 0 && `${count.dnf} не дочитано`,
      ].filter(Boolean)
      return parts.length > 0 ? parts.join(' · ') : 'нічого не прочитано'
    },
    readingOrder: 'Порядок читання',
    noVolumes: 'Списку книг ще немає. Спершу запустіть пошук.',
    foundByAi: (day) => `Знайдено за допомогою ШІ ${day} на сторінках за посиланнями вище. Можливі помилки.`,
  },

  volume: {
    shelf: (shelf, when) => {
      switch (shelf) {
        case 'read':
          return when ? `прочитано, ${when}` : 'прочитано'
        case 'reading':
          return 'читаю зараз'
        case 'dnf':
          return 'не дочитано'
        case 'to_read':
          return 'у планах'
      }
    },
    due: (when) => `вийде ${when}`,
    yourCopy: (title) => `ваше видання: ${title}`,
    sideStory: 'побічна історія',
    from: 'джерело:',
    audioDue: (day) => `Аудіокнига вийде ${day}`,
    audioAvailable: 'Є аудіокнига',
    audioOn: (day) => `аудіокнига ${day}`,
    audioMentioned: 'На сторінці-джерелі згадано аудіокнигу',
    audioFacts: (facts) => `Аудіокнига: ${facts}`,
    audiobook: 'Аудіокнига',
    stars: (rating) => `${rating} із 5`,
    unknownDate: 'На сторінці-джерелі дати виходу немає',
  },

  verdict: {
    readingNow: 'Ви зараз її читаєте',
    finished: 'Ви її дочитали',
    finishedAi: 'Ви прочитали всі книги, які знайшов ШІ',
    partial: 'Читати тут більше нічого, але список книг, схоже, неповний',
    onYourList: 'уже у ваших планах',
    notInLibrary: 'ще немає у вашій бібліотеці',
    youAreOn,
    next: 'Далі',
    due: (when) => `Вийде ${when}`,
    noDate: 'Дати ще немає',
    miss: missVerdict,
  },

  brief: {
    reading: 'Читаю',
    onNumber: youAreOn,
    onIt: 'ви її читаєте',
    next: 'Далі',
    due: 'Вийде',
    waiting: 'Чекаю',
    numbered: (position, title) => `${position} · ${title}`,
    finished: 'Дочитано',
    allRead: 'усе прочитано',
    lastOne: 'останню книгу',
    caughtUp: 'Прочитано',
    nothingLeft: 'читати більше нічого',
    notConfirmed: 'Не підтверджено',
    pagesDisagreed: 'сторінки розійшлися',
    notFound: 'Не знайдено',
    nothingToday: 'сьогодні про неї нічого',
  },

  lookup: {
    beforeTitle: (total) => `Готові пошукати ${total} ${series(total)}`,
    beforeBody:
      'Запитаємо в Hardcover, що далі в кожній із них. Це кілька секунд, і надсилаються лише назви серій та імена авторів.',
    go: (total) => `Шукати ${total} ${series(total)}`,
    asking: 'Питаємо про',
    heardSoFar: (heard, total) => `Поки що є відповідь про ${heard} із ${total}.`,
    spoken: (heard, total) => `Шукаємо серії: готово ${heard} із ${total}.`,
    afterTitle: (ready) =>
      ready === 0
        ? 'Ви прочитали все, що вже вийшло'
        : ready === 1
          ? 'В одній серії на вас чекає наступна книга'
          : `У ${oblique(ready)} серіях на вас чекає наступна книга`,
    afterBody: ({ reading, waiting, complete }) => {
      const parts: string[] = []
      if (reading.length === 1) parts.push(`ви читаєте ${quoted(reading[0])}`)
      else if (reading.length > 1) parts.push(`ви читаєте ${nominative(reading.length)} ${series(reading.length)}`)
      if (waiting.length === 1) parts.push(`${quoted(waiting[0])} чекає на автора`)
      else if (waiting.length > 1) {
        parts.push(`${nominative(waiting.length)} ${forms(waiting.length, 'серія чекає', 'серії чекають', 'серій чекають')} на авторів`)
      }
      if (complete.length === 1) parts.push(`${quoted(complete[0])} ви вже дочитали`)
      else if (complete.length > 1) parts.push(`${nominative(complete.length)} ${series(complete.length)} ви вже дочитали`)
      return parts.length > 0 ? sentence(parts) : null
    },
    unsetTitle: 'Пошук серій тут не налаштовано',
    unsetBody: 'Цей сервер ще не повністю налаштовано, тож пошук поки не працює.',
    budgetTitle: 'Нові пошуки на сьогодні вичерпано',
    budgetBody: (heard, total) =>
      `${
        heard > 0
          ? `Маємо ${heard} із ${total} ваших серій.`
          : total === 1
            ? 'Вашу серію знайти не вдалося.'
            : `Жодну з ${total} ваших серій знайти не вдалося.`
      } Решта для цього сайту нові, а він уже використав свою частку запитів до Hardcover на сьогодні. Вони знову запрацюють після опівночі за UTC.`,
    checkTitle: CHECK_TITLE,
    checkBody: CHECK_BODY,
    busyTitle: 'Hardcover зараз перевантажений',
    unreachableTitle: 'Не вдалося зв’язатися з Hardcover',
    failedBody: (heard, total, failedNames, secs) => {
      const line = heardLine(heard, total)
      if (secs === null) return `${line} Спробуйте ще раз — зазвичай це тимчасово.`
      const left = heard > 0 ? ` Залишилося: ${listNames(failedNames)}.` : ''
      return secs > 0
        ? `${line}${left} Спробувати ще раз можна за ${secs} ${forms(secs, 'секунду', 'секунди', 'секунд')}.`
        : `${line}${left} Спробувати ще раз можна вже зараз.`
    },
    retry: 'Спробувати ще раз',
    showWhatWeHave: (heard) => `Показати ${heard}, які вже є`,
  },

  ai: {
    allowance: (left, cap) => `<b>${left}</b> із ${cap} спільних пошуків ШІ лишилося на сьогодні`,
    go: (total, pending) =>
      pending === total ? `Шукати ${total} ${series(total)} із ШІ` : `Шукати ще ${pending} із ШІ`,
    known: (names) =>
      `${listNames(names)} уже шукали раніше, тож ${names.length === 1 ? 'вона' : 'вони'} вже нижче.`,
    checkingTitle: (total) => (total === 1 ? 'Пошук вашої серії із ШІ' : `Пошук ${total} ваших серій із ШІ`),
    checkingBody: 'Перевіряємо, які з них уже шукали раніше…',
    beforeTitle: (total, pending) =>
      pending === total
        ? total === 1
          ? 'Пошук вашої серії із ШІ'
          : `Пошук ${total} ваших серій із ШІ`
        : pending === 1
          ? 'Пошук ще однієї вашої серії із ШІ'
          : `Пошук ще ${pending} ваших серій із ШІ`,
    beforeBody:
      'Це експеримент. Для кожної серії ШІ шукає в інтернеті, читає знайдені сторінки автора й видавництва та складає список книг. Він може помилятися, тому кожна книга має посилання на сторінку, з якої її взято.',
    fine: 'Назви серій та імена авторів надсилаються до пошукового сервісу (Tavily) та до ШІ від Cloudflare. Ваші книги й оцінки лишаються в цьому браузері. Ці результати окремі від результатів Hardcover і ніколи їх не замінюють.',
    duringTitle: 'Шукаємо в інтернеті:',
    duringBody: (answered, total) =>
      `Поки що є відповідь про ${answered} із ${total}. Кожна серія потребує трохи часу: спершу пошук, потім ШІ читає знайдене.`,
    spoken: (answered, total) => `Шукаємо серії із ШІ: готово ${answered} із ${total}.`,
    afterTitle: (found, total) =>
      found === 0
        ? total === 1
          ? 'ШІ не знайшов вашу серію'
          : 'ШІ не знайшов жодної з ваших серій'
        : found === total
          ? total === 1
            ? 'ШІ знайшов вашу серію'
            : 'ШІ знайшов усі ваші серії'
          : `ШІ знайшов ${found} із ${total} ваших серій`,
    afterBody: (ready, missed) => {
      const parts: string[] = []
      if (ready === 1) parts.push('В одній на вас чекає наступна книга.')
      else if (ready > 1) parts.push(`У ${oblique(ready)} на вас чекає наступна книга.`)
      if (missed.length > 0) parts.push(`Не вдалося підтвердити за знайденими сторінками: ${listNames(missed)}.`)
      return parts.length > 0 ? parts.join(' ') : null
    },
    stamp: 'Знайдено за допомогою ШІ. Можливі помилки: перш ніж купувати, перевірте сторінку за посиланням.',
    budgetTitle: 'Пошуки ШІ на сьогодні вичерпано',
    budgetBody: (n) =>
      `Усі, хто користується Loose Ends, ділять між собою ${
        n.cap === null
          ? 'невелику кількість нових пошуків'
          : `${n.cap} ${forms(n.cap, 'новий пошук', 'нові пошуки', 'нових пошуків')}`
      } ШІ на день. Лічильник обнуляється о ${n.when} за вашим часом. ` +
      (n.answered > 0
        ? `${n.answered} ${forms(n.answered, 'ваша серія', 'ваші серії', 'ваших серій')} уже нижче. Решту (${n.pending}) можна буде пошукати після ${n.when}.`
        : n.total === 1
          ? `Вашу серію можна буде пошукати після ${n.when}.`
          : `Ваші серії (${n.total}) можна буде пошукати після ${n.when}.`),
    monthTitle: 'Пошуки ШІ на цей місяць вичерпано',
    monthBody: (answered, pending) =>
      'Пошуковий сервіс, на якому працює цей експеримент, дає фіксовану кількість безкоштовних пошуків на місяць, і вони закінчилися. ' +
      (answered > 0
        ? `Те, що шукали раніше, — нижче; решту (${pending}) можна буде пошукати наступного місяця.`
        : 'Ваші серії можна буде пошукати наступного місяця.'),
    unsetTitle: 'Пошук ШІ тут не налаштовано',
    unsetBody: 'Цей сервер ще не налаштовано для нього, тож нічого нового знайти не вийде.',
    checkTitle: CHECK_TITLE,
    checkBody: CHECK_BODY,
    busyTitle: 'Забагато пошуків одночасно',
    busyBody: (answered, total) =>
      `Є відповідь про ${answered} із ${total} ваших серій. Зачекайте хвилину й продовжуйте.`,
    unreachableTitle: 'Не вдалося зв’язатися з пошуком ШІ',
    unreachableBody: (answered, total) => `${heardLine(answered, total)} Спробуйте ще раз — зазвичай це тимчасово.`,
    tryAgain: 'Спробувати ще раз',
    tryAgainNow: 'Спробувати ще раз',
  },

  footer: {
    hardcover:
      'Дані про серії та обкладинки — з <a>Hardcover</a>. Для пошуку надсилаються лише назви серій та імена авторів; ваші книги й оцінки лишаються в цьому браузері, як і улюблені та відкладені серії. Кнопка «Шукати» запускає Cloudflare Turnstile — швидку перевірку, що ви людина; вона бачить ваш браузер, а не ваші книги.',
    ai: 'Пошук ШІ — це експеримент. Назви серій та імена авторів надсилаються до <a>Tavily</a> для пошуку в інтернеті та до Cloudflare Workers AI, щоб прочитати знайдене. Списки книг беруться зі сторінок за посиланнями й можуть бути неправильними. Ваші книги й оцінки лишаються в цьому браузері, як і улюблені та відкладені серії. Відкриття цієї вкладки запускає Cloudflare Turnstile — швидку перевірку, що ви людина; вона бачить ваш браузер, а не ваші книги.',
  },

  crash: {
    heading: 'Щось пішло не так',
    what: 'Сторінка натрапила на помилку, після якої не змогла продовжити. Нічого нікуди не надіслано і нічого не збережено — після перезавантаження все почнеться спочатку.',
    report:
      'Якщо це повториться з тим самим експортом, причина, мабуть, у цьому файлі, і про це варто повідомити: <a>створіть issue</a>. Будь ласка, не додавайте сам експорт — це вся ваша історія читання.',
    reload: 'Перезавантажити',
  },
}
