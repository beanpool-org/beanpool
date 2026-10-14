/**
 * No socket to anywhere but this machine, for a test process (global-door-web-test-harness.ts installs it before the
 * node loads): `net.Socket.prototype.connect` refuses any host that is not loopback, whatever path reached it.
 *
 * `--self-check` (run by apps/pwa/e2e/global-door-check.mjs before it starts the node): the real connect is replaced by
 * a recorder that never connects, the guard is installed over it, and every way Node opens a socket is aimed at
 * 192.0.2.1 (TEST-NET-1, never routed). Each must be refused by the guard, never reach the recorder; and loopback must
 * still go through. Prints one JSON line and exits non-zero if any got through.
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']);

export function isLoopback(host: string): boolean {
    return LOOPBACK.has(host) || host.startsWith('127.');
}

/**
 * Where a call to Socket.prototype.connect is going: a host, or 'localhost' for a local socket path. net.connect,
 * net.createConnection and http's agent call it with Node's normalized arguments, one array `[options, cb]`
 * (review 4162062977): unwrapped first, so they are read like `socket.connect(options)`.
 */
export function connectTarget(raw: unknown[]): string {
    const args = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw;
    const first = args[0] as { host?: unknown; path?: unknown } | number | string | undefined;
    if (typeof first === 'object' && first !== null) {
        return typeof first.path === 'string' ? 'localhost' : typeof first.host === 'string' ? first.host : 'localhost';
    }
    if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
    return 'localhost'; // a string first argument is a local socket path
}

/** Install the guard over whatever `Socket.prototype.connect` is now. `onBlocked` hears each refusal. */
export function installLoopbackGuard(onBlocked: (host: string) => void = (host) => console.error(`BLOCKED-CONNECT ${host}`)): void {
    const realConnect = net.Socket.prototype.connect as (...a: unknown[]) => net.Socket;
    net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
        const host = connectTarget(args);
        if (!isLoopback(host)) {
            onBlocked(host);
            process.nextTick(() => this.destroy(new Error(`no connections leave this machine (${host})`)));
            return this;
        }
        return realConnect.apply(this, args);
    } as typeof net.Socket.prototype.connect;
}

async function selfCheck(): Promise<void> {
    const TEST_NET = '192.0.2.1';
    const reached: string[] = [];
    // The recorder: what would have connected, and nothing does.
    net.Socket.prototype.connect = function record(this: net.Socket, ...args: unknown[]) {
        reached.push(connectTarget(args));
        return this;
    } as typeof net.Socket.prototype.connect;
    const blocked: string[] = [];
    installLoopbackGuard((host) => blocked.push(host));

    const quiet = (s: { on?: (e: string, f: () => void) => unknown } | undefined) => { s?.on?.('error', () => {}); };
    const paths: Array<[string, () => void]> = [
        ['new Socket().connect({host, port})', () => { const s = new net.Socket(); quiet(s); s.connect({ host: TEST_NET, port: 9 }); }],
        ['net.connect({host, port})', () => quiet(net.connect({ host: TEST_NET, port: 9 }))],
        ['net.createConnection(port, host)', () => quiet(net.createConnection(9, TEST_NET))],
        ['tls.connect({host, port})', () => quiet(tls.connect({ host: TEST_NET, port: 9 }))],
        ['http.get(url)', () => quiet(http.get(`http://${TEST_NET}:9/`))],
    ];
    const results: Record<string, 'blocked' | 'LET THROUGH' | 'not seen'> = {};
    for (const [name, open] of paths) {
        reached.length = 0;
        blocked.length = 0;
        open();
        await new Promise((r) => setTimeout(r, 100));
        results[name] = reached.includes(TEST_NET) ? 'LET THROUGH' : blocked.includes(TEST_NET) ? 'blocked' : 'not seen';
    }
    // Loopback still goes through (to the recorder).
    reached.length = 0;
    quiet(net.connect({ host: '127.0.0.1', port: 9 }));
    await new Promise((r) => setTimeout(r, 50));
    const loopbackOk = reached.includes('127.0.0.1');
    const ok = Object.values(results).every((v) => v === 'blocked') && loopbackOk;
    process.stdout.write(`${JSON.stringify({ ok, results, loopbackOk })}\n`);
    process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--self-check')) {
    void selfCheck();
}
