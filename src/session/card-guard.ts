/**
 * Keeping the agent off its own status card where the card shows in captures (Linux).
 *
 * macOS and Windows exclude the card from screen capture (`sharingType = .none`, `WDA_EXCLUDEFROMCAPTURE`). X11 has no
 * equivalent, so on Linux the card reports its rectangle (`card.json`, read through `OperatorControl.cardRegion`) and
 * the session does two things with it: every capture paints that rectangle grey before the image leaves the native
 * layer, so the agent never reads the card or a Stop button an injected page could point it at; and a click, press or
 * drag whose point lies inside it is refused with `status_card_protected`. Wrapping `takeScreenshot` itself covers
 * every caller (screenshot, zoom, snapshot, verify, doctor) without each one knowing about the card.
 */

import { createHash } from 'node:crypto'
import type { NativeModule } from '../native.js'
import { StructuredToolError } from './errors.js'
import type { CardRect } from './operator-control.js'

type Capture = ReturnType<NativeModule['takeScreenshot']>

/** True when the point lies inside the rectangle (right and bottom edges excluded). */
export function insideRect(x: number, y: number, rect: CardRect): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

/**
 * The card's rectangle in a capture's image pixels, as flat `[x, y, width, height]`, or undefined when the card is
 * not in the captured rectangle. `capture` is the captured area in screen pixels; the image may be scaled from it.
 * Rounded outward, so a downscaled edge pixel that blends the card in is painted too.
 */
export function maskRects(card: CardRect, capture: CardRect, image: { width: number; height: number }): number[] | undefined {
  const left = Math.max(card.x, capture.x)
  const top = Math.max(card.y, capture.y)
  const right = Math.min(card.x + card.width, capture.x + capture.width)
  const bottom = Math.min(card.y + card.height, capture.y + capture.height)
  if (right <= left || bottom <= top || capture.width <= 0 || capture.height <= 0) return undefined
  const sx = image.width / capture.width
  const sy = image.height / capture.height
  const x1 = Math.max(0, Math.floor((left - capture.x) * sx))
  const y1 = Math.max(0, Math.floor((top - capture.y) * sy))
  const x2 = Math.min(image.width, Math.ceil((right - capture.x) * sx))
  const y2 = Math.min(image.height, Math.ceil((bottom - capture.y) * sy))
  return x2 > x1 && y2 > y1 ? [x1, y1, x2 - x1, y2 - y1] : undefined
}

/**
 * The screen area a capture covers: the window's bounds for a window capture, the whole screen for a screen capture.
 * Undefined when it cannot be told (an X11 capture of the focused window, which has neither id nor the screen's
 * shape), and then nothing is masked.
 */
export function captureArea(native: NativeModule, windowId: number | null | undefined, image: { width: number; height: number }): CardRect | undefined {
  if (typeof windowId === 'number') {
    const bounds = native.getWindow?.(windowId)?.bounds
    return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : undefined
  }
  const display = native.getDisplaySize()
  if (!display.width || !display.height || !image.width || !image.height) return undefined
  const sameShape = Math.abs(image.width / image.height - display.width / display.height) < 0.02
  return sameShape ? { x: 0, y: 0, width: display.width, height: display.height } : undefined
}

/** A capture with the card painted out, its hash recomputed so unchanged-capture detection sees the masked image. */
function masked(native: NativeModule, region: () => CardRect | undefined, image: Capture, args: unknown[]): Capture {
  const card = region()
  if (!card || !image?.base64) return image
  const [, , quality, previousHash, windowId] = args as [unknown, unknown, number | undefined, string | undefined, number | undefined]
  const area = captureArea(native, windowId, image)
  const rects = area ? maskRects(card, area, image) : undefined
  if (!rects) return image
  if (typeof native.maskImage !== 'function') {
    throw new StructuredToolError('The native module cannot mask the status card out of captures', {
      error: 'card_mask_unavailable',
      reason: 'The Linux status card shows in captures and this native module has no maskImage, so the capture was withheld.',
      remediation: ['Rebuild the native module (npm run build:native) or reinstall the package.', 'Or turn the card off: COMPUTER_USE_STATUS_CARD=false.'],
    })
  }
  const painted = native.maskImage(image.base64, rects, image.mimeType === 'image/png' ? 0 : typeof quality === 'number' ? quality : 80)
  const hash = createHash('sha1').update(painted.base64).digest('hex').slice(0, 16)
  if (typeof previousHash === 'string' && previousHash === hash) {
    const { base64: _omitted, ...rest } = image
    return { ...rest, hash, unchanged: true }
  }
  return { ...image, base64: painted.base64, hash, unchanged: false, cardMasked: true }
}

/** The native module with every screen capture passed through the card mask; everything else untouched. */
export function maskCardInCaptures(native: NativeModule, region: () => CardRect | undefined): NativeModule {
  return new Proxy(native, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'takeScreenshot') {
        return (...args: unknown[]) => masked(target, region, (value as (...a: unknown[]) => Capture).apply(target, args), args)
      }
      if (property === 'takeScreenshotAsync') {
        return async (...args: unknown[]) => masked(target, region, await (value as (...a: unknown[]) => Promise<Capture>).apply(target, args), args)
      }
      return value
    },
  })
}

/** The refusal for a pointer action aimed at the card. */
export function cardClickRefusal(x: number, y: number, card: CardRect): StructuredToolError {
  return new StructuredToolError(`(${x}, ${y}) is on the desktop status card`, {
    error: 'status_card_protected',
    coordinate: [x, y],
    card,
    message: 'That point is on the status card the person uses to pause or stop the agent; the agent may not press it. Captures paint the card grey.',
  })
}
