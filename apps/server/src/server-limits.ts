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
 *   - keepAliveTimeout, 5 s: Node's default, explicit.
 *   - maxConnections, 4,096 a listener: every live socket the WebSocket caps allow (2,000 on /ws and 16 on /ws/logs:
 *     ws-limits.ts), and as many again for HTTP beside them. Past it Node closes a new connection at once.
 *   - connectionsCheckingInterval, 5 s: how often Node looks for a connection past either timeout (its default, 30 s,
 *     would let a 20 s header timeout run to 50).
 */
import type { Server as HttpServer } from 'node:http';

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

let limits: ServerLimits = { ...DEFAULT_SERVER_LIMITS };

export function serverLimits(): Readonly<ServerLimits> {
    return limits;
}

/** Tests only: other limits for the next server started. `undefined` puts the defaults back. */
export function setServerLimitsForTests(overrides: Partial<ServerLimits> | undefined): void {
    limits = { ...DEFAULT_SERVER_LIMITS, ...(overrides ?? {}) };
}

/** The options http.createServer and https.createServer take at construction (the checking interval is read only then). */
export function serverTimeoutOptions(): { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; connectionsCheckingInterval: number } {
    return {
        headersTimeout: limits.headersTimeoutMs,
        requestTimeout: limits.requestTimeoutMs,
        keepAliveTimeout: limits.keepAliveTimeoutMs,
        connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    };
}

/** Set the limits a server takes after construction (the connection cap), and the timeouts again, to be sure. */
export function applyServerLimits(server: HttpServer): void {
    server.headersTimeout = limits.headersTimeoutMs;
    server.requestTimeout = limits.requestTimeoutMs;
    server.keepAliveTimeout = limits.keepAliveTimeoutMs;
    server.maxConnections = limits.maxConnections;
}
