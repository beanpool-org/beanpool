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
 *
 * THE GLOBAL NODE (scratch/global-node/DESIGN-global-two-doors-fable.md §6.4). Those numbers suit a community on a
 * 1 GB server. The lobby on the same server meets a viral day behind carrier NATs, so its profile has its own:
 *   - 5,000 sockets on the node: about 50 MB at 10 KB each. 1,500 of them strangers' (members first: a refused visitor
 *     reads over HTTP).
 *   - 1,000 from one address: a hall, a campus or a carrier's shared address, and still not the node.
 *   - 4 for one member: a phone, the web app, a tablet and one still closing. An account costs nothing at the open door,
 *     so each holds fewer.
 *   - 8 strangers' from one address, as everywhere: the guest pass that would let a visitor's key hold its own is not
 *     built yet.
 *   - `noRoomClose`: a socket over a cap is let in and closed at once with the "no room" close and a wait (@beanpool/core
 *     WS_NO_ROOM_CLOSE_CODE, 5 minutes), which the apps can read, instead of a refusal they can't; such a refusal is not
 *     charged to the address's requests (gateway-rate-limit.ts gatewayNoRoomUpgrade). A refused app retried within 30 s,
 *     so on a full node the retries alone spent every address's request budget.
 * A local community keeps every number above. An operator scales a cap with the server in the node's .env (WS_LIMIT_ENV:
 * WS_MAX_SOCKETS=20000 on a 4 GB server, say), on either profile; anything but a whole number above 0 is ignored, and
 * said once in the log. When WS_MAX_STRANGER_SOCKETS is not set, the strangers' cap scales with WS_MAX_SOCKETS by the profile's ratio (half local, 30% global). Strangers never get more places than the node has, nor more from one address than it may hold.
 * The listeners' connection cap follows (server-limits.ts).
 */
import { getNodeProfile, type NodeProfile } from './config/node-profile.js';

export interface WsLimits {
    maxPayloadBytes: number;
    maxSockets: number;
    maxStrangerSockets: number;
    maxStrangerSocketsPerAddress: number;
    maxSocketsPerAddress: number;
    maxSocketsPerMember: number;
    maxLogSockets: number;
    framesPerMinute: number;
    /** A socket over a cap is let in and closed with the "no room" close (above), rather than refused before the upgrade. */
    noRoomClose: boolean;
}

/** A local community's: every node's before the global profile. */
export const DEFAULT_WS_LIMITS: Readonly<WsLimits> = Object.freeze({
    maxPayloadBytes: 4 * 1024,
    maxSockets: 2000,
    maxStrangerSockets: 1000,
    maxStrangerSocketsPerAddress: 8,
    maxSocketsPerAddress: 64,
    maxSocketsPerMember: 8,
    maxLogSockets: 16,
    framesPerMinute: 60,
    noRoomClose: false,
});

/** The global node's, on the 1 GB server (above). */
export const GLOBAL_WS_LIMITS: Readonly<WsLimits> = Object.freeze({
    ...DEFAULT_WS_LIMITS,
    maxSockets: 5000,
    maxStrangerSockets: 1500,
    maxSocketsPerAddress: 1000,
    maxSocketsPerMember: 4,
    noRoomClose: true,
});

const BY_PROFILE: Readonly<Record<NodeProfile, Readonly<WsLimits>>> = { local: DEFAULT_WS_LIMITS, global: GLOBAL_WS_LIMITS };

/** The .env lines that set a cap, on any profile: a whole number above 0, or empty for the profile's own. */
export const WS_LIMIT_ENV = {
    WS_MAX_SOCKETS: 'maxSockets',
    WS_MAX_STRANGER_SOCKETS: 'maxStrangerSockets',
    WS_MAX_SOCKETS_PER_ADDRESS: 'maxSocketsPerAddress',
    WS_MAX_STRANGER_SOCKETS_PER_ADDRESS: 'maxStrangerSocketsPerAddress',
    WS_MAX_SOCKETS_PER_MEMBER: 'maxSocketsPerMember',
} as const satisfies Record<string, keyof WsLimits>;
const ENV_NAMES = Object.keys(WS_LIMIT_ENV) as (keyof typeof WS_LIMIT_ENV)[];

let testOverrides: Partial<WsLimits> = {};
// Read on every upgrade and every inbound frame, so worked out once for each profile and .env and kept.
let resolved: { key: string; limits: Readonly<WsLimits> } | null = null;
const warned = new Set<string>();

/** The caps this node runs with now: its profile's, the .env's on top. NODE_PROFILE is read every time, as everywhere. */
export function wsLimits(): Readonly<WsLimits> {
    const profile = getNodeProfile();
    const raw = ENV_NAMES.map((name) => process.env[name] ?? '');
    const key = `${profile}|${raw.join('|')}`;
    if (resolved?.key === key) return resolved.limits;
    const l: WsLimits = { ...BY_PROFILE[profile] };
    let strangersSet = false;
    ENV_NAMES.forEach((name, i) => {
        const value = raw[i].trim();
        if (value === '') return;
        const n = /^\d{1,9}$/.test(value) ? Number(value) : 0;
        if (n > 0) { l[WS_LIMIT_ENV[name]] = n; if (name === 'WS_MAX_STRANGER_SOCKETS') strangersSet = true; return; }
        const message = `⚠️  ${name}=${JSON.stringify(raw[i])} is not a whole number above 0, so this node keeps its ${profile} profile's ${BY_PROFILE[profile][WS_LIMIT_ENV[name]]}.`;
        if (!warned.has(message)) { warned.add(message); console.warn(message); }
    });
    // Lowering the node's cap alone must not hand strangers every place: unless the operator set the strangers' cap,
    // it scales with the node by the profile's ratio (half on local, 30% on global).
    if (!strangersSet && 'maxStrangerSockets' in testOverrides === false) {
        const base = BY_PROFILE[profile];
        l.maxStrangerSockets = Math.max(1, Math.floor(l.maxSockets * base.maxStrangerSockets / base.maxSockets));
    }
    Object.assign(l, testOverrides);
    l.maxStrangerSockets = Math.min(l.maxStrangerSockets, l.maxSockets);
    l.maxStrangerSocketsPerAddress = Math.min(l.maxStrangerSocketsPerAddress, l.maxSocketsPerAddress);
    if (strangersSet && l.maxStrangerSockets >= l.maxSockets) {
        const message = `⚠️  WS_MAX_STRANGER_SOCKETS=${l.maxStrangerSockets} is not below this node's ${l.maxSockets} sockets, so strangers can hold every place and members can be shut out of live updates.`;
        if (!warned.has(message)) { warned.add(message); console.warn(message); }
    }
    resolved = { key, limits: Object.freeze(l) };
    return resolved.limits;
}

/** Tests only: smaller caps, so a suite can fill them, over the profile's. `undefined` puts the profile's back. The frame
 *  cap is read when a server starts (its WebSocketServers take it then). */
export function setWsLimitsForTests(overrides: Partial<WsLimits> | undefined): void {
    testOverrides = { ...(overrides ?? {}) };
    resolved = null;
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
    return total < wsLimits().maxSockets;
}

/**
 * Take a /ws place for a socket from `address` (limiterKeyForIp) held by `holder`, or say which cap it is over. The
 * place is held until `release` (idempotent), which the caller ties to the raw socket's close.
 */
export function admitWsSocket(address: string, holder: SocketHolder): SocketAdmission {
    const at = byAddress.get(address) ?? { all: 0, strangers: 0 };
    const limits = wsLimits();
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
    if (logs >= wsLimits().maxLogSockets) return null;
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
    return socket._frameCount <= wsLimits().framesPerMinute;
}
