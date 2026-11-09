// websocket.ts: the WebSocket the relay client uses in Node, with one guard.
//
// nostr-tools' AbstractRelay answers a connection failure by rejecting its
// connect promise and then calling ws.close() before it detaches its
// handlers. Node's native WebSocket (undici) fails a connection that is
// still being opened by dispatching the error event again, synchronously,
// so the two recurse until the stack overflows: onerror, close, onerror,
// close. Browsers do not re-dispatch there, which is why ONOSENDAI never
// meets this. A close that is a no-op the second time breaks the loop; the
// relay then detaches its handlers and reports the failure once.
export class GuardedWebSocket extends WebSocket {
    closing = false;
    close(code, reason) {
        if (this.closing)
            return;
        this.closing = true;
        try {
            super.close(code, reason);
        }
        catch {
            /* the connection had already failed */
        }
    }
}
//# sourceMappingURL=websocket.js.map