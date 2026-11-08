// nodeVersion.test.ts: bin.ts refuses a Node older than 22 with one line,
// before the relay client's imports can crash on the missing global
// WebSocket, and lets 22 and newer through.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIN_NODE_MAJOR, nodeTooOld } from '../src/nodeVersion.js'

describe('the Node version guard', () => {
  it('lets Node 22 and newer through', () => {
    expect(MIN_NODE_MAJOR).toBe(22)
    for (const v of ['22.0.0', '22.22.3', 'v22.1.0', '23.4.1', '24.0.0', '30.1.2']) expect(nodeTooOld(v)).toBeNull()
  })

  it('refuses anything older with one line that names both versions', () => {
    for (const v of ['20.20.2', 'v21.7.3', '18.0.0', '16.20.0']) {
      const line = nodeTooOld(v)
      expect(line).not.toBeNull()
      expect(line).not.toContain('\n')
      expect(line).toContain('Node 22 or newer')
      expect(line).toContain(`v${v.replace(/^v/, '')}`)
    }
  })

  it('refuses a version it cannot read', () => {
    expect(nodeTooOld('')).not.toBeNull()
    expect(nodeTooOld('banana')).not.toBeNull()
  })

  it('agrees with engines.node in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } }
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`)
  })

  it('bin.ts imports nothing but the guard before it checks', () => {
    const src = readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf8')
    const staticImports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(staticImports).toEqual(['./nodeVersion.js'])
    expect(src).toContain("await import('./cli.js')")
  })
})
