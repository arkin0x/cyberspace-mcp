#!/usr/bin/env node
// smoke-bundle.mjs: checks a release bundle the way a stranger would use it.
//
//   node scripts/smoke-bundle.mjs <cyberspace-mcp-X.Y.Z.tar.gz>
//
// Run it with no network (the release workflow runs it under `unshare -n`):
// the bundle must need none. It checks the tarball against the .sha256 beside
// it, unpacks it into a new temporary directory, and then requires that:
//   - there is no typescript and no symlink in it (a symlink breaks tar on Windows);
//   - `node dist/bin.js --help` exits 0;
//   - the stdio server answers an MCP initialize and lists its tools;
//   - two worker_threads entries load with every import they need
//     (avatarMine.js exits cleanly with no work; rideWorker.js starts and waits).
// Exit 0 when all hold, 1 otherwise. Nothing is removed afterwards.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

function fail(msg) {
  console.error(`smoke-bundle: FAIL ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.error(`smoke-bundle: ok ${msg}`)

const tarball = resolve(process.argv[2] ?? fail('usage: smoke-bundle.mjs <tarball>'))
const shaLine = readFileSync(`${tarball}.sha256`, 'utf8')
const want = /^([0-9a-f]{64}) {2}(\S+)\n$/.exec(shaLine)
if (!want || want[2] !== basename(tarball)) fail(`${tarball}.sha256 is not one line naming ${basename(tarball)}`)
if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== want[1]) fail('the tarball does not match its .sha256')
ok('sha256')

const into = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-smoke-'))
execFileSync('tar', ['-xzf', tarball, '-C', into])
const tops = readdirSync(into)
if (tops.length !== 1) fail(`the tarball holds ${tops.length} top-level entries, not one folder`)
const root = join(into, tops[0])
ok(`unpacked to ${root}`)

if (existsSync(join(root, 'node_modules', 'typescript'))) fail('typescript is in the bundle')
const links = []
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) links.push(p.slice(root.length + 1))
    else if (st.isDirectory()) walk(p)
  }
}
walk(root)
if (links.length) fail(`symlinks in the bundle: ${links.slice(0, 5).join(', ')}${links.length > 5 ? ', ...' : ''}`)
ok('no typescript, no symlinks')

const bin = join(root, 'dist', 'bin.js')
try {
  execFileSync(process.execPath, [bin, '--help'], { stdio: ['ignore', 'ignore', 'pipe'] })
} catch (e) {
  fail(`--help exited ${e.status ?? e.signal ?? e.message}${e.stderr?.length ? `: ${String(e.stderr).trim().split('\n').pop()}` : ''}`)
}
ok('--help')

// The stdio server: initialize, then tools/list.
const state = join(into, 'state')
mkdirSync(state)
const tools = await new Promise((res, rej) => {
  const p = spawn(process.execPath, [bin, '--state', state], { stdio: ['pipe', 'pipe', 'ignore'] })
  const timer = setTimeout(() => { p.kill(); rej(new Error('no tools/list answer in 60 s')) }, 60_000)
  let buf = ''
  p.on('exit', (code) => rej(new Error(`the server exited (${code}) before answering`)))
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.id === 1) {
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      } else if (m.id === 2) {
        clearTimeout(timer)
        p.removeAllListeners('exit')
        p.kill()
        res(m.result?.tools?.length ?? 0)
      }
    }
  })
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-bundle', version: '0' } } })}\n`)
}).catch((e) => fail(`stdio server: ${e.message}`))
if (!(tools > 0)) fail('the server listed no tools')
ok(`stdio initialize and tools/list: ${tools} tools`)

// Worker entries: loading one resolves every module it imports from the bundle.
function runWorker(file, options, settle) {
  return new Promise((res, rej) => {
    const w = new Worker(pathToFileURL(join(root, 'dist', file)), options)
    w.on('error', (e) => rej(new Error(`${file}: ${e.message}`)))
    settle(w, res, rej)
  })
}
await runWorker('avatarMine.js', {}, (w, res, rej) => {
  w.on('exit', (code) => (code === 0 ? res() : rej(new Error(`avatarMine.js exited ${code}`))))
}).catch((e) => fail(`worker: ${e.message}`))
await runWorker(join('hyperspace', 'rideWorker.js'), { workerData: { stop: new SharedArrayBuffer(4) } }, (w, res, rej) => {
  w.on('exit', (code) => rej(new Error(`rideWorker.js exited ${code} on its own`)))
  w.on('online', () => setTimeout(() => { w.removeAllListeners('exit'); w.terminate().then(res) }, 1500))
}).catch((e) => fail(`worker: ${e.message}`))
ok('worker entries load (avatarMine.js, hyperspace/rideWorker.js)')

console.error(`smoke-bundle: all checks passed for ${basename(tarball)} (${dirname(root)})`)
