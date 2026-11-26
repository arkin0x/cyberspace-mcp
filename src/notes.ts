// notes.ts: the agent's own notes, <state>/notes.md (arkinox, 2026-11-26:
// "memory notes"). What it built where, and why, kept across sessions so a
// later turn reads them before building or deleting. Local only (mode 600),
// never published; capped so a loop cannot fill the disk.

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'

const FILE = 'notes.md'
/** The most the notes may hold, in bytes (UTF-8). */
export const MAX_NOTES_BYTES = 64 * 1024

/** The notes file: read whole, written whole (fsynced), capped at MAX_NOTES_BYTES. */
export class Notes {
  constructor(private readonly dir: StateDir) {}

  /** The notes as they are, or empty. */
  read(): string {
    try { return readFileSync(this.dir.file(FILE), 'utf8') } catch { return '' }
  }

  /** Write the notes whole (a temporary file, fsynced, then a rename), mode 600; refused above the cap. */
  private write(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_NOTES_BYTES) throw new Refusal(`Your notes would be ${bytes} bytes; they hold at most ${MAX_NOTES_BYTES}. Nothing was changed. Shorten them: notes with replace writes them whole.`)
    this.dir.guard(`write ${FILE}`)
    const target = this.dir.file(FILE)
    const tmp = `${target}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  }

  /** The notes tool: read (no input), append one line, or replace them all. */
  tool(input: { append?: string; replace?: string }): ToolResult {
    if (input.append !== undefined && input.replace !== undefined) throw new Refusal('Give append (adds a line) or replace (writes them all), not both. Nothing was changed.')
    if (input.append !== undefined) {
      const line = String(input.append).replace(/\s*\n\s*/g, ' ').trim()
      if (!line) throw new Refusal('append is a line of words, not empty. Nothing was changed.')
      const before = this.read()
      const next = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`
      this.write(next)
      return { text: `Added to your notes (${Buffer.byteLength(next, 'utf8')} of ${MAX_NOTES_BYTES} bytes): ${line}`, data: { bytes: Buffer.byteLength(next, 'utf8'), max: MAX_NOTES_BYTES, appended: line } }
    }
    if (input.replace !== undefined) {
      const text = String(input.replace)
      this.write(text)
      return { text: `Your notes now hold ${Buffer.byteLength(text, 'utf8')} of ${MAX_NOTES_BYTES} bytes.`, data: { bytes: Buffer.byteLength(text, 'utf8'), max: MAX_NOTES_BYTES, replaced: true } }
    }
    const text = this.read()
    return { text: text ? `Your notes (${Buffer.byteLength(text, 'utf8')} of ${MAX_NOTES_BYTES} bytes; your own words, kept on this machine):\n${text}` : 'Your notes are empty. Write what you build where, and why: notes with append adds a line.', data: { notes: text, bytes: Buffer.byteLength(text, 'utf8'), max: MAX_NOTES_BYTES } }
  }
}
