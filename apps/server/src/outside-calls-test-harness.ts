/**
 * Our domains unresolvable, for a test process (not a suite itself; DESIGN-global-mothership-fable.md §2.4, slice A4):
 * nothing in the process reaches past this machine, and every try is counted, so a suite can say which hosts a node asked
 * for, in which step, from which line of ours. test-no-mothership.ts installs it in each node it boots, before the node's
 * modules load, and in its own process for the phones.
 *
 * Three ways out are stopped, each answered as a name that does not resolve answers, so the code behind the call meets
 * the failure it would meet when our domains are down, never a different one:
 *   - the resolver: dns.lookup, dns.resolve*, dns.reverse and their promise and Resolver forms. A loopback name resolves to
 *     this machine; every other name fails ENOTFOUND. IP literals go to the real lookup, which never asks a server for one.
 *   - fetch: a request to a host that is not loopback fails as undici fails when the name does not resolve
 *     (TypeError "fetch failed", its cause ENOTFOUND), and the request is never made.
 *   - a socket: Socket.prototype.connect (http, https, tls, net, a libp2p dial) to a host that is not loopback is destroyed
 *     with ENOTFOUND for a name, ENETUNREACH for an address (loopback-guard-test-harness.ts reads where a connect goes).
 * Not stopped: UDP. The one sender in the server is the DNS shim (dns-shim.ts), forwarding a LAN client's query, and no
 * suite sends it one.
 *
 * Each try is one JSON line in `file` (appended synchronously, so a node that exits a moment later, as a restore or a
 * take-over does, still leaves it), with the host, the watched domain it falls under, and the first line of our code on
 * the stack. readOutsideCalls reads a file back; checkOutsideCalls sorts the calls against a suite's allowed list.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { connectTarget, isLoopback } from './loopback-guard-test-harness.js';

/**
 * The domains §2.4 counts: ours, and the services a node of ours is known to touch (the design's §2.2). exp.host is Expo's
 * push service (state-engine.ts), which the design's list names as expo.dev.
 */
export const WATCHED_DOMAINS = ['beanpool.org', 'supabase.co', 'github.com', 'ghcr.io', 'expo.dev', 'exp.host', 'apple.com'] as const;
/** Ours: the registrar, the switchboard, global.beanpool.org, the site. A local community asks none of them. */
export const OUR_DOMAINS = ['beanpool.org'] as const;

export interface OutsideCall {
    /** ms since the epoch. */
    at: number;
    pid: number;
    via: 'lookup' | 'fetch' | 'connect';
    host: string;
    /** The watched domain the host is or falls under, else null. */
    domain: string | null;
    /** The URL, for a fetch. */
    url?: string;
    /** The first line of our own code on the stack when the call was made, if any. */
    from: string | null;
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const bare = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
export function watchedDomainOf(host: string): string | null {
    const h = bare(host);
    return WATCHED_DOMAINS.find((d) => under(h, d)) ?? null;
}
export function isOurDomain(host: string): boolean {
    const h = bare(host);
    return OUR_DOMAINS.some((d) => under(h, d));
}
const loopbackName = (host: string) => {
    const h = bare(host);
    return h === 'localhost' || h.endsWith('.localhost') || isLoopback(h);
};

/** The first frame of this repository's code below the trap: the line that asked. */
function caller(): string | null {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    for (const f of frames) {
        if (f.includes('outside-calls-test-harness') || f.includes('node_modules') || f.includes('node:')) continue;
        const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/.exec(f.trim());
        if (!m) continue;
        const file = m[1].replace(/^file:\/\//, '');
        const at = file.search(/\/(apps|packages)\//);
        return `${at === -1 ? file : file.slice(at + 1)}:${m[2]}`;
    }
    return null;
}

function notFound(host: string, syscall = 'getaddrinfo'): NodeJS.ErrnoException {
    return Object.assign(new Error(`${syscall} ENOTFOUND ${host}`), { code: 'ENOTFOUND', errno: -3008, syscall, hostname: host });
}

export interface OutsideCallTrap {
    /** Every call this process tried since the trap went in. */
    calls: () => OutsideCall[];
}

let installed: OutsideCallTrap | null = null;

/**
 * Stop and count every way out of this process. Install before anything that may make a call is imported. `file`: each
 * call is also appended there as a JSON line (for a node process, which the suite reads from outside).
 */
export function installOutsideCallTrap(opts: { file?: string } = {}): OutsideCallTrap {
    if (installed) return installed;
    const seen: OutsideCall[] = [];
    const record = (via: OutsideCall['via'], host: string, url?: string) => {
        const call: OutsideCall = { at: Date.now(), pid: process.pid, via, host: bare(host), domain: watchedDomainOf(host), ...(url ? { url } : {}), from: caller() };
        seen.push(call);
        if (opts.file) {
            try { fs.appendFileSync(opts.file, `${JSON.stringify(call)}\n`); } catch { /* the folder is gone: the suite is over */ }
        }
    };

    // ── The resolver ──
    const realLookup = dns.lookup;
    const answerLoopback = (options: any) => {
        const family = typeof options === 'number' ? options : options?.family;
        const address = family === 6 ? '::1' : '127.0.0.1';
        return { address, family: family === 6 ? 6 : 4 };
    };
    (dns as any).lookup = function lookup(hostname: string, options: any, callback?: any) {
        const cb = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'function' ? {} : options;
        if (net.isIP(String(hostname))) return (realLookup as any).call(dns, hostname, options, callback);
        if (loopbackName(String(hostname))) {
            const a = answerLoopback(opts);
            process.nextTick(() => (opts?.all ? cb(null, [a]) : cb(null, a.address, a.family)));
            return {};
        }
        record('lookup', String(hostname));
        process.nextTick(() => cb(notFound(String(hostname))));
        return {};
    };
    const realPromiseLookup = dns.promises.lookup;
    (dns.promises as any).lookup = async function lookup(hostname: string, options?: any) {
        if (net.isIP(String(hostname))) return (realPromiseLookup as any).call(dns.promises, hostname, options);
        if (loopbackName(String(hostname))) {
            const a = answerLoopback(options);
            return options?.all ? [a] : a;
        }
        record('lookup', String(hostname));
        throw notFound(String(hostname));
    };
    const RESOLVE = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr',
        'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
    const failCallback = (name: string) => function refused(this: unknown, hostname: string, ...rest: any[]) {
        const cb = rest.find((r) => typeof r === 'function');
        record('lookup', String(hostname));
        process.nextTick(() => cb?.(notFound(String(hostname), name === 'reverse' ? 'getHostByAddr' : `query${name.slice(7)}`)));
        return {};
    };
    const failPromise = (name: string) => async function refused(hostname: string) {
        record('lookup', String(hostname));
        throw notFound(String(hostname), name === 'reverse' ? 'getHostByAddr' : `query${name.slice(7)}`);
    };
    for (const name of RESOLVE) {
        if (typeof (dns as any)[name] === 'function') (dns as any)[name] = failCallback(name);
        if (typeof (dns.Resolver.prototype as any)[name] === 'function') (dns.Resolver.prototype as any)[name] = failCallback(name);
        if (typeof (dns.promises as any)[name] === 'function') (dns.promises as any)[name] = failPromise(name);
        if (typeof (dns.promises.Resolver.prototype as any)[name] === 'function') (dns.promises.Resolver.prototype as any)[name] = failPromise(name);
    }
    // `import { lookup } from 'node:dns'` in a module loaded after this sees the stub too.
    syncBuiltinESMExports();

    // ── fetch ──
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        let url: URL | null = null;
        try { url = new URL(href); } catch { /* fetch itself refuses it */ }
        if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !loopbackName(url.hostname)) {
            record('fetch', url.hostname, `${url.origin}${url.pathname}`);
            throw new TypeError('fetch failed', { cause: notFound(bare(url.hostname)) });
        }
        return realFetch(input as any, init);
    }) as typeof fetch;

    // ── Sockets ──
    const realConnect = net.Socket.prototype.connect as (...a: unknown[]) => net.Socket;
    net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
        const host = connectTarget(args);
        if (loopbackName(host)) return realConnect.apply(this, args);
        record('connect', host);
        const err = net.isIP(bare(host))
            ? Object.assign(new Error(`connect ENETUNREACH ${host}`), { code: 'ENETUNREACH', syscall: 'connect', address: host })
            : notFound(host);
        process.nextTick(() => this.destroy(err));
        return this;
    } as typeof net.Socket.prototype.connect;

    installed = { calls: () => [...seen] };
    return installed;
}

/** The calls a process left in its file (none when it made none). */
export function readOutsideCalls(file: string): OutsideCall[] {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as OutsideCall]; } catch { return []; } });
}

/** A host a suite lets its nodes ask for, and why. `host` is the name or a domain it falls under. */
export interface AllowedHost { host: string; why: string }

/**
 * The calls sorted against `allowed`: `ours` (to one of our domains, with no entry for it), `unexpected` (to any other host
 * with no entry), and the allowed ones, by entry. A suite whose nodes may ask the registrar (PUBLIC_ADDRESS_* set) says so
 * with an entry for its host.
 */
export function checkOutsideCalls(calls: OutsideCall[], allowed: AllowedHost[]) {
    const ours: OutsideCall[] = [];
    const unexpected: OutsideCall[] = [];
    const byEntry = new Map<AllowedHost, OutsideCall[]>();
    for (const c of calls) {
        const entry = allowed.find((a) => under(c.host, bare(a.host)));
        if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), c]);
        else if (isOurDomain(c.host)) ours.push(c);
        else unexpected.push(c);
    }
    return { ours, unexpected, allowed: byEntry };
}

/** One line per host: how many tries, by which way, from which lines. */
export function describeOutsideCalls(calls: OutsideCall[]): string[] {
    const byHost = new Map<string, OutsideCall[]>();
    for (const c of calls) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c]);
    return [...byHost.entries()].map(([host, cs]) => {
        const vias = [...new Set(cs.map((c) => c.via))].join('/');
        const froms = [...new Set(cs.map((c) => c.from ?? 'no line of ours on the stack'))].slice(0, 4).join(', ');
        return `${host} ×${cs.length} (${vias}) from ${froms}`;
    });
}
