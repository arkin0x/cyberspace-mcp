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
//   tools:a,b  calls the tools a, then b, the same way, records each answer's
//           text and structured content, and exits
//   tools-fail:a,b  the same, then exits with code 3
//   fail    exits at once with code 3
//   slow    exits after 400 ms
//   touch   says nothing, but appends to <log>.activity every 100 ms for
//           1.5 s, as Hermes writes its state.db, then exits
//   toucher the same, forever
//   stubborn  ignores SIGTERM, and on it touches wake.again in
//           $CYBERSPACE_MCP_STATE, as a dying turn that asks for more would;
//           only SIGKILL ends it
import { appendFileSync } from 'node:fs'

const [mode, log, ...rest] = process.argv.slice(2)
appendFileSync(log, JSON.stringify({ mode, args: rest, reason: process.env.CYBERSPACE_WAKE_REASON, url: process.env.CYBERSPACE_MCP_URL ?? null }) + '\n')

const touch = () => appendFileSync(`${log}.activity`, 'x')

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
} else if (mode.startsWith('tools:') || mode.startsWith('tools-fail:')) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (process.env.CYBERSPACE_MCP_TOKEN) headers.authorization = `Bearer ${process.env.CYBERSPACE_MCP_TOKEN}`
  let id = 0
  const post = async (body) => (await fetch(process.env.CYBERSPACE_MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, ...body }) })).json()
  await post({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0' } } })
  for (const name of mode.slice(mode.indexOf(':') + 1).split(',')) {
    const r = await post({ method: 'tools/call', params: { name, arguments: {} } })
    appendFileSync(log, JSON.stringify({ mode, tool: name, text: r.result?.content?.[0]?.text ?? null, data: r.result?.structuredContent ?? r.error ?? null }) + '\n')
  }
  process.exit(mode.startsWith('tools-fail:') ? 3 : 0)
} else if (mode === 'fail') {
  process.exit(3)
} else if (mode === 'slow') {
  setTimeout(() => process.exit(0), 400)
} else if (mode === 'touch') {
  const t = setInterval(touch, 100)
  setTimeout(() => { clearInterval(t); process.exit(0) }, 1500)
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => {
    appendFileSync(`${process.env.CYBERSPACE_MCP_STATE}/wake.again`, '')
    appendFileSync(log, JSON.stringify({ mode, sigterm: true }) + '\n')
  })
  setInterval(() => {}, 1 << 30)
} else if (mode === 'toucher') {
  setInterval(touch, 100)
} else {
  process.exit(0)
}
