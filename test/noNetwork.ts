// noNetwork.ts: a vitest setup file. Tests never touch the network, and this
// makes it so for fetch: a test that forgets to inject one (a station quote
// with no fake HOSAKA, for instance) gets a failed request instead of
// reaching a real server such as the production HOSAKA. The one exception
// is this machine's loopback, http://127.0.0.1, where the serve tests run
// their own server and connect a real MCP client to it (arkinox,
// 2026-10-13); that never leaves the machine.
const loopbackFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return loopbackFetch(input, init)
  throw new TypeError(`tests never touch the network (fetch ${url} was not injected)`)
}

// Every agent a test starts takes its state directory's lock, and the lock's
// machine id would otherwise be a file beside each temporary state directory
// (<dir>.machine-id, lock.ts) left behind in the temporary directory. One id
// for the whole run instead; test/lock.test.ts passes its own environment to
// test the file, and removes the files it makes.
process.env.CYBERSPACE_MCP_MACHINE_ID = 'cyberspace-mcp-tests'
