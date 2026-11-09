#!/usr/bin/env node
// release-bundle.mjs: builds the self-contained release bundle (D1b).
//
//   node scripts/release-bundle.mjs [--tag vX.Y.Z] [--out release]
//
// Writes <out>/cyberspace-mcp-<version>.tar.gz and <out>/cyberspace-mcp-<version>.tar.gz.sha256.
// The tarball holds one folder, cyberspace-mcp-<version>/, with dist/ built
// fresh from src/, the files package.json ships (`files`), package.json, the
// lockfile, and the production node_modules installed from that lockfile with
// no lifecycle scripts. Every production dependency is plain JavaScript (the
// native modules in the lockfile are devDependencies), so one bundle serves
// every platform: unpack it and run `node cyberspace-mcp-<version>/dist/bin.js`
// with Node 22 or newer. No git, no npm, no network, no build.
//
// The tarball is reproducible: entries sorted by name, mtimes set to the
// commit's time (SOURCE_DATE_EPOCH, else HEAD's commit time), owner 0:0,
// normalized modes, gzip without a name or timestamp. Building the same commit
// twice gives the same sha256. It needs GNU tar (the release workflow runs on
// ubuntu-latest); run `npm ci` in the repository first, for tsc.
//
// It never overwrites: it stops if either output file exists already.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`)
  return v
}

function fail(msg) {
  console.error(`release-bundle: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`package.json version ${JSON.stringify(version)} is not semver`)

const tag = arg('--tag')
if (tag !== undefined && tag !== `v${version}`) {
  fail(`tag ${tag} does not match package.json version ${version} (expected v${version}); bump the version first`)
}

const out = resolve(arg('--out') ?? join(root, 'release'))
const name = `cyberspace-mcp-${version}`
const tarball = join(out, `${name}.tar.gz`)
const shaFile = `${tarball}.sha256`
for (const f of [tarball, shaFile]) if (existsSync(f)) fail(`${f} exists already; move it away first`)
mkdirSync(out, { recursive: true })

const tsc = join(root, 'node_modules', '.bin', 'tsc')
if (!existsSync(tsc)) fail('node_modules/.bin/tsc is missing: run npm ci first')

const epoch = process.env.SOURCE_DATE_EPOCH
  ?? execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()
if (!/^\d+$/.test(epoch)) fail(`bad SOURCE_DATE_EPOCH ${JSON.stringify(epoch)}`)

// A fresh staging directory: nothing in it is ever removed by this script.
const stageRoot = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-bundle-'))
const stage = join(stageRoot, name)
mkdirSync(stage)

console.error(`release-bundle: building ${name} in ${stage}`)

// 1. dist/, fresh from src/ (never the working tree's dist/, whatever state it is in).
run(tsc, ['-p', join(root, 'tsconfig.build.json'), '--outDir', join(stage, 'dist')], { cwd: root })

// 2. What the package ships, plus the manifest and the lockfile npm ci installs from.
const shipped = new Set(['package.json', 'package-lock.json', ...(pkg.files ?? []).filter((f) => f !== 'dist')])
for (const f of shipped) {
  const from = join(root, f)
  if (!existsSync(from)) fail(`${f} (listed in package.json files) does not exist`)
  cpSync(from, join(stage, f), { recursive: true })
}

chmodSync(join(stage, 'dist', 'bin.js'), 0o755)

// 3. Production dependencies only, exactly as locked, with no install scripts run.
// `--omit=optional` drops typescript, which the lockfile marks devOptional (a
// devDependency here and an optional peer of nostr-tools), so `--omit=dev`
// alone would ship the compiler. It would also drop a genuine optional
// production dependency, so refuse if the lockfile ever has one.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const prodOptional = Object.entries(lock.packages ?? {}).filter(([k, v]) => k && v.optional && !v.dev).map(([k]) => k)
if (prodOptional.length) fail(`optional production dependencies would be left out: ${prodOptional.join(', ')}; revisit --omit=optional`)
run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage })

// 4. A reproducible tarball.
run('tar', [
  '--sort=name',
  `--mtime=@${epoch}`,
  '--owner=0', '--group=0', '--numeric-owner',
  '--mode=u+rwX,go+rX,go-w',
  '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
  '--format=pax',
  '-C', stageRoot,
  '-cf', join(stageRoot, `${name}.tar`),
  name,
])
const gz = execFileSync('gzip', ['-n', '-9', '-c', join(stageRoot, `${name}.tar`)], { maxBuffer: 1 << 30 })
writeFileSync(tarball, gz, { flag: 'wx' })

const hex = createHash('sha256').update(gz).digest('hex')
writeFileSync(shaFile, `${hex}  ${basename(tarball)}\n`, { flag: 'wx' })

console.error(`release-bundle: ${tarball} (${(gz.length / 1048576).toFixed(1)} MB)`)
console.error(`release-bundle: sha256 ${hex}`)
console.error(`release-bundle: staging left at ${stageRoot} (temporary directory)`)
