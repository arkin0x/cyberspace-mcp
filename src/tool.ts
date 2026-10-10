// tool.ts: what every tool method returns, and how one refuses. Both were
// born in agent.ts and still come from there for the server and the tests;
// they live here so that a module the agent owns (transit.ts) can throw a
// Refusal without importing the agent that imports it.

/** A tool refusing, with the sentence that says why. */
export class Refusal extends Error {}

export interface ToolResult {
  text: string
  data: Record<string, unknown>
}
