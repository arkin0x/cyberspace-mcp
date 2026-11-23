// version.ts: this copy's version, read once from its package.json. Two
// readers: the update notices (updates.ts), which compare it with the
// release key's releases, and the client tag (nostr/event.ts), which carries
// it on every attributed event so a client such as ONOSENDAI can tell an
// operator their agent runs an old copy.

import { readFileSync } from 'node:fs'

/** A running version: X.Y.Z, each part at most six digits, optionally with a -<pre-release>. */
const RUNNING = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]+)?$/

/** This copy's version from its package.json (one folder above src/ and dist/), or null when it cannot be read or is not a version. */
export function readVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown }
    return pkg.name === 'cyberspace-mcp' && typeof pkg.version === 'string' && RUNNING.test(pkg.version) ? pkg.version : null
  } catch {
    return null
  }
}
