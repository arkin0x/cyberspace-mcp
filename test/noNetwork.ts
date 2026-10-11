// noNetwork.ts: a vitest setup file. Tests never touch the network, and this
// makes it so for fetch: a test that forgets to inject one (a station quote
// with no fake HOSAKA, for instance) gets a failed request instead of
// reaching a real server such as the production HOSAKA.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  throw new TypeError(`tests never touch the network (fetch ${url} was not injected)`)
}
