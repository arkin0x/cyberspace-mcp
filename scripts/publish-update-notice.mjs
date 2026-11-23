#!/usr/bin/env node
// publish-update-notice.mjs: announces a release to every running copy, as
// NIP-82 events (nostr-protocol/nips#2526) signed by the release key (D6):
//
//   kind 32267  the app listing, d "cyberspace-mcp" (republished each time; addressable)
//   kind 3063   the release bundle: x = its sha256, url, version, m, f, size, filename, commit, min_allowed_version
//   kind 30063  the release, d "cyberspace-mcp@<version>": i, version, c main, f, e -> the 3063, a -> the 32267,
//               commit, and two tags of ours that other readers skip: security and min_allowed_version
//
// Every running copy reads the 30063 (src/updates.ts) and trusts it only when
// the release key compiled into it signed it. It tells its operator; it never
// installs anything (docs/releasing.md, "Update notices").
//
// Run it on the machine that holds the key, after the release is signed and
// published (docs/releasing.md step 8), in a clone after npm ci --ignore-scripts:
//
//   node scripts/publish-update-notice.mjs --key <keyfile> --version X.Y.Z --sha256-file <cyberspace-mcp-X.Y.Z.tar.gz.sha256>
//        --note "<one line>" [--min-safe X.Y.Z] [--security] [--commit <40 hex>] [--relay <wss://...>]... [--publish]
//
// Without --publish it is a dry run: it builds and signs the three events,
// reads the 30063 back with the server's own parser exactly as a copy would,
// and prints all three with their signatures withheld (a signed event printed
// is a notice anyone could publish early). Nothing is sent. With --publish it
// sends them, refusing unless the key is the release key, then reads the
// release back from each relay. Before sending it checks that the tag
// v<version> is in this clone, matches --commit and carries that version in
// package.json, and asks for the version typed. The secret is never printed.

import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { Relay } from 'nostr-tools/relay'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_ID, APP_KIND, ASSET_KIND, CHANNEL, NOTICE_RELAY, RELEASE_KIND, RELEASE_PUBKEY, appAddress, compareSemver, noteOf, noticeFilter, parseNotice, parseSemver,
} from '../dist/updates.js'

/** Node 22 runs the bundle wherever it runs: NIP-82 says list every platform. */
export const PLATFORMS = ['linux-x86_64', 'linux-aarch64', 'darwin-arm64', 'darwin-x86_64', 'windows-x86_64', 'windows-aarch64']
const REPOSITORY = 'https://github.com/arkin0x/cyberspace-mcp'

function fail(msg) {
  console.error(`publish-update-notice: ${msg}`)
  process.exit(1)
}

function readKey(path) {
  if (!path) fail('--key <keyfile> is required')
  const st = statSync(path)
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) fail(`${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`)
  const hex = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) fail(`${path} does not hold a 64-hex-character secret key`)
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

/** The arguments, strictly: an unknown flag stops the script rather than being ignored. */
function parseArgs(argv) {
  const out = { relays: [], publish: false, security: false }
  const flags = new Set()
  const takes = new Set(['--key', '--version', '--sha256-file', '--note', '--min-safe', '--commit', '--relay', '--created-at'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--publish' || a === '--security') {
      if (flags.has(a)) fail(`${a} was given twice`)
      flags.add(a)
      out[a.slice(2)] = true
      continue
    }
    if (!takes.has(a)) fail(`unknown argument ${a}`)
    const v = argv[++i]
    if (v === undefined) fail(`${a} needs a value`)
    if (a === '--relay') {
      if (!/^wss:\/\/[^\s/]+/.test(v)) fail(`--relay ${v} is not a wss:// URL`)
      out.relays.push(v)
      continue
    }
    const name = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    // Given twice is a mistake to stop at, never a choice to make quietly: what is published stays on every copy.
    if (name in out) fail(`${a} was given twice`)
    out[name] = v
  }
  return out
}

/** The three events, unsigned. */
export function templates({ version, sha256, filename, size, note, minSafe, security, commit, createdAt, releasePubkey, relay }) {
  const url = `${REPOSITORY}/releases/download/v${version}/${filename}`
  const app = {
    kind: APP_KIND, created_at: createdAt, content: 'A local MCP server that gives an AI agent a body in cyberspace: its own key, its movement chain, and intent-level tools built on cyberspace-core and sno-core.',
    tags: [['d', APP_ID], ['name', 'cyberspace-mcp'], ...PLATFORMS.map((f) => ['f', f]), ['summary', 'Give an AI agent a body in cyberspace.'], ['url', REPOSITORY], ['repository', `${REPOSITORY}.git`], ['license', 'MIT']],
  }
  const asset = {
    kind: ASSET_KIND, created_at: createdAt, content: '',
    tags: [
      ['i', APP_ID], ['x', sha256], ['version', version],
      // NIP-82 Appendix C lists no generic archive; the bundle is one (docs/releasing.md, "Update notices", says why it is published anyway).
      ['m', 'application/gzip'],
      ...PLATFORMS.map((f) => ['f', f]), ['url', url], ...(size !== null ? [['size', String(size)]] : []), ['filename', filename],
      ...(commit ? [['commit', commit]] : []), ...(minSafe ? [['min_allowed_version', minSafe]] : []),
    ],
  }
  const release = (assetId) => ({
    kind: RELEASE_KIND, created_at: createdAt, content: note,
    tags: [
      ['i', APP_ID], ['version', version], ['d', `${APP_ID}@${version}`], ['c', CHANNEL], ...PLATFORMS.map((f) => ['f', f]),
      ['e', assetId, relay], ['a', appAddress(releasePubkey), relay],
      ...(commit ? [['commit', commit]] : []), ['security', security ? 'true' : 'false'], ...(minSafe ? [['min_allowed_version', minSafe]] : []),
    ],
  })
  return { app, asset, release }
}

/** An event as printed: everything but the signature. */
function shown(ev) {
  const { sig: _sig, ...rest } = ev
  return { ...rest, sig: '(made; withheld from the dry run)' }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.version
  if (!parseSemver(version)) fail('--version must be X.Y.Z (each part at most six digits, no leading v)')
  if (args.minSafe !== undefined) {
    if (!parseSemver(args.minSafe)) fail('--min-safe must be X.Y.Z')
    if (compareSemver(parseSemver(args.minSafe), parseSemver(version)) > 0) fail('--min-safe cannot be above --version')
  }
  if (args.note === undefined) fail('--note "<one line>" is required (say what the release fixes; it may be empty only if you pass --note "")')
  if (args.note && noteOf(args.note) !== args.note.trim()) fail('--note must be one plain line of at most 280 characters with no link: copies show nothing else (src/updates.ts noteOf)')

  const sk = readKey(args.key)
  const pubkey = getPublicKey(sk)
  if (pubkey !== RELEASE_PUBKEY) {
    if (args.publish) fail(`the key in ${args.key} is ${nip19.npubEncode(pubkey)}, not the release key ${nip19.npubEncode(RELEASE_PUBKEY)}; every copy would ignore these events`)
    console.error(`publish-update-notice: this key is not the release key; a dry run only (every copy would ignore these events)`)
  }
  // The bundle, by its .sha256 (the file the release workflow wrote and the signer checked).
  if (!args.sha256File) fail('--sha256-file <cyberspace-mcp-X.Y.Z.tar.gz.sha256> is required: a NIP-82 release points at its bundle')
  const m = /^([0-9a-f]{64}) [ *]?(\S+)\n?$/.exec(readFileSync(args.sha256File, 'utf8'))
  if (!m) fail(`${args.sha256File} is not a one-line sha256sum file`)
  const [, sha256, filename] = m
  if (filename !== `cyberspace-mcp-${version}.tar.gz`) fail(`${args.sha256File} names ${filename}, not cyberspace-mcp-${version}.tar.gz`)
  const tarball = join(dirname(resolve(args.sha256File)), filename)
  const size = existsSync(tarball) ? statSync(tarball).size : null

  // The commit: given, or the tag's.
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
  const tagCommit = git('rev-parse', `v${version}^{commit}`)
  let commit = args.commit ?? tagCommit
  if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) fail('--commit must be a full 40-hex commit id')
  if (args.publish) {
    // Publishing cannot be undone (every copy keeps the highest version and minimum it sees): the tag must be here, agree with --commit, and carry this version.
    if (!tagCommit) fail(`there is no tag v${version} in this clone; fetch the tags first (git fetch --tags)`)
    if (commit !== tagCommit) fail(`--commit ${commit} is not the commit of tag v${version} (${tagCommit})`)
    let tagged = null
    try { tagged = JSON.parse(git('show', `v${version}:package.json`) ?? 'null')?.version ?? null } catch { tagged = null }
    if (tagged !== version) fail(`package.json at tag v${version} says ${tagged ?? 'nothing readable'}, not ${version}`)
  }
  if (commit === null) console.error(`publish-update-notice: no tag v${version} here and no --commit: the events carry no commit`)

  const relays = [...new Set([NOTICE_RELAY, ...args.relays])]
  const createdAt = args.createdAt !== undefined ? Number(args.createdAt) : Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) fail('--created-at must be unix seconds')
  const t = templates({ version, sha256, filename, size, note: args.note.trim(), minSafe: args.minSafe ?? null, security: args.security, commit, createdAt, releasePubkey: pubkey, relay: NOTICE_RELAY })
  const app = finalizeEvent(t.app, sk)
  const asset = finalizeEvent(t.asset, sk)
  const release = finalizeEvent(t.release(asset.id), sk)

  // Read back exactly as a running copy reads it, with this key as the trusted one.
  const read = parseNotice(JSON.parse(JSON.stringify(release)), pubkey, Math.floor(Date.now() / 1000) + 60)
  if (!read) fail('the release event just built does not pass the server\'s own parser (dist/updates.js); nothing was sent')
  if (read.version !== version || read.minSafe !== (args.minSafe ?? null) || read.security !== args.security) fail('the release event reads back differently from what was asked; nothing was sent')

  const summary = `cyberspace-mcp ${version}${args.security ? ' (security)' : ''}${args.minSafe ? `, min_allowed_version ${args.minSafe}` : ''}, signed by ${nip19.npubEncode(pubkey)}`
  if (!args.publish) {
    console.log(JSON.stringify({ dryRun: true, summary, relays, events: { app: shown(app), asset: shown(asset), release: shown(release) }, readsAs: read }, null, 2))
    console.error('Dry run: nothing was sent. Add --publish to send these three events.')
    return
  }

  // The last word is the key holder's: the version, typed.
  console.log(JSON.stringify({ summary, relays, readsAs: read }, null, 2))
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const typed = (await rl.question(`Publish ${summary} to ${relays.join(', ')}? Type the version (${version}) to go on: `)).trim()
  rl.close()
  if (typed !== version) fail('not confirmed; nothing was sent')

  let failed = 0
  for (const url of relays) {
    let relay
    try {
      relay = await Relay.connect(url)
      relay.onauth = async (tmpl) => finalizeEvent(tmpl, sk)
      for (const ev of [app, asset, release]) {
        try {
          try {
            await relay.publish(ev)
          } catch (err) {
            // A relay that wants NIP-42 first says auth-required: authenticate as the release key and send it once more.
            if (!/^auth-required/i.test(err instanceof Error ? err.message : String(err))) throw err
            await relay.auth(relay.onauth)
            await relay.publish(ev)
          }
          console.log(`${url}: took kind ${ev.kind} ${ev.id}`)
        } catch (err) {
          failed++
          console.error(`${url}: refused kind ${ev.kind} ${ev.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Read it back as a copy would: the releases of this app by this key, the highest version first.
      const got = []
      await new Promise((done) => {
        const sub = relay.subscribe([noticeFilter(pubkey)], { onevent: (e) => got.push(e), oneose: () => { sub.close(); done() } })
        setTimeout(done, 8000)
      })
      const ours = got.some((e) => e.id === release.id && parseNotice(e, pubkey, Math.floor(Date.now() / 1000) + 60))
      console.log(`${url}: ${ours ? 'serves the release back' : 'does NOT serve the release back yet'}`)
      if (!ours) failed++
    } catch (err) {
      failed++
      console.error(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      try { relay?.close() } catch { /* closed */ }
    }
  }
  console.log(`${summary}: ${failed ? `${failed} problem(s), see above` : 'published'}`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
