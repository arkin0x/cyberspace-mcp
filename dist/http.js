// http.ts: MCP over Streamable HTTP on 127.0.0.1 (arkinox, 2026-10-13), so
// any MCP client connects by URL to one long-lived server, and the agent's
// background ride, DM poll and watches outlive every model session. The
// transport runs stateless: each POST gets its own McpServer and transport
// over the one shared Agent, so there is no session to leak when a
// one-shot client (claude -p, a waker turn) exits without saying goodbye,
// and the agent's state lives where it always did, in the Agent. Answers
// are plain JSON, except a tool call that asks for progress (a
// progressToken, and an Accept that takes text/event-stream): its answer is
// a short event stream that carries the progress notifications and then
// the result, since a JSON answer has nowhere to put them (progress.ts).
//
// Only this machine is served: the socket binds 127.0.0.1, the Host header
// must name it (a DNS rebinding page cannot), a browser's Origin must be
// this same address, and with a token every request must carry it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_PATH } from './serveConfig.js';
/** The file in the state directory that holds the bearer token. */
export const TOKEN_FILE = 'http-token';
/** The bearer token in the state directory, made (mode 600) when there is none. `created` says it was made just now. */
export function ensureToken(stateDir) {
    const path = join(stateDir, TOKEN_FILE);
    if (existsSync(path)) {
        const token = readFileSync(path, 'utf8').trim();
        if (token.length >= 16)
            return { token, created: false };
    }
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, token + '\n', { mode: 0o600 });
    return { token, created: true };
}
/** The token, when the file is there; null when not. Never logged. */
export function readToken(stateDir) {
    try {
        const t = readFileSync(join(stateDir, TOKEN_FILE), 'utf8').trim();
        return t.length >= 16 ? t : null;
    }
    catch {
        return null;
    }
}
function sameSecret(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
function deny(res, status, message, headers = {}, code = -32000) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
/** The most a request body may be, as the SDK's own limit. */
const MAX_BODY = 4 * 1024 * 1024;
/** A JSON body, read here so the answer's form can be chosen from it; null when it is over MAX_BODY. Throws on JSON that does not parse. */
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY)
            return null;
        chunks.push(chunk);
    }
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
/** Whether a POST is a tools/call (alone or in a batch) that asked for progress and can take an event stream. */
export function wantsProgressStream(body, accept) {
    if (!accept?.includes('text/event-stream'))
        return false;
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => {
        if (!m || typeof m !== 'object')
            return false;
        const { method, params } = m;
        const token = params?._meta?.progressToken;
        return method === 'tools/call' && (typeof token === 'string' || typeof token === 'number');
    });
}
/** Listen on 127.0.0.1:port and serve MCP at /mcp. Rejects with a sentence when the port is taken. */
export async function startHttp(opts) {
    let port = opts.port;
    const loopbackHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const loopbackOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
    const handle = async (req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (path !== MCP_PATH)
            return deny(res, 404, `Not found: the MCP endpoint is ${MCP_PATH}`);
        const host = (req.headers.host ?? '').toLowerCase();
        if (!loopbackHosts().has(host))
            return deny(res, 403, 'Forbidden: this server answers only to 127.0.0.1');
        const origin = req.headers.origin;
        if (origin !== undefined && !loopbackOrigins().has(origin.toLowerCase()))
            return deny(res, 403, 'Forbidden: requests from web pages are refused');
        if (opts.token) {
            const auth = req.headers.authorization ?? '';
            const m = /^Bearer\s+(.+)$/i.exec(auth);
            if (!m || !sameSecret(m[1].trim(), opts.token))
                return deny(res, 401, 'Unauthorized: send Authorization: Bearer <the token in the state directory file http-token>', { 'www-authenticate': 'Bearer' });
        }
        if (req.method !== 'POST')
            return deny(res, 405, 'Method not allowed: this server is stateless; send each request as a POST', { allow: 'POST' });
        // A JSON body is read here to choose the answer's form; anything else goes to the transport as it came, which refuses it.
        let parsed;
        if (/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
            let read;
            try {
                read = await readJson(req);
            }
            catch {
                return deny(res, 400, 'Parse error: Invalid JSON', {}, -32700);
            }
            if (!read)
                return deny(res, 413, `Payload too large: the most a request may be is ${MAX_BODY} bytes`);
            parsed = read;
        }
        const stream = parsed !== undefined && wantsProgressStream(parsed.body, req.headers.accept);
        const server = opts.createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !stream });
        res.on('close', () => {
            void transport.close().catch(() => { });
            void server.close().catch(() => { });
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed?.body);
    };
    const http = createHttpServer((req, res) => {
        handle(req, res).catch((err) => {
            opts.log(`http: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            if (!res.headersSent)
                deny(res, 500, 'Internal error');
            else
                res.end();
        });
    });
    // A hop or a ride's wait may hold a request for minutes, within the caps; the caps bound it, not the socket.
    http.requestTimeout = 0;
    await new Promise((resolve, reject) => {
        const onError = (err) => {
            reject(err.code === 'EADDRINUSE'
                ? new Error(`Port ${opts.port} on 127.0.0.1 is in use: is another cyberspace-mcp serve running? Stop it, or start this one with --port <n>.`)
                : err);
        };
        http.once('error', onError);
        http.listen(opts.port, '127.0.0.1', () => {
            http.off('error', onError);
            resolve();
        });
    });
    port = http.address().port;
    return {
        port,
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        close: () => new Promise((resolve) => {
            http.close(() => resolve());
            http.closeAllConnections?.();
        }),
    };
}
//# sourceMappingURL=http.js.map