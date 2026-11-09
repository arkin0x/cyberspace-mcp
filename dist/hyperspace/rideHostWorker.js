// rideHostWorker.ts: the worker_threads entry that runs a whole ride off the
// server's main thread (arkinox, 2026-10-11: "agents being responsive is top
// priority or else the feature feels broken").
//
// The leaves and the price attempts already ran on rideWorker.ts threads,
// but the runner itself did its bookkeeping on the thread that answers tool
// calls, and at the scale of a real ride that bookkeeping is long: for
// 661,038 leaves, reading the cache back took about 3.5 s, decoding it 2.6 s
// and building the Merkle tree 5.5 s on this machine, and the Level 1
// self-verification recomputes 32 sampled leaves, each up to 2^22 pairings.
// Every tool call (inbox, orders_waiting, message_operator) would wait behind
// those. So the runner runs here, on a thread of its own, and starts its leaf
// threads from here; the main thread only hears progress.
//
// One run per thread: the thread starts with its job in workerData, posts
// progress as the runner reports it, then posts the result (or the error)
// and ends. A stop flag in shared memory asks for a cut (the session cap, or
// a pause), which the runner honors as a spent budget: everything computed
// is on disk. An 'abort' message ends the run at once (cancel, shutdown);
// finished leaves are flushed to disk on that path too.
import { parentPort, workerData } from 'node:worker_threads';
import { bytesToHex } from 'cyberspace-core';
import { RideRunner } from './rideRunner.js';
import { checkLease } from '../state/lock.js';
function serve(port, data) {
    const stop = new Int32Array(data.stop);
    const controller = new AbortController();
    port.on('message', (msg) => {
        if (msg?.type === 'abort')
            controller.abort();
    });
    const lo = Math.min(data.fromHeight, data.toHeight);
    const hi = Math.max(data.fromHeight, data.toHeight);
    const blockHashFor = (height) => {
        if (height <= lo || height > hi)
            throw new Error(`block ${height} is not on this ride`);
        const at = (height - lo - 1) * 32;
        return bytesToHex(data.hashes.subarray(at, at + 32));
    };
    const lease = data.lease;
    const runner = RideRunner.open(data.cachePath, { threads: data.threads, chunkSize: data.chunkSize, grindChunk: data.grindChunk, ...(lease ? { guard: (what) => checkLease(lease, what) } : {}) });
    runner.run({ previousEventIdHex: data.previousEventIdHex, fromHeight: data.fromHeight, toHeight: data.toHeight, blockHashFor }, {
        budgetSeconds: data.budgetSeconds,
        signal: controller.signal,
        stop: () => Atomics.load(stop, 0) !== 0,
        onProgress: (progress) => port.postMessage({ type: 'progress', progress }),
    }).then((result) => port.postMessage({ type: 'result', result }), (err) => port.postMessage({
        type: 'error', message: err instanceof Error ? err.message : String(err), aborted: err instanceof Error && err.name === 'AbortError',
    })).finally(() => port.close());
}
const data = workerData;
if (parentPort && data?.rideHost === true)
    serve(parentPort, data);
//# sourceMappingURL=rideHostWorker.js.map