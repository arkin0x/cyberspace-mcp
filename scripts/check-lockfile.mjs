// check-lockfile.mjs: every package the lockfile takes from the npm registry
// carries a sha512 integrity hash and an https registry.npmjs.org URL, and
// every git dependency is pinned by a full commit hash (security review,
// 2026-11-23: a regeneration in October had dropped 158 of 159 hashes, so
// npm ci trusted whatever the registry served). Exits 1 naming each entry
// that fails.
import { readFileSync } from 'node:fs'

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const bad = []
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '' || entry.link) continue
  const resolved = entry.resolved ?? ''
  if (resolved.startsWith('git+')) {
    if (!/#[0-9a-f]{40}$/.test(resolved)) bad.push(`${path}: git dependency not pinned by a full commit (${resolved})`)
    continue
  }
  if (!resolved.startsWith('https://registry.npmjs.org/')) bad.push(`${path}: resolved is not an https registry.npmjs.org URL (${resolved || 'missing'})`)
  if (!/^sha512-/.test(entry.integrity ?? '')) bad.push(`${path}: no sha512 integrity hash`)
}
const deps = { ...(lock.packages?.['']?.dependencies ?? {}), ...(lock.packages?.['']?.devDependencies ?? {}) }
for (const [name, spec] of Object.entries(deps)) {
  if (spec.startsWith('git') && !/#[0-9a-f]{40}$/.test(spec)) bad.push(`package.json ${name}: git dependency not pinned by a full commit (${spec})`)
}
if (bad.length) {
  console.error(`package-lock.json: ${bad.length} problem(s)\n${bad.join('\n')}`)
  process.exit(1)
}
console.log('package-lock.json: every registry package has a sha512 hash and an https registry URL; every git dependency is pinned by commit')
