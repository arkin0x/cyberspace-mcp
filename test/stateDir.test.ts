// stateDir.test.ts: the state directory with no --state is the one init and
// serve use ($CYBERSPACE_MCP_STATE, else ~/.cyberspace-mcp), for the stdio
// server too; and a leading ~/ in --state or $CYBERSPACE_MCP_STATE is the
// home directory, since MCP clients start a stdio server without a shell.
// No network: the CLI runs below are `wake status` and an `init
// --no-publish`, under a temporary HOME.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { parseArgs, settingsFrom } from '../src/config.js'
import { defaultStateDir, expandHome } from '../src/serveConfig.js'

const BIN = new URL('../src/bin.ts', import.meta.url).pathname

/** Run the command under tsx with HOME (and nothing else of ours) set. */
function cli(home: string, argv: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const { CYBERSPACE_MCP_STATE: _drop, ...rest } = process.env
  const run = spawnSync(process.execPath, ['--import', 'tsx', BIN, ...argv], { encoding: 'utf8', env: { ...rest, HOME: home, USERPROFILE: home, ...env }, timeout: 60_000 })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

describe('expandHome', () => {
  it('reads a leading ~ or ~/ as the home directory and leaves everything else', () => {
    expect(expandHome('~', '/home/a')).toBe('/home/a')
    expect(expandHome('~/agent', '/home/a')).toBe('/home/a/agent')
    expect(expandHome('~/x/y', '/home/a')).toBe('/home/a/x/y')
    expect(expandHome('/abs/agent', '/home/a')).toBe('/abs/agent')
    expect(expandHome('rel/agent', '/home/a')).toBe('rel/agent')
    expect(expandHome('~bob/agent', '/home/a')).toBe('~bob/agent')
    expect(expandHome('a/~/b', '/home/a')).toBe('a/~/b')
  })
})

describe('the state directory', () => {
  it('defaults to $CYBERSPACE_MCP_STATE, with ~/ expanded, else ~/.cyberspace-mcp', () => {
    expect(defaultStateDir({})).toBe(join(homedir(), '.cyberspace-mcp'))
    expect(defaultStateDir({ CYBERSPACE_MCP_STATE: '/srv/agent' })).toBe('/srv/agent')
    expect(defaultStateDir({ CYBERSPACE_MCP_STATE: '~/agent' })).toBe(join(homedir(), 'agent'))
    expect(defaultStateDir({ CYBERSPACE_MCP_STATE: '  ' })).toBe(join(homedir(), '.cyberspace-mcp'))
  })

  it('--state ~/x is the home directory, with or without a shell', () => {
    expect(parseArgs(['--state', '~/agent']).state).toBe(join(homedir(), 'agent'))
    expect(settingsFrom(parseArgs(['--state', '~/agent']), {}).stateDir).toBe(join(homedir(), 'agent'))
    expect(parseArgs(['--state', '/x']).state).toBe('/x')
  })

  it('wake status reads ~/ in --state, and the default with none', () => {
    const home = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-home-'))
    const named = cli(home, ['wake', 'status', '--state', '~/agent'])
    expect(named.status).toBe(0)
    expect(named.out).toContain(`no server holds ${join(home, 'agent')}`)
    const bare = cli(home, ['wake', 'status'])
    expect(bare.out).toContain(`no server holds ${join(home, '.cyberspace-mcp')}`)
  })

  it('init --state ~/x makes the directory in the home directory, not a folder named ~', () => {
    const home = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-home-'))
    const operator = nip19.npubEncode(getPublicKey(generateSecretKey()))
    const r = cli(home, ['init', '--state', '~/agent', '--operator', operator, '--client', 'none', '--yes', '--no-publish'])
    expect(r.status, r.out).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'agent', 'config.json'), 'utf8')).operator).toBe(operator)
    expect(existsSync(join(home, 'agent', 'key'))).toBe(true)
    expect(existsSync(join(process.cwd(), '~'))).toBe(false)
  })
})
