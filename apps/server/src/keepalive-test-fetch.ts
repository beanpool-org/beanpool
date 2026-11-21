/**
 * fetch for a suite whose server runs in the suite's own process (startHttpsServer): the same call, except that a kept
 * socket to that server whose last request went out more than 3 s ago is closed first, so fetch opens a new one.
 *
 * The server closes a connection idle for its keep-alive (5 s, server-limits.ts; Node closes it about a second later),
 * one turn after its timer fires (closeIdleWithoutReset). fetch closes a kept socket itself 3 s after its last answer
 * (the server's 5 s hint less its 2 s margin), but it starts that clock in a turn of its own after the answer: when the
 * suite's next line is a long synchronous stretch (rows written by the thousand, an invite chain built, work solved:
 * several times slower on CI's machine, 8-20x for some), fetch's clock starts only after it, while the server's started
 * before it. After a stretch of more than about 3 s the server closes first. And fetch keeps more than one socket: a
 * second one is opened whenever a call is made while the first is still busy (a POST the server answers before its body
 * is sent, two calls at once, a call made straight after a small answer). That second socket can sit idle across a
 * stretch and several calls on the first, then be picked for the next call. When the server's close falls due during
 * the call before it (its synchronous work holds the loop), the server's close and fetch's own check of the idle socket
 * run in the same turn, the server's first: fetch sees its end still open, writes the request, and the close arrives
 * next turn: `TypeError: fetch failed` (SocketError: other side closed, or read ECONNRESET).
 *
 * CI run 44900976683 (main, d1619835) and PR #3333's run 44871673592: test-dos-hardening line 614, the read straight
 * after section 7's `deep` read, on the socket idle since section 6. Measured with a plain server in one process on
 * Node 22.23 (CI's), two sockets, a 3.8-3.9 s stretch, then four reads with 0.55-0.7 s of work each and the call after
 * them: 14 of 24 reset with the old rule here (a turn when the last call settled more than 4 s ago, blind to the second
 * socket), 0 of 24 with this one. test-keepalive-idle-close row E holds it.
 *
 * Which socket a request went out on, and when its answer came back, are read from fetch's diagnostics channels
 * (undici:client:sendHeaders, undici:request:trailers, undici:request:error), in real time: the time a request went
 * out is never later than the server's last sight of that socket, so a socket this lets fetch keep has been idle under
 * 3 s by the server's clock too, 2 s short of its close. A socket whose request has no answer yet (a call still running,
 * or an upgrade to a WebSocket) is never touched, nor a socket to another server.
 */
import dc from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

/** Under the server's keep-alive (5 s, server-limits.ts DEFAULT_SERVER_LIMITS) by fetch's own 2 s margin. */
const KEEP_FOR_MS = 3_000;

interface Kept { origin: string; sentAt: number; answered: boolean }
const kept = new Map<Socket, Kept>();
const socketOf = new WeakMap<object, Socket>();

dc.subscribe('undici:client:sendHeaders', (message) => {
    const { request, socket } = message as { request: { origin?: unknown }; socket: Socket };
    socketOf.set(request, socket);
    if (!kept.has(socket)) socket.once('close', () => kept.delete(socket));
    kept.set(socket, { origin: String(request.origin), sentAt: performance.now(), answered: false });
});
const answered = (message: unknown) => {
    const socket = socketOf.get((message as { request: object }).request);
    const k = socket && kept.get(socket);
    if (k) k.answered = true;
};
dc.subscribe('undici:request:trailers', answered);
dc.subscribe('undici:request:error', answered);

const originOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : input).origin;

export async function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const origin = originOf(input);
    const now = performance.now();
    const stale = [...kept].filter(([s, k]) => k.origin === origin && k.answered && !s.destroyed && now - k.sentAt > KEEP_FOR_MS).map(([s]) => s);
    // Closed here, and fetch told (its own 'close' listener runs before ours), before it picks a socket for this call.
    await Promise.all(stale.map((s) => new Promise<void>((resolve) => { s.once('close', () => resolve()); s.destroy(); })));
    return fetch(input, init);
}
