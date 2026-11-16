// zip.ts: reading a kit zip, and nothing more. A plain zip (stored or
// deflated entries, no zip64, no encryption), as ONOSENDAI's workshop zips
// and most tools write them. Defensive, since a zip comes from elsewhere:
// every name is checked before it is used as a path (no absolute path, no
// "..", no backslash, no drive letter), and the sizes are capped so a small
// file cannot unpack into a huge one.

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { KitError } from './library.js'

export const ZIP_MAX_ENTRIES = 5000
export const ZIP_MAX_ENTRY_BYTES = 16 * 1024 * 1024
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024

export interface ZipEntry { name: string; data: Buffer }

/** Whether a zip entry's name is safe to use as a relative path. */
export function safeName(name: string): boolean {
  if (!name || name.length > 512 || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((part) => part !== '..' && part !== '.')
}

/** Every file in a zip: names checked, sizes capped. Throws a KitError in words. */
export function readZip(file: string): ZipEntry[] {
  let buf: Buffer
  try { buf = readFileSync(file) } catch { throw new KitError(`Cannot read ${file}.`) }
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new KitError(`${file} is not a zip.`)
  const count = buf.readUInt16LE(eocd + 10)
  if (count > ZIP_MAX_ENTRIES) throw new KitError(`${file} has ${count} entries; a kit has at most ${ZIP_MAX_ENTRIES}.`)
  let at = buf.readUInt32LE(eocd + 16)
  let total = 0
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new KitError(`${file}: its directory is damaged.`)
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const usize = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (!safeName(name)) throw new KitError(`${file}: an entry has a name that is not a safe relative path (${JSON.stringify(name.slice(0, 80))}).`)
    if (flags & 1) throw new KitError(`${file}: ${name} is encrypted.`)
    if (usize > ZIP_MAX_ENTRY_BYTES) throw new KitError(`${file}: ${name} is ${usize} bytes; a kit file is at most ${ZIP_MAX_ENTRY_BYTES}.`)
    total += usize
    if (total > ZIP_MAX_TOTAL_BYTES) throw new KitError(`${file} unpacks to more than ${ZIP_MAX_TOTAL_BYTES} bytes.`)
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new KitError(`${file}: ${name} is damaged.`)
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtraLen
    const body = buf.subarray(start, start + size)
    let data: Buffer
    if (method === 0) data = Buffer.from(body)
    else if (method === 8) {
      try { data = inflateRawSync(body, { maxOutputLength: ZIP_MAX_ENTRY_BYTES }) } catch { throw new KitError(`${file}: ${name} does not unpack.`) }
    } else throw new KitError(`${file}: ${name} uses a compression this reader does not know (method ${method}).`)
    if (data.length !== usize) throw new KitError(`${file}: ${name} unpacks to the wrong size.`)
    out.push({ name, data })
  }
  return out
}
