// stdioStdin.test.ts: the stdio server stops, and releases the state
// directory's lock, when its stdin ends: a client that dies without closing
// the MCP connection must not leave an orphan holding the lock (the
// default directory is shared with init and serve). No network: the only
// relay named is a closed port on 127.0.0.1.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BIN = new URL('../src/bin.ts', import.meta.url).pathname

describe('the stdio server and its stdin', () => {
  it('stops with exit 0 and frees the lock when stdin ends', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-stdin-'))
    const state = join(home, 'agent')
    const { CYBERSPACE_MCP_STATE: _drop, ...env } = process.env
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, '--state', state, '--relay', 'ws://127.0.0.1:9'], { env: { ...env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += String(d) })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    try {
      const deadline = Date.now() + 45_000
      while (!err.includes('state in ') && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 50))
      expect(err, err).toContain('state in ')
      expect(existsSync(join(state, 'lock'))).toBe(true)
      child.stdin.end()
      const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 15_000))])
      expect(code, err).toBe(0)
      expect(err).toMatch(/stopping: stdin (ended|closed): the client is gone/)
      expect(existsSync(join(state, 'lock'))).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 90_000)
})
