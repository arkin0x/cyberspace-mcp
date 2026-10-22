// serve.ts: `cyberspace-mcp serve`, one agent that keeps running (arkinox,
// 2026-10-13). It starts the Agent once (one state directory, its lock),
// serves MCP over HTTP on 127.0.0.1 (http.ts) to any client that connects
// by URL, and runs the waker (waker.ts) in the same process, reading the
// agent's own state, so one command gives the whole XOR experience: the
// background ride, the operator DM poll with its 👀, the watches, and a
// model turn started whenever there is something to answer.

import { Agent, type AgentConfig } from './agent.js'
import { parseArgs, readFileConfig, readWalletFile, settingsFrom } from './config.js'
import { ensureToken, readToken, startHttp, type HttpHandle } from './http.js'
import { createServer } from './server.js'
import { defaultStateDir, serveSettingsFrom, splitServeArgs, type ServeFileConfig, type ServeSettings } from './serveConfig.js'
import { Waker, type WakeData, type WakerDeps } from './waker.js'

export interface ServeDeps {
  log: (line: string) => void
  /** Where the one-time token line goes (stdout for a person). */
  print: (line: string) => void
  /** Tests: the fake network, a calibration, short waits; merged into the agent's config. */
  agent?: Partial<AgentConfig>
  /** Tests: the waker's clock and watchdog pace. */
  waker?: Partial<Pick<WakerDeps, 'now' | 'watchdogMs' | 'killGraceMs'>>
}

export interface Serving {
  agent: Agent
  http: HttpHandle
  waker: Waker | null
  settings: ServeSettings
  stateDir: string
  stop: () => Promise<void>
}

/** Start serve from its argv (without the word serve). Throws a sentence on a bad flag; LockHeldError when the state directory is in use. */
export async function startServe(argv: string[], deps: ServeDeps): Promise<Serving> {
  const { serve, rest } = splitServeArgs(argv)
  const args = parseArgs(rest)
  if (args.help) throw new HelpRequested()
  const stateDir = args.state ?? defaultStateDir()
  args.state = stateDir
  const file = readFileConfig(stateDir)
  const settings = settingsFrom(args, file, readWalletFile(stateDir))
  const serveSettings = serveSettingsFrom(serve, file as ServeFileConfig)
  const { log } = deps

  const agent = await Agent.start({ ...settings, log, ...deps.agent })
  let token: string | null = null
  if (serveSettings.token) {
    const t = ensureToken(stateDir)
    token = t.token
    // Printed this once, when it is made; afterwards it is only in the file (mode 600).
    if (t.created) deps.print(`Bearer token for this server (kept in ${stateDir}/http-token; shown only now): ${t.token}`)
  } else if (readToken(stateDir)) {
    log('a token file exists but serve.token is off: requests are not checked for it')
  }

  let waker: Waker | null = null
  let http: HttpHandle
  try {
    http = await startHttp({
      port: serveSettings.port,
      token,
      log,
      createServer: () => createServer(agent, log, {
        onActivity: () => waker?.noteActivity(),
        ...(waker ? { wakeAgain: () => waker!.requestAgain(), workDone: () => waker!.markDone(), onInbox: (r) => waker!.onInbox(r) } : {}),
      }),
    })
  } catch (err) {
    await agent.stop()
    throw err
  }
  if (serveSettings.wake) {
    waker = new Waker(serveSettings.wake, {
      ordersWaiting: async () => (await agent.ordersWaiting()).data as WakeData,
      stateDir,
      log: (line) => log(line),
      messageOperator: (text) => agent.messageOperator({ text }),
      env: {
        CYBERSPACE_MCP_URL: http.url,
        CYBERSPACE_MCP_STATE: stateDir,
        ...(token ? { CYBERSPACE_MCP_TOKEN: token } : {}),
      },
      ...deps.waker,
    })
  }
  log(`agent ${agent.npub} serving MCP at ${http.url}${token ? ' (bearer token required)' : ''}; state in ${stateDir}`)
  if (waker) waker.start()
  else log('no waker: set wake.command in config.json (or --wake-command) so the agent answers without you; see QUICKSTART.md')

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try { await waker?.stop() } catch { /* already down */ }
      try { await http.close() } catch { /* already closed */ }
      try { await agent.stop() } catch { /* already down */ }
    })()
    return stopping
  }
  return { agent, http, waker, settings: serveSettings, stateDir, stop }
}

/** --help was asked for; bin.ts prints the usage. */
export class HelpRequested extends Error {}
