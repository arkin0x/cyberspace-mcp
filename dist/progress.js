// progress.ts: MCP progress notifications for a tool call that runs long
// (audit B5, 2026-11-08). A hop can compute for a minute, a ride's wait and
// wait_for for longer, and an MCP client gives up on a silent call after its
// request timeout (60 s in the TypeScript SDK, 20 s in OpenClaw's example):
// the client walks away while the server goes on and signs. When the call
// carries a progressToken, the server now says it is alive every few
// seconds, and a tool may say what it is doing (hop: "computing the proof").
// A client that resets its timeout on progress (the SDK's
// resetTimeoutOnProgress) then waits as long as the work goes on.
//
// Nothing here changes what a tool does: a call without a progressToken
// sends nothing, a notification that cannot be sent is dropped, and the
// heartbeat stops when the call ends, however it ends (an answer, a throw),
// or when the client cancels it.
/** How often a long call says it is alive. Under every client timeout we know of. */
export const HEARTBEAT_MS = 5_000;
const idle = { report: async () => { }, stop: () => { } };
/**
 * Progress for one call of `tool`. The progress value is the seconds since
 * the call began, so it always grows (the spec requires it to); there is no
 * total, since no tool knows its end in advance. Returns a no-op when the
 * request carried no progressToken.
 */
export function startProgress(tool, extra, intervalMs = HEARTBEAT_MS, now = () => performance.now()) {
    const token = extra?._meta?.progressToken;
    if (!extra || token === undefined || token === null || extra.signal?.aborted)
        return idle;
    const t0 = now();
    let last = 0;
    let phase = 'working';
    let stopped = false;
    const send = async () => {
        if (stopped)
            return;
        const elapsed = (now() - t0) / 1000;
        const progress = Math.max(Math.round(elapsed * 10) / 10, Math.round((last + 0.1) * 10) / 10);
        last = progress;
        try {
            await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, message: `${tool}: ${phase} (${Math.floor(elapsed)} s)` } });
        }
        catch {
            /* the client went away; the call goes on and its answer says what happened */
        }
    };
    const timer = setInterval(() => { void send(); }, intervalMs);
    timer.unref?.();
    const end = () => {
        stopped = true;
        clearInterval(timer);
        extra.signal?.removeEventListener('abort', end);
    };
    extra.signal?.addEventListener('abort', end, { once: true });
    return {
        report: async (next) => {
            if (stopped)
                return;
            phase = next;
            await send();
            // Let the notification leave before the caller goes on: a proof that
            // follows holds the thread, and nothing is written while it computes.
            await new Promise((resolve) => setImmediate(resolve));
        },
        stop: end,
    };
}
//# sourceMappingURL=progress.js.map