/**
 * What one connection may hold on the node's two listeners (https-server.ts, and the plain HTTP one the Cloudflare
 * tunnel reaches, http-server.ts), for a small VPS (DoS review F3). Before this none was set, so Node 22's defaults held:
 * 60 s to send the headers, 300 s for the whole request, and no cap on connections.
 *
 *   - headersTimeout, 20 s: a request's headers (a signed one's are about 1 KB) arrive in well under a second even on a
 *     slow phone link; a client that dribbles them out holds its connection a third as long as before.
 *   - requestTimeout, 300 s: Node's default, kept on purpose. It bounds a whole request, body included, and the admin
 *     restore streams up to 500 MB in one request (routes/backup.ts); lower, a restore over a slower link would be cut
 *     off, and a phone on a poor link posting a listing with five photos (about 1 MB of JSON) needs minutes too. A JSON
 *     body is capped at 2 MB (MAX_JSON_BODY_BYTES), and a request claiming a signature is charged before its body is read
 *     (gateway-rate-limit.ts `claim:`), so what a slow sender can hold is bounded by those and the cap below.
 *   - keepAliveTimeout, 5 s: Node's default, explicit. The close it makes never resets a request that has already
 *     arrived on the connection (closeIdleWithoutReset, below).
 *   - maxConnections, 4,096 a listener: every live socket the WebSocket caps allow (2,000 on /ws and 16 on /ws/logs:
 *     ws-limits.ts), and as many again for HTTP beside them. Past it Node closes a new connection at once. It follows
 *     the socket caps: on the global node's 5,000 it is 10,032, and an operator's WS_MAX_SOCKETS moves it too
 *     (connectionCapForSockets). Each connection is a file descriptor; Node raises its soft limit to the hard one at
 *     start, and a container's hard limit is far above these.
 *   - connectionsCheckingInterval, 5 s: how often Node looks for a connection past either timeout (its default, 30 s,
 *     would let a 20 s header timeout run to 50).
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { wsLimits, type WsLimits } from './ws-limits.js';

export interface ServerLimits {
    headersTimeoutMs: number;
    requestTimeoutMs: number;
    keepAliveTimeoutMs: number;
    maxConnections: number;
    connectionsCheckingIntervalMs: number;
}

export const DEFAULT_SERVER_LIMITS: Readonly<ServerLimits> = Object.freeze({
    headersTimeoutMs: 20_000,
    requestTimeoutMs: 300_000,
    keepAliveTimeoutMs: 5_000,
    maxConnections: 4096,
    connectionsCheckingIntervalMs: 5_000,
});

/** A listener's connection cap for the socket caps `l`: every place on /ws and /ws/logs and as many again, at least 4,096. */
export function connectionCapForSockets(l: Readonly<WsLimits> = wsLimits()): number {
    return Math.max(DEFAULT_SERVER_LIMITS.maxConnections, 2 * (l.maxSockets + l.maxLogSockets));
}

let testOverrides: Partial<ServerLimits> = {};

/** What a server started now takes: the defaults, with the connection cap the socket caps need. */
export function serverLimits(): Readonly<ServerLimits> {
    return { ...DEFAULT_SERVER_LIMITS, maxConnections: connectionCapForSockets(), ...testOverrides };
}

/** Tests only: other limits for the next server started. `undefined` puts the defaults back. */
export function setServerLimitsForTests(overrides: Partial<ServerLimits> | undefined): void {
    testOverrides = { ...(overrides ?? {}) };
}

/** The options http.createServer and https.createServer take at construction (the checking interval is read only then). */
export function serverTimeoutOptions(): { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; connectionsCheckingInterval: number } {
    const limits = serverLimits();
    return {
        headersTimeout: limits.headersTimeoutMs,
        requestTimeout: limits.requestTimeoutMs,
        keepAliveTimeout: limits.keepAliveTimeoutMs,
        connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    };
}

/** Set the limits a server takes after construction (the connection cap), and the timeouts again, to be sure. */
export function applyServerLimits(server: HttpServer): void {
    const limits = serverLimits();
    server.headersTimeout = limits.headersTimeoutMs;
    server.requestTimeout = limits.requestTimeoutMs;
    server.keepAliveTimeout = limits.keepAliveTimeoutMs;
    server.maxConnections = limits.maxConnections;
    closeIdleWithoutReset(server);
}

/** Requests (and upgrades) each socket has carried, so an idle close can tell whether one came in after its timer fired. */
const requestsOn = new WeakMap<object, number>();
const countRequest = (req: IncomingMessage) => { requestsOn.set(req.socket, (requestsOn.get(req.socket) ?? 0) + 1); };

/**
 * An idle connection the server closes never resets a request that has already reached it.
 *
 * Node closes a kept-alive connection from a timer, keepAliveTimeout and about a second more (6.0 s measured, Node 22 and
 * 26) after its last answer, and the event loop runs its timers BEFORE it reads the sockets. When the loop was held across that moment (a node
 * busy with another request's synchronous work, or a server suite's own synchronous stretch, where client and server share
 * one process), a request that arrived on the connection meanwhile is still unread when the timer fires: Node destroys the
 * socket, the kernel answers the unread bytes with a reset, and the client gets ECONNRESET ("TypeError: fetch failed") for a
 * request the server never looked at. Measured on Node 22.23 (CI's and the node image's): a fetch whose loop was held past
 * the close was reset 6 times in 6, and a separate client process, keeping its socket as a phone, a browser or cloudflared
 * does, whose request reached a server busy 3 s across the close, 5 in 5 (on Node 26 too). test-keepalive-idle-close.ts
 * holds both.
 *
 * With a 'timeout' listener on the server, Node leaves the close to it ("timeouts must be handled explicitly", Node's
 * http docs). This closes one turn later, after the loop has read what was waiting, and only when no request came in on
 * the socket meanwhile: an idle connection closes as before, one turn later, and a request that arrived is answered. The
 * listeners keep server.timeout at 0, so a socket's timer runs only between requests (Node clears it when one starts) and
 * this sees only idle connections.
 */
function closeIdleWithoutReset(server: HttpServer): void {
    server.on('request', countRequest);
    // An upgrade (a live-updates socket) is counted too, but only on a server that takes upgrades: a listener here would
    // make Node treat every Upgrade request as one even where nothing answers it. Both listeners add theirs after this.
    let countingUpgrades = false;
    const countUpgrades = () => {
        if (countingUpgrades) return;
        countingUpgrades = true;
        server.prependListener('upgrade', countRequest);
    };
    if (server.listenerCount('upgrade') > 0) countUpgrades();
    server.on('newListener', (event) => { if (event === 'upgrade') countUpgrades(); });
    server.on('timeout', (socket: Socket) => {
        const seen = requestsOn.get(socket) ?? 0;
        setImmediate(() => {
            if (!socket.destroyed && (requestsOn.get(socket) ?? 0) === seen) socket.destroy();
        });
    });
}
