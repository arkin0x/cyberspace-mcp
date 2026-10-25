// lockOwner.ts: a process that takes a state directory's lock the way serve
// does and then "signs a hop" every 100 ms, each behind the lock's assert,
// printing one line per thing it does (test/lock.test.ts runs it as a real
// second process, and in a pid namespace of its own with unshare). Like
// serve, it exits 1 when it loses its lock. Run with node --import tsx:
//
//   lockOwner.ts <stateDir> <options JSON>
//
// options: heartbeatMs, fenceMs, silenceMs (the lock's); holdMs (release
// and exit 0 after this long); startAt (wait until this wall time, ms, so
// several start together); mode "machine-id" (only resolve the machine id,
// print it, exit).

import { mkdirSync } from 'node:fs'
import { resolveMachineId, takeLock } from '../../src/state/lock.js'

const [stateDir, raw] = process.argv.slice(2)
const o = JSON.parse(raw ?? '{}') as { heartbeatMs?: number; fenceMs?: number; silenceMs?: number; holdMs?: number; startAt?: number; mode?: string }
const env = {} as NodeJS.ProcessEnv
const say = (line: string): void => { process.stdout.write(`${line}\n`) }

mkdirSync(stateDir, { recursive: true, mode: 0o700 })
while (o.startAt && Date.now() < o.startAt) { /* start together */ }

if (o.mode === 'machine-id') {
  try {
    say(`ID ${resolveMachineId(stateDir, { env, create: true }).id}`)
  } catch (err) {
    say(`ERROR ${err instanceof Error ? err.message : String(err)}`)
    process.exit(4)
  }
  process.exit(0)
}

let held
try {
  held = await takeLock(stateDir, { env, heartbeatMs: o.heartbeatMs, fenceMs: o.fenceMs, silenceMs: o.silenceMs, log: (l) => say(`LOG ${l}`) })
} catch (err) {
  say(`HELD ${err instanceof Error ? err.message : String(err)}`)
  process.exit(3)
}
say(`TAKEN ${process.pid}`)
held.onLost((reason) => { say(`LOST ${reason}`); process.exit(1) })
let n = 0
setInterval(() => {
  try {
    held.assert('sign a hop')
    say(`SIGNED ${++n}`)
  } catch (err) {
    say(`REFUSED ${err instanceof Error ? err.message : String(err)}`)
  }
}, 100)
if (o.holdMs) setTimeout(() => { held.release(); say('RELEASED'); process.exit(0) }, o.holdMs)
