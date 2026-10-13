// fakeAgent.mjs: a stand-in for a model CLI, for the waker tests (arkinox,
// 2026-10-13). The waker runs it as `node fakeAgent.mjs <mode> <log> <prompt>`.
// Every mode first appends one JSON line to <log>: the arguments it got
// (the prompt must arrive as exactly one), the wake reason, and the MCP URL
// from the environment. Then:
//   log     exits at once
//   silent  says nothing and never exits (the watchdog must stop it)
//   chatty  writes a line every 100 ms for 1.5 s, then exits
//   inbox   calls the inbox tool on the server it was given, over HTTP, as
//           a model would, records what came back, and exits
import { appendFileSync } from 'node:fs'

const [mode, log, ...rest] = process.argv.slice(2)
appendFileSync(log, JSON.stringify({ mode, args: rest, reason: process.env.CYBERSPACE_WAKE_REASON, url: process.env.CYBERSPACE_MCP_URL ?? null }) + '\n')

if (mode === 'silent') {
  setInterval(() => {}, 1 << 30)
} else if (mode === 'chatty') {
  const t = setInterval(() => process.stdout.write('thinking\n'), 100)
  setTimeout(() => { clearInterval(t); process.exit(0) }, 1500)
} else if (mode === 'inbox') {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (process.env.CYBERSPACE_MCP_TOKEN) headers.authorization = `Bearer ${process.env.CYBERSPACE_MCP_TOKEN}`
  const post = async (body) => (await fetch(process.env.CYBERSPACE_MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })).json()
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0' } } })
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inbox', arguments: {} } })
  appendFileSync(log, JSON.stringify({ mode, inbox: r.result?.structuredContent ?? r.error ?? null }) + '\n')
  process.exit(0)
} else {
  process.exit(0)
}
