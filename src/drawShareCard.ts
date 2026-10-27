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

/**
 * Loads the photographs. A picture that fails to load is simply missing: the
 * plain ground is still a readable picture, better than none. Same-origin
 * files only, so the canvas stays exportable (a cross-origin image would
 * taint it and `toBlob` would refuse).
 */
async function loadImages(ops: Op[]): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>()
  await Promise.all(
    ops.map(async (op) => {
      if (op.kind !== 'image' || images.has(op.src)) return
      const image = new Image()
      image.src = op.src
      try {
        await image.decode()
        images.set(op.src, image)
      } catch {
        // Leave it out.
      }
    }),
  )
  return images
}

/** Scaled to cover the box, centred, the overflow cropped: like CSS background-size: cover. */
function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.max(box.w / image.naturalWidth, box.h / image.naturalHeight)
  const sw = box.w / scale
  const sh = box.h / scale
  ctx.drawImage(image, (image.naturalWidth - sw) / 2, (image.naturalHeight - sh) / 2, sw, sh, box.x, box.y, box.w, box.h)
}

/**
 * Frosted glass: what is under the box, blurred. The canvas `filter` does it
 * where it exists; Safari has none, so there the picture is shrunk and drawn
 * back up smoothed, which is a blur too, only blockier.
 */
/** Safari has no ctx.filter. A plain function, so the else branch keeps its type. */
const canBlur = (ctx: object): boolean => 'filter' in ctx

function drawGlass(ctx: CanvasRenderingContext2D, op: Extract<Op, { kind: 'glass' }>) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(op.x, op.y, op.w, op.h)
  ctx.clip()
  if (canBlur(ctx)) {
    ctx.filter = `blur(${op.blur}px)`
    ctx.drawImage(ctx.canvas, 0, 0)
    ctx.filter = 'none'
  } else {
    const small = document.createElement('canvas')
    const k = Math.max(2, Math.round(op.blur / 2))
    small.width = Math.ceil(ctx.canvas.width / k)
    small.height = Math.ceil(ctx.canvas.height / k)
    const sctx = small.getContext('2d')
    if (sctx) {
      sctx.imageSmoothingQuality = 'high'
      sctx.drawImage(ctx.canvas, 0, 0, small.width, small.height)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, ctx.canvas.width, ctx.canvas.height)
    }
  }
  ctx.restore()
  ctx.fillStyle = op.fill
  ctx.fillRect(op.x, op.y, op.w, op.h)
  ctx.strokeStyle = op.border
  ctx.lineWidth = op.lineWidth
  ctx.strokeRect(op.x + op.lineWidth / 2, op.y + op.lineWidth / 2, op.w - op.lineWidth, op.h - op.lineWidth)
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

function draw(ctx: CanvasRenderingContext2D, ops: Op[], images: Map<string, HTMLImageElement>) {
  for (const op of ops) {
    switch (op.kind) {
      case 'fill':
        ctx.fillStyle = op.color
        ctx.fillRect(op.x, op.y, op.w, op.h)
        break
      case 'image': {
        const image = images.get(op.src)
        if (image) drawCover(ctx, image, op)
        break
      }
      case 'gradient': {
        const gradient = ctx.createLinearGradient(0, op.y, 0, op.y + op.h)
        for (const [at, color] of op.stops) gradient.addColorStop(at, color)
        ctx.fillStyle = gradient
        ctx.fillRect(op.x, op.y, op.w, op.h)
        break
      }
      case 'glass':
        drawGlass(ctx, op)
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
  const first = layoutCard(spec, ruler)
  const [, images] = await Promise.all([loadFonts(first), loadImages(first)])
  draw(ctx, layoutCard(spec, ruler), images)
  return canvas
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no picture'))), 'image/png'),
  )
}
