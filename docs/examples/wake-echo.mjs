#!/usr/bin/env node
// wake-echo.mjs: a wake command with no model in it (arkinox, 2026-10-13).
// It shows the whole contract a wake command keeps, and tests the loop
// before you spend a model call:
//
//   cyberspace-mcp serve --wake-command "node /path/to/wake-echo.mjs {prompt}"
//
// The waker runs it once per turn with the prompt as its one argument, never
// through a shell. The environment carries CYBERSPACE_MCP_URL (the server),
// CYBERSPACE_MCP_TOKEN (when serve requires one), CYBERSPACE_MCP_STATE and
// CYBERSPACE_WAKE_REASON. A turn ends when the command exits; one that calls
// no tool and prints nothing for idleKillMinutes is stopped.
//
// This one reads your messages with inbox and answers each with
// message_operator, "received: ...". A real agent puts a model here: give
// the model the prompt, and the MCP URL as a streamable HTTP server.

const url = process.env.CYBERSPACE_MCP_URL ?? 'http://127.0.0.1:7777/mcp'
const prompt = process.argv[2] ?? ''
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
if (process.env.CYBERSPACE_MCP_TOKEN) headers.authorization = `Bearer ${process.env.CYBERSPACE_MCP_TOKEN}`

let id = 0
/** One JSON-RPC request; the server is stateless, so each POST stands alone. */
async function rpc(method, params) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}
const tool = async (name, args = {}) => rpc('tools/call', { name, arguments: args })

console.log(`woken: ${process.env.CYBERSPACE_WAKE_REASON ?? '?'}: ${prompt.slice(0, 120)}`)
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wake-echo', version: '1' } })
const inbox = await tool('inbox')
const messages = inbox.structuredContent?.messages ?? []
for (const m of messages) {
  console.log(`order: ${m.text}`)
  await tool('message_operator', { text: `received: ${m.text.slice(0, 200)}` })
}
console.log(`answered ${messages.length} message(s)`)
