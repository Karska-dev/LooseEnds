/**
 * The share picture: what goes where, as plain data. No canvas in here.
 *
 * Functional core, imperative shell: `layoutWinnerStory` turns a book and a
 * palette into a list of drawing steps (Op). drawShareCard.ts replays that
 * list on a <canvas>. Because this half never touches a canvas, the layout
 * and the text fitting are tested with a pretend ruler.
 *
 * Numbers are the design file's, which is 540 px wide; the picture is 1080,
 * so every number goes through `u` (× 2). That keeps each one traceable to
 * the "ShareImg" board it came from.
 */

export interface Palette {
  ground: string
  ink: string
  inkSoft: string
  inkFaint: string
  /** Hairlines between list rows. */
  line: string
  primary: string
  /** In the order of TINTS in tint.ts: primary, ok, warn, accent, ink-soft. */
  tints: readonly [string, string, string, string, string]
}

/** Quiet, light: the look the design file's pictures are drawn in. */
export const QUIET_LIGHT: Palette = {
  ground: '#f1f3f7',
  ink: '#0f141c',
  inkSoft: '#525d6c',
  inkFaint: '#858e9c',
  line: '#dae0e8',
  primary: '#3b4a9e',
  tints: ['#3b4a9e', '#2f6b5f', '#8a5a1f', '#a34a33', '#525d6c'],
}

export type Shape = 'story' | 'post' | 'square'

/** Pixels of each picture: 9:16 (a story), 4:5 (a feed post), 1:1. */
export const SIZES: Record<Shape, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  post: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
}

const S = 2
const u = (designPx: number) => designPx * S

export interface FontSpec {
  family: 'serif' | 'sans'
  weight: number
  size: number
}

/** Width in pixels of a text set in a font. The canvas supplies the real one. */
export type Measure = (text: string, font: FontSpec) => number

export type Op =
  | { kind: 'fill'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'cover'; x: number; y: number; w: number; h: number; fill: string; stroke: string; lineWidth: number }
  | { kind: 'frame'; x: number; y: number; w: number; h: number; color: string; lineWidth: number }
  | { kind: 'line'; points: [number, number][]; color: string; lineWidth: number }
  | { kind: 'crown'; x: number; y: number; size: number; iconSize: number; bg: string; fg: string }
  | {
      kind: 'text'
      x: number
      /** Top of the line box, as in CSS; the shell works out the baseline. */
      top: number
      lineHeight: number
      text: string
      font: FontSpec
      color: string
      align: 'left' | 'center' | 'right'
      /** Extra space between letters, in pixels. */
      tracking: number
    }

// --- colour ----------------------------------------------------------------

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toLinear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = parseHex(hex).map(toLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return `#${channels.map((c) => toSrgb(c).toString(16).padStart(2, '0')).join('')}`
}

/**
 * `percent` of `color` mixed into `into`, in the Oklab colour space: the
 * same as CSS `color-mix(in oklab, color 14%, into)`. The page's covers use
 * that recipe, and the canvas cannot be trusted to understand color-mix in
 * every browser, so it is done here by hand. Oklab, not plain RGB, because
 * a mix in RGB goes muddy and darker in the middle.
 */
export function mix(color: string, percent: number, into: string): string {
  const a = toOklab(color)
  const b = toOklab(into)
  const t = percent / 100
  return fromOklab([b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, b[2] + (a[2] - b[2]) * t])
}

// --- fitting text ------------------------------------------------------------

export interface Fitted {
  lines: string[]
  size: number
}

/**
 * Sets `text` in as few lines as it needs: wraps by words, and shrinks the
 * type in steps until it fits in `maxLines`. At the smallest size anything
 * left over is cut with an ellipsis, so a very long title is never drawn
 * outside its box.
 *
 * The ruler is passed in (dependency injection), so tests use a fixed
 * width per letter and the canvas passes `measureText`.
 */
export function fitText(
  widthOf: (text: string, size: number) => number,
  text: string,
  options: { maxWidth: number; maxLines: number; size: number; minSize: number; step?: number },
): Fitted {
  const { maxWidth, maxLines, minSize, step = 2 } = options
  for (let size = options.size; ; size -= step) {
    const at = Math.max(size, minSize)
    const lines = wrap(widthOf, text, maxWidth, at)
    if (lines.length <= maxLines) return { lines, size: at }
    if (at <= minSize) {
      const kept = lines.slice(0, maxLines)
      kept[maxLines - 1] = ellipsize(widthOf, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxWidth, at)
      return { lines: kept, size: at }
    }
  }
}

function wrap(widthOf: (text: string, size: number) => number, text: string, maxWidth: number, size: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const tryLine = line ? `${line} ${word}` : word
    if (widthOf(tryLine, size) <= maxWidth) {
      line = tryLine
      continue
    }
    if (line) lines.push(line)
    // A word wider than the whole line is broken by letters.
    let rest = word
    while (widthOf(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1
      while (cut > 1 && widthOf(rest.slice(0, cut), size) > maxWidth) cut--
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function ellipsize(widthOf: (text: string, size: number) => number, text: string, maxWidth: number, size: number): string {
  let out = text
  while (out.length > 1 && widthOf(`${out}…`, size) > maxWidth) out = out.slice(0, -1)
  return `${out.trimEnd()}…`
}

// --- the layout --------------------------------------------------------------

/** What a picture needs to know about a book. Not the whole Book: no dates, no ISBN. */
export interface CardBook {
  title: string
  author: string
  /** Which of the five tints the cover has (tintIndex of the book's key). */
  tint: number
}

export type Format = 'winner' | 'quarters' | 'full' | 'top5' | 'top10'

export interface CardSpec {
  format: Format
  shape: Shape
  palette: Palette
  /** "Best of 2026", top left. */
  label: string
  /** The line top right: "1 of 198 books I read in 2026". */
  stat: string
  winner: CardBook
  /** Q1..Q4 and Jan–Jun, Jul–Dec; null where nobody was picked. Quarters picture only. */
  quarters?: readonly (CardBook | null)[]
  halves?: readonly (CardBook | null)[]
  /** "Q1".."Q4", under the bottom row. */
  quarterNames?: readonly string[]
  /** Full path: the 12 month favourites, Jan..Dec; null where nothing was read. */
  months?: readonly (CardBook | null)[]
  /** "J".."D", under the months. */
  monthLetters?: readonly string[]
  /** Top 5 / Top 10: the books under the winner, furthest first, each with its tier ("Runner-up", "Q1 pick", "March"). */
  placings?: readonly { book: CardBook; label: string }[]
}

const SERIF = (size: number, weight = 400): FontSpec => ({ family: 'serif', weight, size })
const SANS = (size: number, weight = 400): FontSpec => ({ family: 'sans', weight, size })

/**
 * Per-shape numbers, in the design file's pixels (540 wide). The story and
 * the post come from the "ShareImg" board. The square was not drawn there:
 * its numbers are worked out from the post's, a little smaller.
 */
interface ShapeNumbers {
  /** Height in design pixels. */
  H: number
  /** Distance of the small print from the top and bottom edge. */
  edgeTop: number
  edgeBottom: number
  brand: number
  brandRise: number
  winner: { w: number; y: number; titleSize: number; gap: number; authorSize: number }
  /** Quarters tree, bottom row first: the quarter picks, the halves, the winner. */
  tree: [Box, Box, Box]
  /** Full path, bottom row first: the months, the quarters, the halves, the winner. */
  full: [Box, Box, Box, Box]
  /** Top 5 / Top 10: the winner, then one row per book. [loose, dense]: Top 5 is loose, Top 10 dense. */
  list: {
    /** Left-aligned beside the list (post, square) or centred above it (story). */
    centered: boolean
    winner: { w: number; y: number; titleSize: number; titleGap: number; authorGap: number; authorSize: number }
    x0: number
    y0: [number, number]
    pitch: [number, number]
    cover: [number, number]
  }
}
interface Box {
  w: number
  y: number
}

const NUMBERS: Record<Shape, ShapeNumbers> = {
  story: {
    H: 960, edgeTop: 26, edgeBottom: 26, brand: 16, brandRise: 20,
    winner: { w: 280, y: 240, titleSize: 32, gap: 26, authorSize: 14 },
    tree: [{ w: 84, y: 660 }, { w: 100, y: 450 }, { w: 150, y: 170 }],
    full: [{ w: 30, y: 705 }, { w: 70, y: 555 }, { w: 80, y: 390 }, { w: 120, y: 165 }],
    list: {
      centered: true,
      winner: { w: 150, y: 165, titleSize: 26, titleGap: 16, authorGap: 50, authorSize: 13 },
      x0: 30, y0: [480, 480], pitch: [66, 40], cover: [36, 22],
    },
  },
  post: {
    H: 675, edgeTop: 14, edgeBottom: 18, brand: 14, brandRise: 8,
    winner: { w: 230, y: 66, titleSize: 28, gap: 26, authorSize: 14 },
    tree: [{ w: 80, y: 470 }, { w: 90, y: 292 }, { w: 130, y: 52 }],
    full: [{ w: 30, y: 552 }, { w: 70, y: 410 }, { w: 80, y: 255 }, { w: 110, y: 52 }],
    list: {
      centered: false,
      winner: { w: 170, y: 70, titleSize: 20, titleGap: 18, authorGap: 46, authorSize: 12 },
      x0: 250, y0: [110, 66], pitch: [96, 58], cover: [44, 28],
    },
  },
  square: {
    H: 540, edgeTop: 14, edgeBottom: 18, brand: 14, brandRise: 8,
    winner: { w: 190, y: 60, titleSize: 26, gap: 22, authorSize: 13 },
    tree: [{ w: 60, y: 365 }, { w: 70, y: 225 }, { w: 100, y: 40 }],
    // Not drawn in the design file: the post's, scaled to fit 540 tall.
    full: [{ w: 28, y: 424 }, { w: 56, y: 316 }, { w: 64, y: 196 }, { w: 88, y: 40 }],
    list: {
      centered: false,
      winner: { w: 150, y: 56, titleSize: 18, titleGap: 16, authorGap: 40, authorSize: 12 },
      x0: 220, y0: [90, 48], pitch: [90, 46], cover: [40, 24],
    },
  },
}

/**
 * A cover: 2:3, a tint of the book's colour, the title inside (left out when
 * the cover is too small to read it). A winner also gets a 2 px outline
 * 2 px out and a crown.
 */
function cover(
  ops: Op[],
  widthOf: (family: FontSpec['family'], weight: number) => (text: string, size: number) => number,
  p: Palette,
  box: { x: number; y: number; w: number },
  book: CardBook,
  win: boolean,
) {
  const { x, y, w } = box
  const h = w * 1.5
  const tint = p.tints[book.tint % p.tints.length]!
  ops.push({ kind: 'cover', x, y, w, h, fill: mix(tint, 14, p.ground), stroke: mix(tint, 40, p.ground), lineWidth: S })
  if (w >= u(44)) {
    const pad = Math.max(u(2), w * 0.07)
    const size = Math.max(u(4.5), w * 0.115)
    const room = Math.max(1, Math.floor((h - pad * 2) / (size * 1.15)))
    const inner = fitText(widthOf('serif', 500), book.title, {
      maxWidth: w - pad * 2,
      maxLines: room,
      size,
      minSize: Math.min(size, u(4.5)),
    })
    inner.lines.forEach((line, i) =>
      ops.push({
        kind: 'text',
        x: x + pad,
        top: y + pad + i * inner.size * 1.15,
        lineHeight: inner.size * 1.15,
        text: line,
        font: SERIF(inner.size, 500),
        color: mix(tint, 85, p.ink),
        align: 'left',
        tracking: 0,
      }),
    )
  }
  if (win) {
    ops.push({ kind: 'frame', x: x - u(3), y: y - u(3), w: w + u(6), h: h + u(6), color: p.primary, lineWidth: u(2) })
    const mark = Math.max(u(14), w * 0.11)
    ops.push({ kind: 'crown', x: x + w - mark, y, size: mark, iconSize: Math.max(u(9), w * 0.07), bg: p.primary, fg: p.ground })
  }
}

/**
 * Lays out one picture as a list of drawing steps.
 *
 * Why this shape of picture: one big idea (the title, readable as a
 * thumbnail: visual hierarchy), and small print kept to the edges so the
 * middle stays calm. Instagram's own buttons cover roughly the top and
 * bottom 13% of a story, so edge text may be hidden there: an open question
 * in the plan, which each shape's `edgeTop` / `edgeBottom` makes a one-line
 * change.
 */
export function layoutCard(spec: CardSpec, measure: Measure): Op[] {
  const p = spec.palette
  const { width: W, height: H } = SIZES[spec.shape]
  const n = NUMBERS[spec.shape]
  const ops: Op[] = []
  const widthOf = (family: FontSpec['family'], weight: number) => (text: string, size: number) =>
    measure(text, { family, weight, size })
  const side = u(30)

  ops.push({ kind: 'fill', x: 0, y: 0, w: W, h: H, color: p.ground })

  // Small print at the edges.
  ops.push({
    kind: 'text',
    x: side,
    top: u(n.edgeTop),
    lineHeight: u(9.5) * 1.25,
    text: spec.label.toLocaleUpperCase(),
    font: SANS(u(9.5), 500),
    color: p.inkFaint,
    align: 'left',
    tracking: u(9.5) * 0.24,
  })
  const stat = fitText(widthOf('sans', 400), spec.stat, { maxWidth: W / 2 - side, maxLines: 1, size: u(9.5), minSize: u(7), step: 1 })
  ops.push({
    kind: 'text',
    x: W - side,
    top: u(n.edgeTop),
    lineHeight: stat.size * 1.25,
    text: stat.lines[0]!,
    font: SANS(stat.size),
    color: p.inkFaint,
    align: 'right',
    tracking: 0,
  })
  ops.push({
    kind: 'text',
    x: side,
    top: H - u(n.edgeBottom) - u(n.brandRise),
    lineHeight: u(n.brand) * 1.25,
    text: 'Loose Ends',
    font: SERIF(u(n.brand)),
    color: p.ink,
    align: 'left',
    tracking: 0,
  })

  if (spec.format === 'quarters') quartersTree(ops, spec, n, W, widthOf)
  else if (spec.format === 'full') fullTree(ops, spec, n, W, widthOf)
  else if (spec.format === 'top5' || spec.format === 'top10') tiers(ops, spec, n, W, widthOf)
  else winnerBlock(ops, spec, n, W, widthOf)
  return ops
}

/** Winner only: the cover, then the title and the author under it. */
function winnerBlock(
  ops: Op[],
  spec: CardSpec,
  n: ShapeNumbers,
  W: number,
  widthOf: (family: FontSpec['family'], weight: number) => (text: string, size: number) => number,
) {
  const p = spec.palette
  const side = u(30)
  const w = u(n.winner.w)
  const y = u(n.winner.y)
  cover(ops, widthOf, p, { x: (W - w) / 2, y, w }, spec.winner, true)

  const title = fitText(widthOf('serif', 400), spec.winner.title, {
    maxWidth: W - side * 2,
    maxLines: 3,
    size: u(n.winner.titleSize),
    minSize: u(20) * (n.winner.titleSize / 32),
  })
  const titleTop = y + w * 1.5 + u(n.winner.gap)
  title.lines.forEach((line, i) =>
    ops.push({
      kind: 'text',
      x: W / 2,
      top: titleTop + i * title.size * 1.25,
      lineHeight: title.size * 1.25,
      text: line,
      font: SERIF(title.size),
      color: p.ink,
      align: 'center',
      tracking: 0,
    }),
  )
  const author = fitText(widthOf('sans', 400), spec.winner.author, {
    maxWidth: W - side * 2,
    maxLines: 1,
    size: u(n.winner.authorSize),
    minSize: u(10),
  })
  ops.push({
    kind: 'text',
    x: W / 2,
    top: titleTop + title.lines.length * title.size * 1.25 + u(6),
    lineHeight: author.size * 1.25,
    text: author.lines[0]!,
    font: SANS(author.size),
    color: p.inkSoft,
    align: 'center',
    tracking: 0,
  })
}

type WidthOf = (family: FontSpec['family'], weight: number) => (text: string, size: number) => number

interface Level {
  box: Box
  /** One entry per slot; null where nobody was picked. */
  items: readonly (CardBook | null)[]
}

/**
 * A tree drawn upward, joined by hairlines, the winner on top: the eye ends
 * on the winner (the peak-end rule: the end is what is remembered).
 *
 * `levels` go bottom row first and the last has one slot, the winner.
 * `groups[i]` is how many slots of level i feed one slot of level i + 1.
 * A parent sits over the middle of its children's slots. A pick that does
 * not exist (a quarter in which nothing was read) is left out together
 * with its line.
 *
 * Returns the x of each bottom slot and the bottom of its covers, so the
 * caller can write names under them.
 */
function pathTree(ops: Op[], p: Palette, widthOf: WidthOf, W: number, levels: Level[], groups: number[]) {
  const count = levels[0]!.items.length
  const xs: number[][] = [[...Array(count).keys()].map((i) => u(30) + ((i + 0.5) * (W - u(60))) / count)]
  groups.forEach((g, l) => {
    const below = xs[l]!
    xs.push(levels[l + 1]!.items.map((_, i) => {
      const kids = below.slice(i * g, i * g + g)
      return kids.reduce((a, b) => a + b, 0) / kids.length
    }))
  })
  const height = (l: number) => u(levels[l]!.box.w) * 1.5

  // Lines first, so the covers sit on top of their ends.
  groups.forEach((g, l) => {
    levels[l]!.items.forEach((item, i) => {
      const parent = levels[l + 1]!.items[Math.floor(i / g)]
      if (!item || !parent) return
      const fromX = xs[l]![i]!
      const toX = xs[l + 1]![Math.floor(i / g)]!
      const fromY = u(levels[l]!.box.y)
      const toY = u(levels[l + 1]!.box.y) + height(l + 1)
      const mid = (fromY + toY) / 2
      ops.push({ kind: 'line', points: [[fromX, fromY], [fromX, mid], [toX, mid], [toX, toY]], color: p.inkFaint, lineWidth: S })
    })
  })
  levels.forEach((level, l) =>
    level.items.forEach((item, i) => {
      if (!item) return
      const w = u(level.box.w)
      cover(ops, widthOf, p, { x: xs[l]![i]! - w / 2, y: u(level.box.y), w }, item, l === levels.length - 1)
    }),
  )
  return { xs: xs[0]!, bottom: u(levels[0]!.box.y) + height(0) }
}

/** The path through the year: four quarter picks, two half picks, the winner. */
function quartersTree(ops: Op[], spec: CardSpec, n: ShapeNumbers, W: number, widthOf: WidthOf) {
  const p = spec.palette
  const [bottom, middle, top] = n.tree
  const pick = (list: readonly (CardBook | null)[] | undefined, count: number) =>
    Array.from({ length: count }, (_, i) => list?.[i] ?? null)
  const { xs, bottom: under } = pathTree(
    ops, p, widthOf, W,
    [
      { box: bottom, items: pick(spec.quarters, 4) },
      { box: middle, items: pick(spec.halves, 2) },
      { box: top, items: [spec.winner] },
    ],
    [2, 2],
  )
  ;(spec.quarterNames ?? []).forEach((name, i) =>
    ops.push({
      kind: 'text', x: xs[i]!, top: under + u(8), lineHeight: u(13) * 1.25, text: name,
      font: SERIF(u(13)), color: p.inkSoft, align: 'center', tracking: 0,
    }),
  )
}

/** The whole year: 12 month favourites, 4 quarter picks, 2 half picks, the winner. */
function fullTree(ops: Op[], spec: CardSpec, n: ShapeNumbers, W: number, widthOf: WidthOf) {
  const p = spec.palette
  const [months, quarters, halves, top] = n.full
  const pick = (list: readonly (CardBook | null)[] | undefined, count: number) =>
    Array.from({ length: count }, (_, i) => list?.[i] ?? null)
  const { xs, bottom: under } = pathTree(
    ops, p, widthOf, W, 
    [
      { box: months, items: pick(spec.months, 12) },
      { box: quarters, items: pick(spec.quarters, 4) },
      { box: halves, items: pick(spec.halves, 2) },
      { box: top, items: [spec.winner] },
    ],
    [3, 2, 2],
  )
  ;(spec.monthLetters ?? []).forEach((letter, i) =>
    ops.push({
      kind: 'text', x: xs[i]!, top: under + u(5), lineHeight: u(8) * 1.25, text: letter,
      font: SANS(u(8)), color: p.inkFaint, align: 'center', tracking: 0,
    }),
  )
}

/**
 * Top 5 and Top 10: the winner big, and under it (or beside it) one row per
 * book with its tier. Tiers, not a ranking: the tournament only orders the
 * top places, so a row says "Runner-up", "Q1 pick" or "March", not a number.
 */
function tiers(ops: Op[], spec: CardSpec, n: ShapeNumbers, W: number, widthOf: WidthOf) {
  const p = spec.palette
  const L = n.list
  const dense = spec.format === 'top10' ? 1 : 0
  const rows = (spec.placings ?? []).slice(0, spec.format === 'top10' ? 9 : 4)
  const side = u(30)
  const wb = L.winner

  // The winner.
  const w = u(wb.w)
  const x = L.centered ? (W - w) / 2 : side
  const y = u(wb.y)
  cover(ops, widthOf, p, { x, y, w }, spec.winner, true)
  const room = L.centered ? W - side * 2 : u(L.x0) - side - u(16)
  const align = L.centered ? 'center' : 'left'
  const textX = L.centered ? W / 2 : side
  const title = fitText(widthOf('serif', 400), spec.winner.title, {
    maxWidth: room, maxLines: 3, size: u(wb.titleSize), minSize: u(wb.titleSize) * 0.65,
  })
  const titleTop = y + w * 1.5 + u(wb.titleGap)
  title.lines.forEach((line, i) =>
    ops.push({
      kind: 'text', x: textX, top: titleTop + i * title.size * 1.25, lineHeight: title.size * 1.25, text: line,
      font: SERIF(title.size), color: p.ink, align, tracking: 0,
    }),
  )
  const author = fitText(widthOf('sans', 400), spec.winner.author, {
    maxWidth: room, maxLines: 1, size: u(wb.authorSize), minSize: u(10),
  })
  ops.push({
    kind: 'text', x: textX, top: titleTop + title.lines.length * title.size * 1.25 + u(6), lineHeight: author.size * 1.25,
    text: author.lines[0]!, font: SANS(author.size), color: p.inkSoft, align, tracking: 0,
  })

  // The rows.
  const cw = u(L.cover[dense]!)
  const x0 = u(L.x0)
  const textLeft = x0 + cw + u(12)
  const textRoom = W - side - textLeft
  const titleSize = u(dense ? 15 : 19)
  const labelSize = u(dense ? 10.5 : 12)
  rows.forEach(({ book, label }, i) => {
    const yy = u(L.y0[dense]!) + i * u(L.pitch[dense]!)
    ops.push({ kind: 'line', points: [[x0, yy - u(5)], [W - side, yy - u(5)]], color: p.line, lineWidth: S })
    cover(ops, widthOf, p, { x: x0, y: yy, w: cw }, book, false)
    const name = fitText(widthOf('serif', 400), book.title, { maxWidth: textRoom, maxLines: 1, size: titleSize, minSize: titleSize - u(4), step: 1 })
    ops.push({
      kind: 'text', x: textLeft, top: yy + u(dense ? 2 : 8), lineHeight: name.size * 1.25, text: name.lines[0]!,
      font: SERIF(name.size), color: p.ink, align: 'left', tracking: 0,
    })
    const tag = fitText(widthOf('sans', 400), label, { maxWidth: textRoom, maxLines: 1, size: labelSize, minSize: labelSize - u(2), step: 1 })
    ops.push({
      kind: 'text', x: textLeft, top: yy + u(dense ? 19 : 32), lineHeight: tag.size * 1.25, text: tag.lines[0]!,
      font: SANS(tag.size), color: p.inkSoft, align: 'left', tracking: 0,
    })
  })
}
