/**
 * 単色 PNG を生成（依存なし）。`npm run pwa:icons` で public に出力。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, '..', 'public')

function crc32(buffer) {
  let crc = -1 >>> 0
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function ihdr(w, h) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b.writeUInt8(8, 8)
  b.writeUInt8(2, 9)
  b.writeUInt8(0, 10)
  b.writeUInt8(0, 11)
  b.writeUInt8(0, 12)
  return chunk('IHDR', b)
}

function idat(w, h, r, g, bl) {
  const row = 1 + w * 3
  const raw = Buffer.alloc(row * h)
  for (let y = 0; y < h; y++) {
    let o = y * row
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      raw[o++] = r
      raw[o++] = g
      raw[o++] = bl
    }
  }
  return chunk('IDAT', zlib.deflateSync(raw, { level: 9 }))
}

function iend() {
  return chunk('IEND', Buffer.alloc(0))
}

function writeSolidPng(fileName, size, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const png = Buffer.concat([sig, ihdr(size, size), idat(size, size, rgb[0], rgb[1], rgb[2]), iend()])
  const out = path.join(publicDir, fileName)
  fs.writeFileSync(out, png)
  console.log('Wrote', out)
}

const brand = [0x86, 0x3b, 0xff]
writeSolidPng('apple-touch-icon.png', 180, brand)
writeSolidPng('pwa-192.png', 192, brand)
writeSolidPng('pwa-512.png', 512, brand)
