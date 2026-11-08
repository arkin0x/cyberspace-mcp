// nodeVersion.ts: the oldest Node this server runs on, and the one line it
// prints on anything older. Node 22 is the first with a global WebSocket,
// which the relay client needs; on Node 20 the first import that touches it
// dies with "ReferenceError: WebSocket is not defined". npm only warns about
// `engines`, so an install on Node 20 succeeds and the first launch would
// crash. bin.ts asks here before it loads anything else. This file imports
// nothing, so it loads on any Node that runs ES modules.

export const MIN_NODE_MAJOR = 22

/** The refusal for a Node older than MIN_NODE_MAJOR, or null when this one will do. */
export function nodeTooOld(version: string): string | null {
  const major = Number(version.replace(/^v/, '').split('.')[0])
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null
  return `cyberspace-mcp needs Node ${MIN_NODE_MAJOR} or newer (it uses the global WebSocket); this is Node v${version.replace(/^v/, '')}. Install Node ${MIN_NODE_MAJOR}+ and run it again.`
}
