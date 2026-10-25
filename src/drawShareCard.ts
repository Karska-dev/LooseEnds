import { SIZES, layoutCard } from './shareCard'
import type { CardSpec, FontSpec, Op } from './shareCard'

/**
 * The imperative half of the share picture: fonts, a <canvas>, drawing.
 * What goes where is decided in shareCard.ts.
 *
 * Why Canvas 2D in the browser: it is free, instant and nothing is
 * uploaded (privacy by design). The alternatives were a server that renders
 * the picture, which would need the book sent to it, and an HTML-to-image
 * library, whose fonts and Cyrillic fail often.
 */

const FAMILY = {
  serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  sans: '"Golos Text", system-ui, -apple-system, "Segoe UI", sans-serif',
} as const

const css = (font: FontSpec) => `${font.weight} ${font.size}px ${FAMILY[font.family]}`

/**
 * A web font is fetched only when something on the page uses it, and in
 * pieces by alphabet. Drawing before it arrives would silently use the
 * fallback font, so ask for exactly the weights and the letters about to be
 * drawn, and wait.
 */
async function loadFonts(ops: Op[]) {
  const wanted = new Map<string, Set<string>>()
  for (const op of ops) {
    if (op.kind !== 'text') continue
    const key = css({ ...op.font, size: 16 })
    const text = wanted.get(key) ?? new Set<string>()
    for (const letter of op.text) text.add(letter)
    wanted.set(key, text)
  }
  try {
    await Promise.all([...wanted].map(([font, letters]) => document.fonts.load(font, [...letters].join(''))))
    await document.fonts.ready
  } catch {
    // The fallback fonts still make a usable picture.
  }
}

/** Draws `text` letter by letter when it has extra spacing (letterSpacing on a canvas is not everywhere yet). */
function drawText(ctx: CanvasRenderingContext2D, op: Extract<Op, { kind: 'text' }>) {
  ctx.font = css(op.font)
  ctx.fillStyle = op.color
  ctx.textBaseline = 'alphabetic'
  const letters = Array.from(op.text)
  const widths = op.tracking > 0 ? letters.map((l) => ctx.measureText(l).width + op.tracking) : [ctx.measureText(op.text).width]
  const total = widths.reduce((a, b) => a + b, 0) - (op.tracking > 0 ? op.tracking : 0)
  const startX = op.align === 'left' ? op.x : op.align === 'right' ? op.x - total : op.x - total / 2

  // CSS puts a line's text in the middle of its line box; a canvas wants a
  // baseline. Work it out from the font's own ascent and descent.
  const metrics = ctx.measureText('Hg')
  const ascent = metrics.fontBoundingBoxAscent ?? op.font.size * 0.8
  const descent = metrics.fontBoundingBoxDescent ?? op.font.size * 0.2
  const baseline = op.top + (op.lineHeight - (ascent + descent)) / 2 + ascent

  ctx.textAlign = 'left'
  if (op.tracking > 0) {
    let x = startX
    letters.forEach((letter, i) => {
      ctx.fillText(letter, x, baseline)
      x += widths[i]!
    })
  } else {
    ctx.fillText(op.text, startX, baseline)
  }
}

const CROWN = new Path2D('M3 16 1.5 6l5 4L10 3l3.5 7 5-4L17 16z')

function draw(ctx: CanvasRenderingContext2D, ops: Op[]) {
  for (const op of ops) {
    switch (op.kind) {
      case 'fill':
        ctx.fillStyle = op.color
        ctx.fillRect(op.x, op.y, op.w, op.h)
        break
      case 'cover':
        ctx.fillStyle = op.fill
        ctx.fillRect(op.x, op.y, op.w, op.h)
        // A border sits inside the box, as in CSS: stroke half a line in.
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = op.lineWidth
        ctx.strokeRect(op.x + op.lineWidth / 2, op.y + op.lineWidth / 2, op.w - op.lineWidth, op.h - op.lineWidth)
        break
      case 'frame':
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.lineWidth
        ctx.strokeRect(op.x, op.y, op.w, op.h)
        break
      case 'line':
        ctx.strokeStyle = op.color
        ctx.lineWidth = op.lineWidth
        ctx.lineJoin = 'miter'
        ctx.beginPath()
        op.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.stroke()
        break
      case 'crown':
        ctx.fillStyle = op.bg
        ctx.fillRect(op.x, op.y, op.size, op.size)
        ctx.save()
        ctx.translate(op.x + (op.size - op.iconSize) / 2, op.y + (op.size - op.iconSize) / 2)
        ctx.scale(op.iconSize / 20, op.iconSize / 20)
        ctx.fillStyle = op.fg
        ctx.fill(CROWN)
        ctx.restore()
        break
      case 'text':
        drawText(ctx, op)
        break
    }
  }
}

/** A picture, drawn on a new canvas of the spec's shape. */
export async function renderCard(spec: CardSpec): Promise<HTMLCanvasElement> {
  const { width, height } = SIZES[spec.shape]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  // Layout first with a ruler, so the fonts it will need are known. Then
  // load them and lay out again with the real widths.
  const ruler = (text: string, font: FontSpec) => {
    ctx.font = css(font)
    return ctx.measureText(text).width
  }
  await loadFonts(layoutCard(spec, ruler))
  draw(ctx, layoutCard(spec, ruler))
  return canvas
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no picture'))), 'image/png'),
  )
}
