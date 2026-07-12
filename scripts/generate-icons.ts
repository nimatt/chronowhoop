// Generates placeholder PWA icons (solid background + blocky "CW") into public/icons/.
// Run: bun scripts/generate-icons.ts
// Replace with real artwork in a later phase.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKGROUND: Rgb = [0x0b, 0x12, 0x20]
const FOREGROUND: Rgb = [0x7e, 0xa6, 0xff]

type Rgb = [number, number, number]

const GLYPH_ROWS = 7
const LETTERS = [
  ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
]
const LETTER_GAP = 1
const GLYPH_COLS = LETTERS.reduce((cols, letter) => cols + letter[0].length, 0) + LETTER_GAP

function isLetterPixel(col: number, row: number): boolean {
  let offset = 0
  for (const letter of LETTERS) {
    const width = letter[0].length
    if (col < offset + width) return letter[row][col - offset] === '#'
    offset += width + LETTER_GAP
    if (col < offset) return false
  }
  return false
}

function renderIcon(size: number, coverage: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 3)
  const scale = Math.max(1, Math.floor((size * coverage) / GLYPH_COLS))
  const left = Math.floor((size - GLYPH_COLS * scale) / 2)
  const top = Math.floor((size - GLYPH_ROWS * scale) / 2)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const col = Math.floor((x - left) / scale)
      const row = Math.floor((y - top) / scale)
      const inGlyphArea =
        x >= left && y >= top && col < GLYPH_COLS && row < GLYPH_ROWS && isLetterPixel(col, row)
      const [r, g, b] = inGlyphArea ? FOREGROUND : BACKGROUND
      const i = (y * size + x) * 3
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
    }
  }
  return pixels
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = concat(typeBytes, data)
  return concat(uint32be(data.length), body, uint32be(crc32(body)))
}

function encodePng(size: number, rgbPixels: Uint8Array): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const RGB_COLOR_TYPE = 2
  const ihdr = concat(
    uint32be(size),
    uint32be(size),
    new Uint8Array([8, RGB_COLOR_TYPE, 0, 0, 0]),
  )
  const bytesPerRow = size * 3
  const filtered = new Uint8Array((bytesPerRow + 1) * size)
  for (let y = 0; y < size; y++) {
    filtered.set(rgbPixels.subarray(y * bytesPerRow, (y + 1) * bytesPerRow), y * (bytesPerRow + 1) + 1)
  }
  return concat(
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(filtered))),
    chunk('IEND', new Uint8Array(0)),
  )
}

const outputDir = fileURLToPath(new URL('../public/icons', import.meta.url))
mkdirSync(outputDir, { recursive: true })

const icons: { file: string; size: number; coverage: number }[] = [
  { file: 'icon-192.png', size: 192, coverage: 0.72 },
  { file: 'icon-512.png', size: 512, coverage: 0.72 },
  { file: 'icon-maskable-512.png', size: 512, coverage: 0.45 },
]

for (const { file, size, coverage } of icons) {
  const path = join(outputDir, file)
  writeFileSync(path, encodePng(size, renderIcon(size, coverage)))
  console.log(`wrote ${path}`)
}
