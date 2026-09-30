/**
 * What the WebSocket servers (https-server.ts, /ws and /ws/logs) hold at once, and take from one socket (DoS review F1).
 *
 * Before this, both WebSocketServers took ws's default frame of 100 MiB, nothing counted sockets per address or in all,
 * the default auth mode ('members') gives an unsigned socket the public doorbells, and every inbound frame was turned
 * into a string. One anonymous client could open thousands of sockets, or send 100 MiB frames, at a node on a 1 GB VPS.
 *
 * FRAMES. The apps send one frame and nothing else: the heartbeat `{"type":"ping","wantPong":true}` (31 bytes, every
 * 30 s while the app is in front: native services/ws-client.ts PING_INTERVAL_MS, the PWA lib/sync.ts
 * HEARTBEAT_INTERVAL_MS; an app before the opt-in sends `{"type":"ping"}`). The Settings page's /ws/logs socket sends
 * nothing (static/settings.js), and the manager opens no socket. So a frame is capped at 4 KiB, over a hundred times the
 * largest real one; ws refuses a bigger one itself, closing the socket with 1009 before buffering past the cap. A socket
 * may send `framesPerMinute` frames a minute (60: thirty times the heartbeat); past that it is closed with 1008.
 *
 * SOCKETS. Measured on a plain (tunnel-origin) socket: about 10 KB of server memory an idle socket, both ends of 2,000
 * sockets together 37 MB RSS (scratch bench-ws-mem, 2026-10-01); TLS adds its buffers in direct mode. So:
 *   - `maxSockets` in all on /ws, 2,000: tens of MB, a small share of a 1 GB VPS. Checked before any work is done.
 *   - A socket with no member behind it (unsigned, or signed by a key that is not a member here, which gets only the
 *     public doorbells, as before) is a stranger's: at most `maxStrangerSockets` of them in all (half), so strangers can
 *     never fill the node and shut its members out, and `maxStrangerSocketsPerAddress` from one address (8; an IPv6
 *     client by its /64, as the gateway keys it: client-ip.ts limiterKeyForIp).
 *   - A member's (or a visitor's row's) socket: at most `maxSocketsPerMember` for one key (a phone, the web app and a
 *     tablet, with room for a socket still closing), and `maxSocketsPerAddress` from one address, strangers' included
 *     (64: a hall's wifi, or a carrier NAT, puts many members behind one address).
 *   - /ws/logs, the admin's live log: `maxLogSockets` at once, after its ticket or password.
 * A socket over a cap is refused with 429 (its address's or key's) or 503 (the node's) before the upgrade, and the apps
 * retry with their backoff (@beanpool/core reconnectDelayMs); a refused app still reads everything over HTTP.
 *
 * Each upgrade is also charged to the gateway limiter (gateway-rate-limit.ts gatewayAdmitUpgrade), as an HTTP request.
 */

export interface WsLimits {
    maxPayloadBytes: number;
    maxSockets: number;
    maxStrangerSockets: number;
    maxStrangerSocketsPerAddress: number;
    maxSocketsPerAddress: number;
    maxSocketsPerMember: number;
    maxLogSockets: number;
    framesPerMinute: number;
}

export const DEFAULT_WS_LIMITS: Readonly<WsLimits> = Object.freeze({
    maxPayloadBytes: 4 * 1024,
    maxSockets: 2000,
    maxStrangerSockets: 1000,
    maxStrangerSocketsPerAddress: 8,
    maxSocketsPerAddress: 64,
    maxSocketsPerMember: 8,
    maxLogSockets: 16,
    framesPerMinute: 60,
});

let limits: WsLimits = { ...DEFAULT_WS_LIMITS };

export function wsLimits(): Readonly<WsLimits> {
    return limits;
}

/** Tests only: smaller caps, so a suite can fill them. `undefined` puts the defaults back. The frame cap is read when a
 *  server starts (its WebSocketServers take it then). */
export function setWsLimitsForTests(overrides: Partial<WsLimits> | undefined): void {
    limits = { ...DEFAULT_WS_LIMITS, ...(overrides ?? {}) };
}

const FRAME_WINDOW_MS = 60_000;

/** Who a /ws socket is for the caps: a key that acts here (a member's, or a visitor's row), or a stranger. */
export type SocketHolder = { kind: 'keyed'; key: string } | { kind: 'stranger' };

export type SocketAdmission = { ok: true; release: () => void } | { ok: false; status: 429 | 503; reason: string };

let total = 0;
let strangers = 0;
let logs = 0;
const byAddress = new Map<string, { all: number; strangers: number }>();
const byKey = new Map<string, number>();

/** Whether /ws has room for any socket at all: the first check, before a token is verified or anything charged. */
export function wsHasRoom(): boolean {
    return total < limits.maxSockets;
}

/**
 * Take a /ws place for a socket from `address` (limiterKeyForIp) held by `holder`, or say which cap it is over. The
 * place is held until `release` (idempotent), which the caller ties to the raw socket's close.
 */
export function admitWsSocket(address: string, holder: SocketHolder): SocketAdmission {
    const at = byAddress.get(address) ?? { all: 0, strangers: 0 };
    if (total >= limits.maxSockets) return { ok: false, status: 503, reason: 'This community has as many live connections as it can hold. Try again shortly.' };
    if (at.all >= limits.maxSocketsPerAddress) return { ok: false, status: 429, reason: 'Too many live connections from your network.' };
    if (holder.kind === 'stranger') {
        if (strangers >= limits.maxStrangerSockets) return { ok: false, status: 503, reason: 'This community has as many visitors connected as it can hold. Try again shortly.' };
        if (at.strangers >= limits.maxStrangerSocketsPerAddress) return { ok: false, status: 429, reason: 'Too many live connections from your network.' };
    } else if ((byKey.get(holder.key) ?? 0) >= limits.maxSocketsPerMember) {
        return { ok: false, status: 429, reason: 'Too many live connections for this account.' };
    }
    total++;
    at.all++;
    if (holder.kind === 'stranger') { strangers++; at.strangers++; }
    else byKey.set(holder.key, (byKey.get(holder.key) ?? 0) + 1);
    byAddress.set(address, at);
    let released = false;
    return {
        ok: true,
        release: () => {
            if (released) return;
            released = true;
            total--;
            const now = byAddress.get(address);
            if (now) {
                now.all--;
                if (holder.kind === 'stranger') now.strangers--;
                if (now.all <= 0) byAddress.delete(address);
            }
            if (holder.kind === 'stranger') strangers--;
            else {
                const n = (byKey.get(holder.key) ?? 1) - 1;
                if (n <= 0) byKey.delete(holder.key); else byKey.set(holder.key, n);
            }
        },
    };
}

/** Take a /ws/logs place (an admin's live log), or null when they are all taken. */
export function admitLogSocket(): (() => void) | null {
    if (logs >= limits.maxLogSockets) return null;
    logs++;
    let released = false;
    return () => { if (!released) { released = true; logs--; } };
}

/** What /ws holds now (tests and diagnostics). */
export function wsSocketCounts(): { total: number; strangers: number; logs: number; addresses: number; keys: number } {
    return { total, strangers, logs, addresses: byAddress.size, keys: byKey.size };
}

/**
 * Count one inbound frame on `socket`: false once it has sent more than `framesPerMinute` in the current minute, and
 * the caller closes it. The count lives on the socket object, so it goes with it.
 */
export function frameAllowed(socket: { _frameWindowAt?: number; _frameCount?: number }, now = Date.now()): boolean {
    if (!socket._frameWindowAt || now - socket._frameWindowAt >= FRAME_WINDOW_MS) {
        socket._frameWindowAt = now;
        socket._frameCount = 0;
    }
    socket._frameCount = (socket._frameCount ?? 0) + 1;
    return socket._frameCount <= limits.framesPerMinute;
}
