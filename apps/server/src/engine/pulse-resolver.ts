// Pulse resolver and cache engine — The Pulse (Phase 2).
//
// Conforms strictly to Contract A and Contract B in docs/pulse/CONTRACTS.md.
//
// Core responsibilities:
// 1. SSRF-hardened HTTP fetching (DNS rebinding / TOCTOU defense, comprehensive IPv4/IPv6 private
//    and reserved CIDR block enforcement, hop-by-hop redirect verification, stream size caps, hard timeouts).
// 2. Multi-format feed parsing (RSS 2.0 and Atom 1.0) with zero heavy external dependencies.
// 3. Instagram og:description post-count probe for un-autolisted channels.
// 4. Staggered background fetch scheduler with backoff and error tracking on creator_channels.
// 5. 30-day pruner and single scrubPulseItems helper for tombstone replication.
// 6. Contract B feed query (cursor pagination, category filtering, strict visibility gating) and
//    owner-scoped item muting.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net from 'node:net';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { ChannelCategory, ChannelPlatform } from './creator-channels.js';

// ============================================================================
// 1. Errors & Types
// ============================================================================

export class PulseError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'PulseError';
    }
}

export class SsrfSecurityError extends Error {
    constructor(message: string) {
        super(`SSRF_BLOCKED: ${message}`);
        this.name = 'SsrfSecurityError';
    }
}

export class PayloadTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PayloadTooLargeError';
    }
}

export interface PulseFeedItemRow {
    id: string;
    channel_id: string;
    owner_pubkey: string;
    platform: string;
    external_id: string | null;
    url: string | null;
    title: string | null;
    thumbnail_url: string | null;
    published_at: string | null;
    category: string;
    source: string;
    muted: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}

export interface PulseFeedCard {
    id: string;
    ownerPubkey: string;
    callsign: string;
    avatarUrl: string | null;
    platform: string;
    category: string;
    url: string | null;
    title: string | null;
    thumbnailUrl: string | null;
    publishedAt: string | null;
    source: string;
    isVerified: boolean;
}

export interface ParsedPulseItem {
    externalId: string | null;
    url: string | null;
    title: string;
    thumbnailUrl: string | null;
    publishedAt: string;
    summary?: string | null;
    author?: string | null;
}

export interface ParsedPulseFeed {
    title: string;
    link: string | null;
    description: string | null;
    items: ParsedPulseItem[];
}

export interface SsrfSafeFetchOptions {
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    allowedContentTypes?: string[];
    signal?: AbortSignal;
}

export interface SsrfSafeResponse {
    status: number;
    statusText: string;
    headers: http.IncomingHttpHeaders;
    url: string;
    buffer: () => Promise<Buffer>;
    text: () => Promise<string>;
    json: <T = any>() => Promise<T>;
}

// ============================================================================
// 2. SSRF Hardened Fetcher & Networking
// ============================================================================

interface Ipv4Cidr {
    name: string;
    subnet: number;
    mask: number;
}

function parseIpv4ToUint32(ip: string): number | null {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!match) return null;
    const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    for (const octet of octets) {
        if (octet < 0 || octet > 255) return null;
    }
    return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function makeIpv4Cidr(name: string, cidr: string): Ipv4Cidr {
    const [ipStr, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const ip = parseIpv4ToUint32(ipStr)!;
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return { name, subnet: (ip & mask) >>> 0, mask };
}

const BLOCKED_IPV4_CIDRS: Ipv4Cidr[] = [
    makeIpv4Cidr('Current Network (0.0.0.0/8)', '0.0.0.0/8'),
    makeIpv4Cidr('Private-Use RFC 1918 (10.0.0.0/8)', '10.0.0.0/8'),
    makeIpv4Cidr('Carrier-Grade NAT / Alibaba Metadata RFC 6598 (100.64.0.0/10)', '100.64.0.0/10'),
    makeIpv4Cidr('Loopback RFC 1122 (127.0.0.0/8)', '127.0.0.0/8'),
    makeIpv4Cidr('Link-Local / Cloud Metadata RFC 3927 (169.254.0.0/16)', '169.254.0.0/16'),
    makeIpv4Cidr('Private-Use RFC 1918 (172.16.0.0/12)', '172.16.0.0/12'),
    makeIpv4Cidr('IETF Protocol Assignments RFC 6890 (192.0.0.0/24)', '192.0.0.0/24'),
    makeIpv4Cidr('TEST-NET-1 RFC 5737 (192.0.2.0/24)', '192.0.2.0/24'),
    makeIpv4Cidr('6to4 Relay Anycast RFC 7526 (192.88.99.0/24)', '192.88.99.0/24'),
    makeIpv4Cidr('Private-Use RFC 1918 (192.168.0.0/16)', '192.168.0.0/16'),
    makeIpv4Cidr('Benchmarking RFC 2544 (198.18.0.0/15)', '198.18.0.0/15'),
    makeIpv4Cidr('TEST-NET-2 RFC 5737 (198.51.100.0/24)', '198.51.100.0/24'),
    makeIpv4Cidr('TEST-NET-3 RFC 5737 (203.0.113.0/24)', '203.0.113.0/24'),
    makeIpv4Cidr('Multicast RFC 5771 (224.0.0.0/4)', '224.0.0.0/4'),
    makeIpv4Cidr('Reserved / Future / Broadcast RFC 1112 (240.0.0.0/4)', '240.0.0.0/4'),
];

function checkIpv4Uint32(ipNum: number): { blocked: boolean; reason?: string } {
    for (const block of BLOCKED_IPV4_CIDRS) {
        if (((ipNum & block.mask) >>> 0) === block.subnet) {
            return { blocked: true, reason: block.name };
        }
    }
    return { blocked: false };
}

interface Ipv6Cidr {
    name: string;
    prefix: bigint;
    prefixLen: number;
}

function parseIpv6ToBigInt(ipStr: string): bigint | null {
    let cleaned = ipStr.trim();
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.slice(1, -1);
    }
    const zoneIdx = cleaned.indexOf('%');
    if (zoneIdx !== -1) {
        cleaned = cleaned.slice(0, zoneIdx);
    }

    const lastColon = cleaned.lastIndexOf(':');
    if (lastColon !== -1) {
        const potentialIpv4 = cleaned.slice(lastColon + 1);
        if (potentialIpv4.includes('.')) {
            const v4Num = parseIpv4ToUint32(potentialIpv4);
            if (v4Num === null) return null;
            const high16 = (v4Num >>> 16) & 0xffff;
            const low16 = v4Num & 0xffff;
            cleaned = cleaned.slice(0, lastColon) + ':' + high16.toString(16) + ':' + low16.toString(16);
        }
    }

    const doubleColonCount = (cleaned.match(/::/g) || []).length;
    if (doubleColonCount > 1) return null;

    let parts: string[];
    if (doubleColonCount === 1) {
        const [left, right] = cleaned.split('::');
        const leftParts = left ? left.split(':') : [];
        const rightParts = right ? right.split(':') : [];
        const missingCount = 8 - (leftParts.length + rightParts.length);
        if (missingCount < 1) return null;
        parts = [...leftParts, ...Array(missingCount).fill('0'), ...rightParts];
    } else {
        parts = cleaned.split(':');
        if (parts.length !== 8) return null;
    }

    if (parts.length !== 8) return null;

    let result = 0n;
    for (const part of parts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        const val = BigInt(parseInt(part, 16));
        result = (result << 16n) | val;
    }
    return result;
}

function parseIpv6Cidr(name: string, cidr: string): Ipv6Cidr {
    const [ipStr, bitsStr] = cidr.split('/');
    const prefixLen = Number(bitsStr);
    const ip = parseIpv6ToBigInt(ipStr)!;
    const shift = BigInt(128 - prefixLen);
    const prefix = prefixLen === 0 ? 0n : (ip >> shift) << shift;
    return { name, prefix, prefixLen };
}

const BLOCKED_IPV6_CIDRS: Ipv6Cidr[] = [
    parseIpv6Cidr('Unspecified (::/128)', '::/128'),
    parseIpv6Cidr('Loopback (::1/128)', '::1/128'),
    parseIpv6Cidr('Discard-Only RFC 6666 (100::/64)', '100::/64'),
    parseIpv6Cidr('Documentation RFC 3849 (2001:db8::/32)', '2001:db8::/32'),
    parseIpv6Cidr('ORCHIDv2 RFC 7343 (2001:10::/28)', '2001:10::/28'),
    parseIpv6Cidr('Benchmarking RFC 5180 (2001:2::/48)', '2001:2::/48'),
    parseIpv6Cidr('Unique Local Address ULA RFC 4193 (fc00::/7)', 'fc00::/7'),
    parseIpv6Cidr('Link-Local Unicast RFC 4291 (fe80::/10)', 'fe80::/10'),
    parseIpv6Cidr('Multicast RFC 4291 (ff00::/8)', 'ff00::/8'),
];

function checkIpv6BigInt(ipBig: bigint): { blocked: boolean; reason?: string } {
    for (const block of BLOCKED_IPV6_CIDRS) {
        const shift = BigInt(128 - block.prefixLen);
        if ((ipBig >> shift) === (block.prefix >> shift)) {
            return { blocked: true, reason: block.name };
        }
    }

    // IPv4-Mapped IPv6 (::ffff:0:0/96)
    if ((ipBig >> 32n) === 0xffffn) {
        const embeddedV4 = Number(ipBig & 0xffffffffn);
        const v4Check = checkIpv4Uint32(embeddedV4);
        if (v4Check.blocked) {
            return { blocked: true, reason: `IPv4-Mapped IPv6 -> ${v4Check.reason}` };
        }
    }

    // IPv4-Translated IPv6 (::ffff:0:0:0/96 / RFC 2765)
    if ((ipBig >> 32n) === (0xffffn << 32n)) {
        const embeddedV4 = Number(ipBig & 0xffffffffn);
        const v4Check = checkIpv4Uint32(embeddedV4);
        if (v4Check.blocked) {
            return { blocked: true, reason: `IPv4-Translated IPv6 -> ${v4Check.reason}` };
        }
    }

    // NAT64 Well-Known Prefix (64:ff9b::/96)
    const nat64Prefix = (0x0064n << 112n) | (0xff9bn << 96n);
    if ((ipBig >> 32n) === (nat64Prefix >> 32n)) {
        const embeddedV4 = Number(ipBig & 0xffffffffn);
        const v4Check = checkIpv4Uint32(embeddedV4);
        if (v4Check.blocked) {
            return { blocked: true, reason: `NAT64 Well-Known Prefix -> ${v4Check.reason}` };
        }
    }

    // 6to4 Prefix (2002::/16) -> bits 16..47 contain IPv4
    if ((ipBig >> 112n) === 0x2002n) {
        const embeddedV4 = Number((ipBig >> 80n) & 0xffffffffn);
        const v4Check = checkIpv4Uint32(embeddedV4);
        if (v4Check.blocked) {
            return { blocked: true, reason: `6to4 Encapsulation -> ${v4Check.reason}` };
        }
    }

    // TEREDO (2001::/32) -> bits 96..127 contain XOR-inverted IPv4
    if ((ipBig >> 96n) === 0x20010000n) {
        const embeddedV4 = Number((ipBig & 0xffffffffn) ^ 0xffffffffn);
        const v4Check = checkIpv4Uint32(embeddedV4);
        if (v4Check.blocked) {
            return { blocked: true, reason: `TEREDO Encapsulation -> ${v4Check.reason}` };
        }
    }

    return { blocked: false };
}

export function isIpPrivateOrReserved(ipStr: string): boolean {
    let cleaned = ipStr.trim();
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.slice(1, -1);
    }
    if (net.isIPv4(cleaned)) {
        const num = parseIpv4ToUint32(cleaned);
        if (num === null) return true;
        return checkIpv4Uint32(num).blocked;
    }
    if (net.isIPv6(cleaned)) {
        const big = parseIpv6ToBigInt(cleaned);
        if (big === null) return true;
        return checkIpv6BigInt(big).blocked;
    }
    return true;
}

export function validateIpString(ip: string): void {
    let cleaned = ip.trim();
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        cleaned = cleaned.slice(1, -1);
    }
    if (net.isIPv4(cleaned)) {
        const num = parseIpv4ToUint32(cleaned);
        if (num === null) {
            throw new SsrfSecurityError(`Invalid IPv4 address format: ${ip}`);
        }
        const check = checkIpv4Uint32(num);
        if (check.blocked) {
            throw new SsrfSecurityError(`Resolved IP ${ip} is blocked (${check.reason})`);
        }
        return;
    }

    if (net.isIPv6(cleaned)) {
        const big = parseIpv6ToBigInt(cleaned);
        if (big === null) {
            throw new SsrfSecurityError(`Invalid IPv6 address format: ${ip}`);
        }
        const check = checkIpv6BigInt(big);
        if (check.blocked) {
            throw new SsrfSecurityError(`Resolved IPv6 ${ip} is blocked (${check.reason})`);
        }
        return;
    }

    throw new SsrfSecurityError(`Unrecognized IP address structure: ${ip}`);
}

const BANNED_HOSTNAME_EXACT = new Set<string>([
    'localhost',
    'metadata.google.internal',
    'metadata',
    'instance-data',
]);

const BANNED_HOSTNAME_SUFFIXES = [
    '.localhost',
    '.local',
    '.internal',
    '.lan',
    '.home.arpa',
    '.corp',
    '.home',
    '.intranet',
];

export function validateHostnameSyntax(hostname: string): void {
    const norm = hostname.replace(/\.+$/, '').toLowerCase();
    if (!norm) {
        throw new SsrfSecurityError('Host cannot be empty');
    }

    if (BANNED_HOSTNAME_EXACT.has(norm)) {
        throw new SsrfSecurityError(`Blocked special/metadata hostname: ${norm}`);
    }

    for (const suffix of BANNED_HOSTNAME_SUFFIXES) {
        if (norm.endsWith(suffix)) {
            throw new SsrfSecurityError(`Blocked private/internal domain suffix: ${norm}`);
        }
    }

    if (!net.isIP(norm) && !norm.includes('.')) {
        throw new SsrfSecurityError(`Single-label internal hostnames are prohibited: ${norm}`);
    }
}

interface PinnedResolution {
    pinnedIp: string;
    family: number;
}

async function resolveAndPinHost(hostname: string): Promise<PinnedResolution> {
    let normHost = hostname.replace(/\.+$/, '').toLowerCase();
    if (normHost.startsWith('[') && normHost.endsWith(']')) {
        normHost = normHost.slice(1, -1);
    }

    if (net.isIP(normHost)) {
        validateIpString(normHost);
        return { pinnedIp: normHost, family: net.isIPv4(normHost) ? 4 : 6 };
    }

    validateHostnameSyntax(normHost);

    let addresses: LookupAddress[];
    try {
        addresses = await dns.lookup(normHost, { all: true, verbatim: true });
    } catch (err: any) {
        throw new SsrfSecurityError(`DNS resolution failed for ${normHost}: ${err.message}`);
    }

    if (!addresses || addresses.length === 0) {
        throw new SsrfSecurityError(`DNS resolution returned no A or AAAA records for ${normHost}`);
    }

    for (const addr of addresses) {
        validateIpString(addr.address);
    }

    const selected = addresses[0];
    return { pinnedIp: selected.address, family: selected.family };
}

/**
 * Create a DNS lookup function pinned to an already-validated IP address and family.
 *
 * Node 22 defaults net.connect to autoSelectFamily: true, which passes { all: true }
 * and expects cb(null, [{ address, family }]). When all is falsy or omitted, the legacy
 * cb(null, address, family) form is expected.
 */
export function createCustomLookup(pinnedIp: string, family: number) {
    return (_host: string, lookupOpts: any, callback?: any) => {
        const cb = typeof lookupOpts === 'function' ? lookupOpts : callback;
        if (typeof cb !== 'function') return;

        const isAll = typeof lookupOpts === 'object' && lookupOpts !== null && Boolean(lookupOpts.all);
        if (isAll) {
            cb(null, [{ address: pinnedIp, family }]);
        } else {
            cb(null, pinnedIp, family);
        }
    };
}

function createByteLimitTransform(maxBytes: number, onLimitExceeded: () => void): Transform {
    let bytesRead = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytesRead += chunk.length;
            if (bytesRead > maxBytes) {
                onLimitExceeded();
                callback(new PayloadTooLargeError(`Response exceeded maximum size limit of ${maxBytes} bytes`));
                return;
            }
            callback(null, chunk);
        },
    });
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_REDIRECTS = 5;

const DEFAULT_ALLOWED_CONTENT_TYPES = [
    'application/rss+xml',
    'application/atom+xml',
    'application/xml',
    'text/xml',
    'application/json',
    'text/plain',
    'text/html',
    'application/xhtml+xml',
];

export async function ssrfSafeFetch(
    rawUrl: string,
    options: SsrfSafeFetchOptions = {}
): Promise<SsrfSafeResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const method = options.method ?? 'GET';
    const allowedTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;

    let currentUrl = rawUrl;
    let redirectsRemaining = maxRedirects;
    const requestHeaders: Record<string, string> = {
        'User-Agent': 'BeanPool-Pulse/1.0 (+https://beanpool.org)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(options.headers || {}),
    };

    while (true) {
        let parsed: URL;
        try {
            parsed = new URL(currentUrl);
        } catch {
            throw new SsrfSecurityError(`Invalid URL string: ${currentUrl}`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new SsrfSecurityError(`Prohibited URL scheme: ${parsed.protocol} (only http: and https: allowed)`);
        }

        if (parsed.username || parsed.password) {
            throw new SsrfSecurityError('Embedded credentials (user:password@) in URL are prohibited');
        }

        const isHttps = parsed.protocol === 'https:';
        const hostname = parsed.hostname;
        const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);

        const { pinnedIp, family } = await resolveAndPinHost(hostname);

        const customLookup = createCustomLookup(pinnedIp, family);

        const agentOptions = {
            lookup: customLookup,
            keepAlive: false,
        };

        const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);

        const response = await new Promise<{
            incoming: http.IncomingMessage;
            statusCode: number;
            statusText: string;
            headers: http.IncomingHttpHeaders;
            cleanup: () => void;
        }>((resolve, reject) => {
            let settled = false;
            const abortController = new AbortController();

            const timeoutHandle = setTimeout(() => {
                abortController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const externalSignal = options.signal;
            const onExternalAbort = () => {
                abortController.abort(externalSignal?.reason || new Error('Aborted by caller'));
            };
            if (externalSignal) {
                externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }

            const cleanup = () => {
                clearTimeout(timeoutHandle);
                if (externalSignal) {
                    externalSignal.removeEventListener('abort', onExternalAbort);
                }
                agent.destroy();
            };

            const reqOptions: https.RequestOptions = {
                protocol: parsed.protocol,
                host: hostname,
                port,
                path: parsed.pathname + parsed.search,
                method,
                headers: {
                    ...requestHeaders,
                    Host: hostname,
                },
                lookup: customLookup,
                agent,
                signal: abortController.signal,
                ...(isHttps ? { servername: hostname } : {}),
            };

            const client = isHttps ? https.request(reqOptions) : http.request(reqOptions);

            client.on('response', (res) => {
                if (settled) return;
                settled = true;
                resolve({
                    incoming: res,
                    statusCode: res.statusCode || 0,
                    statusText: res.statusMessage || '',
                    headers: res.headers,
                    cleanup,
                });
            });

            client.on('error', (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            });

            client.end();
        });

        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
            response.cleanup();
            response.incoming.destroy();

            const location = response.headers.location;
            if (!location) {
                throw new SsrfSecurityError(`Received redirect status ${status} without a Location header`);
            }

            redirectsRemaining--;
            if (redirectsRemaining < 0) {
                throw new SsrfSecurityError(`Maximum redirect limit of ${maxRedirects} exceeded`);
            }

            let nextUrl: URL;
            try {
                nextUrl = new URL(location, currentUrl);
            } catch {
                throw new SsrfSecurityError(`Invalid redirect Location URL: ${location}`);
            }

            if (nextUrl.origin !== parsed.origin) {
                delete requestHeaders['authorization'];
                delete requestHeaders['cookie'];
            }

            currentUrl = nextUrl.toString();
            continue;
        }

        const rawContentType = response.headers['content-type'] || '';
        const mimeType = rawContentType.split(';')[0].trim().toLowerCase();

        if (mimeType && allowedTypes.length > 0) {
            const isAllowed = allowedTypes.some((allowed) =>
                allowed === '*/*' || mimeType === allowed.toLowerCase()
            );
            if (!isAllowed) {
                response.cleanup();
                response.incoming.destroy();
                throw new SsrfSecurityError(`Prohibited Content-Type: ${mimeType}`);
            }
        }

        const contentLengthHeader = response.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = parseInt(contentLengthHeader, 10);
            if (!isNaN(contentLength) && contentLength > maxBytes) {
                response.cleanup();
                response.incoming.destroy();
                throw new PayloadTooLargeError(`Content-Length ${contentLength} exceeds maximum limit of ${maxBytes} bytes`);
            }
        }

        const incomingStream = response.incoming;
        let responseStream: Readable = incomingStream;

        const contentEncoding = (response.headers['content-encoding'] || '').toLowerCase().trim();
        let decompressor: Transform | null = null;

        if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
            decompressor = zlib.createGunzip();
        } else if (contentEncoding === 'deflate') {
            decompressor = zlib.createInflate();
        } else if (contentEncoding === 'br') {
            decompressor = zlib.createBrotliDecompress();
        }

        const rawLimitTransform = createByteLimitTransform(maxBytes, () => {
            incomingStream.destroy();
            if (decompressor) decompressor.destroy();
            response.cleanup();
        });

        if (decompressor) {
            const decompressedLimitTransform = createByteLimitTransform(maxBytes, () => {
                incomingStream.destroy();
                decompressor?.destroy();
                response.cleanup();
            });

            responseStream = incomingStream
                .pipe(rawLimitTransform)
                .pipe(decompressor)
                .pipe(decompressedLimitTransform);
        } else {
            responseStream = incomingStream.pipe(rawLimitTransform);
        }

        const readBodyBuffer = async (): Promise<Buffer> => {
            const chunks: Buffer[] = [];
            return new Promise<Buffer>((resPromise, rejPromise) => {
                responseStream.on('data', (chunk: Buffer) => chunks.push(chunk));
                responseStream.on('end', () => {
                    response.cleanup();
                    resPromise(Buffer.concat(chunks));
                });
                responseStream.on('error', (err) => {
                    response.cleanup();
                    incomingStream.destroy();
                    rejPromise(err);
                });
            });
        };

        return {
            status: response.statusCode,
            statusText: response.statusText,
            headers: response.headers,
            url: currentUrl,
            buffer: readBodyBuffer,
            text: async () => {
                const buf = await readBodyBuffer();
                return buf.toString('utf-8');
            },
            json: async <T = any>() => {
                const txt = (await readBodyBuffer()).toString('utf-8');
                return JSON.parse(txt) as T;
            },
        };
    }
}

// ============================================================================
// 3. XML, Entity & Date Parsing Helpers
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    'apos': "'",
    'nbsp': ' ',
    'ndash': '–',
    'mdash': '—',
    'lsquo': '‘',
    'rsquo': '’',
    'ldquo': '“',
    'rdquo': '”',
    'copy': '©',
    'reg': '®',
    'trade': '™',
    'hellip': '…',
};

export function decodeHtmlEntities(str: string): string {
    if (!str || !str.includes('&')) return str || '';

    return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (match, entity) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = parseInt(entity.slice(2), 16);
            if (!isNaN(code) && code >= 0 && code <= 0x10ffff) {
                try { return String.fromCodePoint(code); } catch { return match; }
            }
            return match;
        }
        if (entity.startsWith('#')) {
            const code = parseInt(entity.slice(1), 10);
            if (!isNaN(code) && code >= 0 && code <= 0x10ffff) {
                try { return String.fromCodePoint(code); } catch { return match; }
            }
            return match;
        }
        const lower = entity.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity)) return NAMED_ENTITIES[entity];
        if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
        return match;
    });
}

export function cleanXmlText(raw: string | null | undefined): string {
    if (!raw || typeof raw !== 'string') return '';
    let text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
    text = text.replace(/<[^>]+>/g, ' ');
    text = decodeHtmlEntities(text);
    if (text.includes('&')) {
        text = decodeHtmlEntities(text);
    }
    return text.replace(/\s+/g, ' ').trim();
}

function parseXmlAttributes(tagSnippet: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!tagSnippet) return attrs;
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(tagSnippet)) !== null) {
        const name = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        attrs[name] = decodeHtmlEntities(value.trim());
    }
    return attrs;
}

function extractTagContent(xml: string, tagNames: string[]): string | null {
    for (const tag of tagNames) {
        const escaped = tag.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const regex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>`, 'i');
        const match = xml.match(regex);
        if (match && match[1] !== undefined) {
            return match[1];
        }
    }
    return null;
}

function extractAllTags(
    xml: string,
    tagName: string
): Array<{ fullTag: string; attributes: Record<string, string>; content: string }> {
    if (!xml) return [];
    const escaped = tagName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${escaped}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${escaped}>|>)`, 'gi');
    const results: Array<{ fullTag: string; attributes: Record<string, string>; content: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        results.push({
            fullTag: match[0],
            attributes: parseXmlAttributes(match[1] || ''),
            content: match[2] || '',
        });
    }
    return results;
}

export function validateWebUrl(raw: string | null | undefined, baseUrl?: string | null): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        const u = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return u.toString();
        }
    } catch {
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
    }
    return null;
}

const TIMEZONE_OFFSETS: Record<string, string> = {
    'UTC': '+0000', 'UT': '+0000', 'GMT': '+0000', 'Z': '+0000',
    'EST': '-0500', 'EDT': '-0400', 'CST': '-0600', 'CDT': '-0500',
    'MST': '-0700', 'MDT': '-0600', 'PST': '-0800', 'PDT': '-0700',
    'AEST': '+1000', 'AEDT': '+1100', 'ACST': '+0930', 'ACDT': '+1030', 'AWST': '+0800',
    'BST': '+0100', 'CET': '+0100', 'CEST': '+0200', 'JST': '+0900',
};

const MONTH_MAP: Record<string, number> = {
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11,
};

export function parseFeedDate(raw: string | null | undefined, fallbackIso?: string): string | null {
    if (!raw || typeof raw !== 'string') return fallbackIso || null;
    const trimmed = cleanXmlText(raw);
    if (!trimmed) return fallbackIso || null;

    try {
        const directParsed = Date.parse(trimmed);
        if (!isNaN(directParsed) && directParsed > 0 && directParsed < 3e12) {
            return new Date(directParsed).toISOString();
        }

        let cleaned = trimmed
            .replace(/^[a-zA-Z]{3,9},\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();

        const tzMatch = cleaned.match(/\s+([a-zA-Z]{1,5}|[+-]\d{2}:?\d{2})$/);
        let tzOffsetMinutes = 0;
        let hasTz = false;

        if (tzMatch) {
            const tzStr = tzMatch[1].toUpperCase();
            if (TIMEZONE_OFFSETS[tzStr]) {
                const offsetStr = TIMEZONE_OFFSETS[tzStr];
                const sign = offsetStr[0] === '-' ? -1 : 1;
                const hours = parseInt(offsetStr.slice(1, 3), 10);
                const mins = parseInt(offsetStr.slice(3, 5), 10);
                tzOffsetMinutes = sign * (hours * 60 + mins);
                hasTz = true;
                cleaned = cleaned.slice(0, cleaned.length - tzMatch[0].length).trim();
            } else if (/^[+-]\d{2}:?\d{2}$/.test(tzStr)) {
                const cleanOffset = tzStr.replace(':', '');
                const sign = cleanOffset[0] === '-' ? -1 : 1;
                const hours = parseInt(cleanOffset.slice(1, 3), 10);
                const mins = parseInt(cleanOffset.slice(3, 5), 10);
                tzOffsetMinutes = sign * (hours * 60 + mins);
                hasTz = true;
                cleaned = cleaned.slice(0, cleaned.length - tzMatch[0].length).trim();
            }
        }

        const rfcMatch = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
        if (rfcMatch) {
            const day = parseInt(rfcMatch[1], 10);
            const monthStr = rfcMatch[2].toLowerCase();
            let year = parseInt(rfcMatch[3], 10);
            const hour = parseInt(rfcMatch[4], 10);
            const minute = parseInt(rfcMatch[5], 10);
            const second = rfcMatch[6] ? parseInt(rfcMatch[6], 10) : 0;

            if (year < 100) {
                year += year < 70 ? 2000 : 1900;
            }

            const month = MONTH_MAP[monthStr];
            if (month !== undefined && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
                const utcTimestamp = Date.UTC(year, month, day, hour, minute, second) - (hasTz ? tzOffsetMinutes * 60 * 1000 : 0);
                if (!isNaN(utcTimestamp)) {
                    return new Date(utcTimestamp).toISOString();
                }
            }
        }

        const isoMatch = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\s*([+-]\d{2}:?\d{2}|Z))?$/i.exec(trimmed);
        if (isoMatch) {
            const datePart = isoMatch[1];
            const timePart = isoMatch[2];
            let tzPart = isoMatch[3] || 'Z';
            if (tzPart !== 'Z' && !tzPart.includes(':') && tzPart.length === 5) {
                tzPart = `${tzPart.slice(0, 3)}:${tzPart.slice(3)}`;
            }
            const normalized = `${datePart}T${timePart}${tzPart}`;
            const tsNorm = Date.parse(normalized);
            if (!isNaN(tsNorm)) {
                return new Date(tsNorm).toISOString();
            }
        }
    } catch {
        // Fall through
    }

    return fallbackIso || null;
}

const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoId(input: string | null | undefined): string | null {
    if (!input || typeof input !== 'string') return null;
    const trimmed = cleanXmlText(input);
    if (!trimmed) return null;

    if (YOUTUBE_ID_PATTERN.test(trimmed)) {
        return trimmed;
    }

    const colonMatch = /(?:yt:video:|:video:)([a-zA-Z0-9_-]{11})\b/i.exec(trimmed);
    if (colonMatch) {
        return colonMatch[1];
    }

    try {
        const parsed = new URL(trimmed, 'https://www.youtube.com');
        const vParam = parsed.searchParams.get('v');
        if (vParam && YOUTUBE_ID_PATTERN.test(vParam)) {
            return vParam;
        }
        if (parsed.hostname.includes('youtu.be')) {
            const pathId = parsed.pathname.slice(1).split('/')[0];
            if (pathId && YOUTUBE_ID_PATTERN.test(pathId)) {
                return pathId;
            }
        }
        const pathMatch = /\/(?:v|embed|shorts|vi)\/([a-zA-Z0-9_-]{11})\b/i.exec(parsed.pathname);
        if (pathMatch) {
            return pathMatch[1];
        }
    } catch {
        const fallbackMatch = /(?:v=|youtu\.be\/|\/(?:v|embed|shorts|vi)\/)([a-zA-Z0-9_-]{11})\b/i.exec(trimmed);
        if (fallbackMatch) {
            return fallbackMatch[1];
        }
    }

    return null;
}

// ============================================================================
// 4. RSS 2.0 & Atom Feed Parsers
// ============================================================================

export function parseRss2Feed(xml: string, options?: { fallbackPublishedAt?: string; baseUrl?: string }): ParsedPulseFeed {
    const fallbackIso = options?.fallbackPublishedAt || new Date().toISOString();
    const baseUrl = options?.baseUrl;

    if (!xml || typeof xml !== 'string') {
        return { title: 'Untitled Feed', link: null, description: null, items: [] };
    }

    try {
        const sanitizedXml = xml
            .replace(/\uFEFF/g, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        const channelMatch = sanitizedXml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i);
        const channelHeader = channelMatch
            ? channelMatch[1].split(/<item\b/i)[0]
            : sanitizedXml.split(/<item\b/i)[0];

        const feedTitle = cleanXmlText(extractTagContent(channelHeader, ['title']) || 'Untitled Feed');
        const feedLink = validateWebUrl(cleanXmlText(extractTagContent(channelHeader, ['link']) || ''), baseUrl);
        const feedDesc = cleanXmlText(extractTagContent(channelHeader, ['description']) || '') || null;

        const itemBlocks: string[] = [];
        const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
        let match: RegExpExecArray | null;
        while ((match = itemRegex.exec(sanitizedXml)) !== null) {
            itemBlocks.push(match[1]);
        }
        if (itemBlocks.length === 0 && /<item\b/i.test(sanitizedXml)) {
            const parts = sanitizedXml.split(/<item\b[^>]*>/i);
            for (let i = 1; i < parts.length; i++) {
                const rawBlock = parts[i].split(/<\/item>/i)[0];
                if (rawBlock.trim()) itemBlocks.push(rawBlock);
            }
        }

        const items: ParsedPulseItem[] = [];
        for (const itemXml of itemBlocks) {
            try {
                const title = cleanXmlText(extractTagContent(itemXml, ['title', 'dc:title', 'media:title']) || 'Untitled');

                let link: string | null = null;
                const origLink = extractTagContent(itemXml, ['feedburner:origLink', 'origLink']);
                if (origLink) link = validateWebUrl(cleanXmlText(origLink), baseUrl);
                if (!link) {
                    const lContent = extractTagContent(itemXml, ['link']);
                    if (lContent) link = validateWebUrl(cleanXmlText(lContent), baseUrl);
                }
                if (!link) {
                    const atomLinks = [
                        ...extractAllTags(itemXml, 'atom:link'),
                        ...extractAllTags(itemXml, 'link'),
                    ];
                    for (const al of atomLinks) {
                        const href = al.attributes['href'];
                        const rel = al.attributes['rel'];
                        if (href && (!rel || rel === 'alternate')) {
                            link = validateWebUrl(href, baseUrl);
                            if (link) break;
                        }
                    }
                }

                let externalId: string | null = null;
                const guidMatch = itemXml.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
                if (guidMatch) {
                    externalId = cleanXmlText(guidMatch[2]);
                }
                if (!externalId && link) {
                    externalId = link;
                }
                if (!externalId) {
                    externalId = `hash:${crypto.createHash('sha256').update(`${title}|${link || ''}`).digest('hex')}`;
                }

                const publishedRaw = extractTagContent(itemXml, ['pubDate', 'pubdate', 'dc:date', 'date', 'published']);
                const publishedAt = parseFeedDate(publishedRaw, fallbackIso) || fallbackIso;

                let thumbnailUrl: string | null = null;
                const mediaThumbs = [
                    ...extractAllTags(itemXml, 'media:thumbnail'),
                    ...extractAllTags(itemXml, 'thumbnail'),
                ];
                for (const t of mediaThumbs) {
                    const url = t.attributes['url'] || t.attributes['href'];
                    if (url) {
                        thumbnailUrl = validateWebUrl(url, baseUrl);
                        if (thumbnailUrl) break;
                    }
                }
                if (!thumbnailUrl) {
                    const mediaContents = [
                        ...extractAllTags(itemXml, 'media:content'),
                        ...extractAllTags(itemXml, 'content'),
                        ...extractAllTags(itemXml, 'enclosure'),
                    ];
                    for (const mc of mediaContents) {
                        const url = mc.attributes['url'] || mc.attributes['href'];
                        const type = mc.attributes['type'] || '';
                        const medium = mc.attributes['medium'] || '';
                        if (url && (medium === 'image' || type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(url))) {
                            thumbnailUrl = validateWebUrl(url, baseUrl);
                            if (thumbnailUrl) break;
                        }
                    }
                }
                if (!thumbnailUrl) {
                    const itunesImages = extractAllTags(itemXml, 'itunes:image');
                    for (const ii of itunesImages) {
                        const url = ii.attributes['href'] || ii.attributes['url'];
                        if (url) {
                            thumbnailUrl = validateWebUrl(url, baseUrl);
                            if (thumbnailUrl) break;
                        }
                    }
                }
                if (!thumbnailUrl) {
                    const body = extractTagContent(itemXml, ['content:encoded', 'description', 'summary']) || itemXml;
                    const imgMatch = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i.exec(body);
                    if (imgMatch) {
                        const src = imgMatch[1] ?? imgMatch[2] ?? imgMatch[3] ?? '';
                        thumbnailUrl = validateWebUrl(decodeHtmlEntities(src), baseUrl);
                    }
                }

                const summary = cleanXmlText(extractTagContent(itemXml, ['description', 'summary', 'content:encoded']) || '') || null;
                const author = cleanXmlText(extractTagContent(itemXml, ['dc:creator', 'author', 'creator']) || '') || null;

                items.push({
                    externalId,
                    url: link,
                    title: title || 'Untitled',
                    thumbnailUrl,
                    publishedAt,
                    summary,
                    author,
                });
            } catch {
                // Defensive per item
            }
        }

        return {
            title: feedTitle || 'Untitled Feed',
            link: feedLink,
            description: feedDesc,
            items,
        };
    } catch {
        return { title: 'Untitled Feed', link: null, description: null, items: [] };
    }
}

export function parseAtomFeed(xml: string, feedUrl?: string): ParsedPulseFeed {
    const emptyResult: ParsedPulseFeed = {
        title: 'Untitled Feed',
        link: null,
        description: null,
        items: [],
    };

    if (!xml || typeof xml !== 'string') {
        return emptyResult;
    }

    try {
        const cleanXml = xml
            .replace(/\uFEFF/g, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        const feedTagMatch = /<feed\b([^>]*?)>/i.exec(cleanXml);
        let feedBase = feedUrl || null;
        if (feedTagMatch) {
            const feedAttrs = parseXmlAttributes(feedTagMatch[1]);
            const xmlBase = feedAttrs['xml:base'] || feedAttrs['base'];
            if (xmlBase) {
                feedBase = validateWebUrl(xmlBase, feedUrl);
            }
        }

        const firstEntryIndex = cleanXml.search(/<(?:[a-zA-Z0-9_-]+:)?entry\b/i);
        const headerXml = firstEntryIndex >= 0 ? cleanXml.slice(0, firstEntryIndex) : cleanXml;

        const feedTitle = cleanXmlText(extractTagContent(headerXml, ['title']) || 'Untitled Feed');
        const feedDesc = cleanXmlText(extractTagContent(headerXml, ['subtitle', 'description']) || '') || null;

        const feedLinks = extractAllTags(headerXml, 'link');
        let feedLink: string | null = null;
        for (const fl of feedLinks) {
            const rel = (fl.attributes['rel'] || 'alternate').toLowerCase().trim();
            const href = fl.attributes['href'] || fl.content.trim();
            if (href && (rel === 'alternate' || !feedLink)) {
                feedLink = validateWebUrl(href, feedBase);
                if (rel === 'alternate') break;
            }
        }

        const entryRegex = /<(?:[a-zA-Z0-9_-]+:)?entry\b([^>]*?)>([\s\S]*?)(?:<\/(?:[a-zA-Z0-9_-]+:)?entry>|(?=<(?:[a-zA-Z0-9_-]+:)?entry\b)|$)/gi;
        const items: ParsedPulseItem[] = [];

        let match: RegExpExecArray | null;
        while ((match = entryRegex.exec(cleanXml)) !== null) {
            const entryAttrs = parseXmlAttributes(match[1] || '');
            const entryBody = match[2] || '';

            let entryBase = feedBase;
            const entryXmlBase = entryAttrs['xml:base'] || entryAttrs['base'];
            if (entryXmlBase) {
                entryBase = validateWebUrl(entryXmlBase, feedBase);
            }

            let canonicalLink: string | null = null;
            const entryLinks = extractAllTags(entryBody, 'link');
            for (const l of entryLinks) {
                const rel = (l.attributes['rel'] || 'alternate').toLowerCase().trim();
                const href = l.attributes['href'] || l.content.trim();
                const type = (l.attributes['type'] || '').toLowerCase().trim();
                if (!href) continue;
                if (rel === 'alternate') {
                    if (!type || type === 'text/html' || type === 'application/xhtml+xml') {
                        canonicalLink = validateWebUrl(href, entryBase);
                        break;
                    } else if (!canonicalLink) {
                        canonicalLink = validateWebUrl(href, entryBase);
                    }
                } else if (rel !== 'self' && rel !== 'enclosure' && !canonicalLink) {
                    canonicalLink = validateWebUrl(href, entryBase);
                }
            }

            const ytVideoIdRaw = extractTagContent(entryBody, ['videoId', 'yt:videoId']);
            let ytVideoId = extractYouTubeVideoId(ytVideoIdRaw);
            const rawId = cleanXmlText(extractTagContent(entryBody, ['id']) || '');
            if (!ytVideoId && rawId) {
                ytVideoId = extractYouTubeVideoId(rawId);
            }
            if (!ytVideoId && canonicalLink) {
                ytVideoId = extractYouTubeVideoId(canonicalLink);
            }

            let externalId: string | null = null;
            if (ytVideoId) {
                externalId = ytVideoId;
            } else if (rawId) {
                externalId = rawId;
            } else if (canonicalLink) {
                externalId = canonicalLink;
            }

            const finalLink = canonicalLink || (ytVideoId ? `https://www.youtube.com/watch?v=${ytVideoId}` : null);

            const rawTitle = extractTagContent(entryBody, ['title', 'media:title']);
            const title = cleanXmlText(rawTitle) || 'Untitled';

            const publishedRaw = extractTagContent(entryBody, ['published', 'updated', 'pubDate', 'dc:date']);
            const publishedAt = parseFeedDate(publishedRaw) || new Date().toISOString();

            let thumbnailUrl: string | null = null;
            const thumbnails = extractAllTags(entryBody, 'thumbnail');
            let maxWidth = 0;
            for (const t of thumbnails) {
                const url = t.attributes['url'] || t.attributes['href'];
                if (url) {
                    const width = parseInt(t.attributes['width'] || '0', 10);
                    if (!thumbnailUrl || width > maxWidth) {
                        const val = validateWebUrl(url, entryBase);
                        if (val) {
                            thumbnailUrl = val;
                            maxWidth = width;
                        }
                    }
                }
            }
            if (!thumbnailUrl) {
                const mediaContents = [
                    ...extractAllTags(entryBody, 'content'),
                    ...extractAllTags(entryBody, 'enclosure'),
                ];
                for (const mc of mediaContents) {
                    const url = mc.attributes['url'] || mc.attributes['href'];
                    const medium = mc.attributes['medium'];
                    const type = mc.attributes['type'] || '';
                    if (url && (medium === 'image' || type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url))) {
                        thumbnailUrl = validateWebUrl(url, entryBase);
                        if (thumbnailUrl) break;
                    }
                }
            }
            if (!thumbnailUrl && ytVideoId) {
                thumbnailUrl = `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`;
            }

            const rawSummary = extractTagContent(entryBody, ['summary', 'media:description', 'content', 'description']);
            const summary = cleanXmlText(rawSummary) || null;

            const authorXml = extractTagContent(entryBody, ['author']);
            const author = authorXml ? cleanXmlText(extractTagContent(authorXml, ['name']) || '') : null;

            if (!externalId && !finalLink && (!title || title === 'Untitled')) {
                continue;
            }

            items.push({
                externalId: externalId || `hash:${crypto.createHash('sha256').update(`${title}|${finalLink || ''}`).digest('hex')}`,
                url: finalLink,
                title,
                thumbnailUrl,
                publishedAt,
                summary,
                author,
            });
        }

        return {
            title: feedTitle || 'Untitled Feed',
            link: feedLink,
            description: feedDesc,
            items,
        };
    } catch {
        return emptyResult;
    }
}

export function parseFeedXml(xml: string, feedUrl?: string): ParsedPulseFeed {
    if (!xml || typeof xml !== 'string') {
        return { title: 'Untitled Feed', link: null, description: null, items: [] };
    }
    const lower = xml.slice(0, 2000).toLowerCase();
    if (lower.includes('<feed') || lower.includes('xmlns="http://www.w3.org/2005/atom"')) {
        return parseAtomFeed(xml, feedUrl);
    }
    return parseRss2Feed(xml, { baseUrl: feedUrl });
}

// ============================================================================
// 5. Instagram og:description Post Count Probe
// ============================================================================

export async function probeInstagramPostCount(urlOrHandle: string): Promise<number | null> {
    let targetUrl: string;
    if (/^https?:\/\//i.test(urlOrHandle)) {
        targetUrl = urlOrHandle;
    } else {
        const handle = urlOrHandle.replace(/^@/, '').trim();
        targetUrl = `https://www.instagram.com/${handle}/`;
    }

    try {
        const response = await ssrfSafeFetch(targetUrl, {
            timeoutMs: 8000,
            maxBytes: 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        });

        const html = await response.text();

        const ogMatch = /<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(html)
            || /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i.exec(html)
            || /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html);

        if (ogMatch) {
            const desc = ogMatch[1];
            const postMatch = /([0-9,]+)\s*(?:Posts|posts)\b/.exec(desc);
            if (postMatch) {
                const count = parseInt(postMatch[1].replace(/,/g, ''), 10);
                if (!isNaN(count) && count >= 0) {
                    return count;
                }
            }
        }
    } catch {
        // Plain fetch fails or is challenged by bot wall
    }

    return null;
}

// ============================================================================
// 6. Channel Resolution & Deduplication
// ============================================================================

/**
 * Extract canonical YouTube Channel ID (UC...) from channel HTML.
 * Inspects canonical link tags, og:url metadata, schema.org itemprop,
 * embedded ytInitialData JSON, and feed URLs.
 */
export function extractYouTubeChannelIdFromHtml(html: string): string | null {
    if (!html || typeof html !== 'string') return null;

    // 1. Direct feed link in link tag or href
    const feedLinkMatch = /<link\s+[^>]*href=["'](?:https?:\/\/(?:www\.)?youtube\.com)?\/feeds\/videos\.xml\?channel_id=(UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html)
        || /<link\s+[^>]*type=["']application\/rss\+xml["'][^>]*href=["'][^"']*channel_id=(UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html)
        || /href=["'][^"']*\/feeds\/videos\.xml\?channel_id=(UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html);
    if (feedLinkMatch) return feedLinkMatch[1];

    // 2. Canonical / og:url link to /channel/UC...
    const canonicalMatch = /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html)
        || /<meta\s+[^>]*property=["']og:url["'][^>]*content=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html)
        || /<link\s+[^>]*href=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,24})["'][^>]*rel=["']canonical["']/i.exec(html);
    if (canonicalMatch) return canonicalMatch[1];

    // 3. Schema.org / itemprop metadata
    const itempropMatch = /<meta\s+[^>]*itemprop=["'](?:identifier|channelId)["'][^>]*content=["'](UC[a-zA-Z0-9_-]{20,24})["']/i.exec(html)
        || /<meta\s+[^>]*content=["'](UC[a-zA-Z0-9_-]{20,24})["'][^>]*itemprop=["'](?:identifier|channelId)["']/i.exec(html);
    if (itempropMatch) return itempropMatch[1];

    // 4. Embedded ytInitialData JSON properties: "channelId":"UC...", "externalId":"UC...", "browseId":"UC..."
    const jsonMatch = /"(?:channelId|externalId|browseId)":\s*"(UC[a-zA-Z0-9_-]{20,24})"/i.exec(html);
    if (jsonMatch) return jsonMatch[1];

    // 5. Fallback: Any /channel/UC... URL in the HTML
    const genericChannelMatch = /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,24})/i.exec(html);
    if (genericChannelMatch) return genericChannelMatch[1];

    return null;
}

/**
 * Discover RSS or Atom feed URL from an HTML document's <link rel="alternate" ...> tags.
 */
export function discoverFeedUrlFromHtml(html: string, baseUrl: string): string | null {
    if (!html || typeof html !== 'string') return null;

    const linkTags = html.match(/<link\b[^>]*>/gi) || [];
    for (const tag of linkTags) {
        const relMatch = /\brel=["'](?:alternate|feed)["']/i.test(tag) || /\brel=["'][^"']*\balternate\b[^"']*["']/i.test(tag);
        if (!relMatch) continue;

        const typeMatch = /\btype=["'](application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)(?:\s*;[^"']*)?["']/i.exec(tag);
        if (!typeMatch) continue;

        const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(tag);
        if (!hrefMatch) continue;

        const rawHref = decodeHtmlEntities(hrefMatch[1].trim());
        if (!rawHref) continue;

        try {
            const resolved = new URL(rawHref, baseUrl);
            if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
                return resolved.toString();
            }
        } catch {
            continue;
        }
    }

    return null;
}

/**
 * Build or resolve a YouTube channel's RSS feed URL.
 * If given a direct /channel/UC... or feed URL, returns immediately.
 * If given an @handle, /c/Name, /user/Name or vanity URL, fetches the channel page
 * via ssrfSafeFetch to resolve the canonical channel ID.
 */
export const YOUTUBE_HANDLE_PROBE_MAX_BYTES = 2 * 1024 * 1024;

export async function buildYouTubeFeedUrl(urlOrHandle: string): Promise<string | null> {
    if (!urlOrHandle) return null;
    const trimmed = urlOrHandle.trim();

    // 1. Direct feed URL
    if (trimmed.includes('youtube.com/feeds/videos.xml')) {
        return trimmed;
    }

    // 2. Direct channel ID URL (/channel/UC...)
    const channelMatch = /(?:youtube\.com\/channel\/)(UC[a-zA-Z0-9_-]{20,24})/i.exec(trimmed);
    if (channelMatch) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`;
    }

    // 3. Direct UC ID string
    if (/^UC[a-zA-Z0-9_-]{20,24}$/.test(trimmed)) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${trimmed}`;
    }

    // 4. Normalise to full youtube.com URL for @handle, /c/Name, /user/Name with domain gating
    let targetUrl: string;
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const host = parsed.hostname.toLowerCase();
            if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
                targetUrl = trimmed;
            } else {
                return null;
            }
        } catch {
            return null;
        }
    } else if (/^(?:www\.)?(?:m\.)?youtube\.com\//i.test(trimmed) || /^youtu\.be\//i.test(trimmed)) {
        targetUrl = `https://${trimmed}`;
    } else if (trimmed.startsWith('@')) {
        targetUrl = `https://www.youtube.com/${trimmed}`;
    } else if (trimmed.startsWith('/')) {
        targetUrl = `https://www.youtube.com${trimmed}`;
    } else {
        targetUrl = `https://www.youtube.com/@${trimmed}`;
    }

    // 5. Fetch page using ssrfSafeFetch to resolve handle to channel id.
    //
    // The cap must clear the whole document, NOT just the <head>. A real YouTube
    // channel page is ~860KB and puts every usable identifier deep in the body:
    // measured on youtube.com/@beanpool, rel=canonical sits at byte ~746k,
    // browseId at ~760k and externalId at ~838k. An earlier 256KB cap therefore
    // tripped the byte limiter before a single identifier appeared — and the
    // limiter throws rather than truncating, so the probe failed outright and
    // every handle reported "Could not resolve YouTube channel ID from handle".
    try {
        const response = await ssrfSafeFetch(targetUrl, {
            timeoutMs: 8000,
            maxBytes: YOUTUBE_HANDLE_PROBE_MAX_BYTES,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        const html = await response.text();
        const channelId = extractYouTubeChannelIdFromHtml(html);
        if (channelId) {
            return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        }
    } catch {
        // Fetch failed or blocked by SSRF
    }

    return null;
}

/**
 * Extract numeric SoundCloud user ID from profile HTML.
 * Inspects iOS app meta tags, Google Play meta tags, api links, and schema metadata.
 */
export function extractSoundCloudUserIdFromHtml(html: string): string | null {
    if (!html || typeof html !== 'string') return null;
    const match = /soundcloud:\/\/(?:users|user):(\d+)/i.exec(html)
        || /soundcloud:(?:users|user):(\d+)/i.exec(html)
        || /["']soundcloud:(?:users|user):(\d+)["']/i.exec(html)
        || /api\.soundcloud\.com\/users\/(\d+)/i.exec(html);
    return match ? match[1] : null;
}

/**
 * Build or resolve a SoundCloud creator's public RSS feed URL.
 */
export async function buildSoundCloudFeedUrl(urlOrHandle: string): Promise<string | null> {
    if (!urlOrHandle) return null;
    const trimmed = urlOrHandle.trim();

    // 1. Direct feeds.soundcloud.com URL
    if (trimmed.includes('feeds.soundcloud.com/users/soundcloud:users:')) {
        return trimmed;
    }

    // 2. Normalise to full soundcloud.com URL
    let targetUrl: string;
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const host = parsed.hostname.toLowerCase();
            if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'snd.sc') {
                targetUrl = trimmed;
            } else {
                return null;
            }
        } catch {
            return null;
        }
    } else if (trimmed.startsWith('@')) {
        targetUrl = `https://soundcloud.com/${trimmed.slice(1)}`;
    } else {
        targetUrl = `https://soundcloud.com/${trimmed}`;
    }

    try {
        const response = await ssrfSafeFetch(targetUrl, {
            timeoutMs: 8000,
            maxBytes: 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (response.status === 200) {
            const html = await response.text();
            const directFeed = discoverFeedUrlFromHtml(html, targetUrl);
            if (directFeed && directFeed.includes('feeds.soundcloud.com')) {
                return directFeed;
            }
            const userId = extractSoundCloudUserIdFromHtml(html);
            if (userId) {
                return `https://feeds.soundcloud.com/users/soundcloud:users:${userId}/sounds.rss`;
            }
            return directFeed || null;
        }
    } catch {
        // Fetch failed or blocked by SSRF
    }

    return null;
}

export async function resolveChannel(channelId: string): Promise<{ count: number; error?: string }> {
    const channel = db.prepare(
        `SELECT id, owner_pubkey, platform, url, handle, category, supports_autolist,
                syndicate_to_node, fail_count, last_error, is_stale, created_at
           FROM creator_channels
          WHERE id = ? AND deleted_at IS NULL`
    ).get(channelId) as any;

    if (!channel) {
        return { count: 0, error: 'Channel not found' };
    }

    const now = new Date().toISOString();

    if (channel.platform === 'instagram') {
        const postCount = await probeInstagramPostCount(channel.url || channel.handle);
        if (postCount !== null) {
            db.prepare(
                `UPDATE creator_channels
                    SET post_count_seen = ?, fail_count = 0, last_error = NULL, is_stale = 0, updated_at = ?
                  WHERE id = ?`
            ).run(postCount, now, channel.id);
            return { count: postCount };
        } else {
            const nextFails = (channel.fail_count || 0) + 1;
            const isStale = nextFails >= 3 ? 1 : (channel.is_stale || 0);
            db.prepare(
                `UPDATE creator_channels
                    SET fail_count = ?, last_error = 'Failed to probe Instagram post count', is_stale = ?, updated_at = ?
                  WHERE id = ?`
            ).run(nextFails, isStale, now, channel.id);
            return { count: 0, error: 'Failed to probe post count' };
        }
    }

    if (channel.supports_autolist !== 1) {
        return { count: 0, error: channel.last_error || undefined };
    }

    try {
        let feedUrl: string | null = null;
        let feedXmlContent: string | null = null;

        if (channel.platform === 'youtube') {
            const directChannelMatch = /(?:youtube\.com\/channel\/)(UC[a-zA-Z0-9_-]{20,24})/i.exec(channel.url || '')
                || /(?:youtube\.com\/feeds\/videos\.xml\?channel_id=)(UC[a-zA-Z0-9_-]{20,24})/i.exec(channel.url || '');

            if (directChannelMatch) {
                feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${directChannelMatch[1]}`;
            } else {
                feedUrl = await buildYouTubeFeedUrl(channel.url || channel.handle || '');
                if (feedUrl) {
                    // Extract UC id and persist it on the channel row so subsequent lookups are instant
                    const ucMatch = /channel_id=(UC[a-zA-Z0-9_-]{20,24})/i.exec(feedUrl);
                    if (ucMatch) {
                        const canonicalChannelUrl = `https://www.youtube.com/channel/${ucMatch[1]}`;
                        db.prepare(
                            `UPDATE creator_channels
                                SET url = ?, updated_at = ?
                              WHERE id = ?`
                        ).run(canonicalChannelUrl, now, channel.id);
                    }
                } else {
                    const nextFails = (channel.fail_count || 0) + 1;
                    const isStale = nextFails >= 3 ? 1 : (channel.is_stale || 0);
                    const errMsg = 'Could not resolve YouTube channel ID from handle';
                    db.prepare(
                        `UPDATE creator_channels
                            SET fail_count = ?, last_error = ?, is_stale = ?, updated_at = ?
                          WHERE id = ?`
                    ).run(nextFails, errMsg, isStale, now, channel.id);
                    return { count: 0, error: errMsg };
                }
            }
        } else if (channel.platform === 'website' || channel.platform === 'rss') {
            const initialUrl = channel.url;
            if (!initialUrl) {
                return { count: 0, error: 'No URL available' };
            }

            const initialResp = await ssrfSafeFetch(initialUrl, {
                timeoutMs: 8000,
                maxBytes: 256 * 1024,
            });

            const initialText = await initialResp.text();
            const trimmedLower = initialText.slice(0, 2000).trimStart().toLowerCase();
            const isHtml = trimmedLower.startsWith('<!doctype html') || trimmedLower.startsWith('<html') || /<html[\s>]/i.test(trimmedLower);
            const isDirectXml = !isHtml && (
                trimmedLower.startsWith('<?xml') ||
                /<(?:rss|feed)[\s>]/i.test(initialText) ||
                initialText.includes('xmlns="http://www.w3.org/2005/atom"')
            );

            if (isDirectXml) {
                feedUrl = initialUrl;
                feedXmlContent = initialText;
            } else {
                // Discover feed from HTML <link rel="alternate" ...>
                const discoveredFeed = discoverFeedUrlFromHtml(initialText, initialUrl);
                if (discoveredFeed) {
                    feedUrl = discoveredFeed;
                } else {
                    const noFeedMsg = "This site doesn't publish a feed — share posts manually";
                    db.prepare(
                        `UPDATE creator_channels
                            SET supports_autolist = 0, last_error = ?, fail_count = 0, is_stale = 0, updated_at = ?
                          WHERE id = ?`
                    ).run(noFeedMsg, now, channel.id);
                    return { count: 0, error: noFeedMsg };
                }
            }
        } else if (channel.platform === 'soundcloud') {
            const initialUrl = channel.url;
            if (!initialUrl) {
                return { count: 0, error: 'No URL available' };
            }
            feedUrl = await buildSoundCloudFeedUrl(initialUrl);
            if (feedUrl) {
                if (feedUrl !== initialUrl && feedUrl.includes('feeds.soundcloud.com')) {
                    db.prepare(
                        `UPDATE creator_channels SET url = ?, updated_at = ? WHERE id = ?`
                    ).run(feedUrl, now, channel.id);
                }
            } else {
                const nextFails = (channel.fail_count || 0) + 1;
                const isStale = nextFails >= 3 ? 1 : (channel.is_stale || 0);
                const errMsg = "SoundCloud profile has no public RSS feed — share tracks manually";
                db.prepare(
                    `UPDATE creator_channels
                        SET fail_count = ?, last_error = ?, is_stale = ?, updated_at = ?
                      WHERE id = ?`
                ).run(nextFails, errMsg, isStale, now, channel.id);
                return { count: 0, error: errMsg };
            }
        } else {
            feedUrl = channel.url;
        }

        if (!feedUrl) {
            return { count: 0, error: 'No feed URL available' };
        }

        let xml = feedXmlContent;
        if (!xml) {
            const response = await ssrfSafeFetch(feedUrl, {
                timeoutMs: 8000,
                maxBytes: 2 * 1024 * 1024,
            });
            xml = await response.text();
        }

        const parsed = parseFeedXml(xml, feedUrl);
        const thirtyDaysAgoMs = Date.now() - (30 * 24 * 60 * 60 * 1000);
        let insertedOrUpdated = 0;

        const insertItem = db.prepare(
            `INSERT INTO pulse_items
                (id, channel_id, owner_pubkey, platform, external_id,
                 url, title, thumbnail_url, published_at, category,
                 source, muted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'autolist', 0, ?, ?)
             ON CONFLICT(channel_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL
             DO UPDATE SET
                url           = excluded.url,
                title         = excluded.title,
                thumbnail_url = excluded.thumbnail_url,
                updated_at    = excluded.updated_at`
        );

        db.transaction(() => {
            for (const item of parsed.items) {
                const pubMs = Date.parse(item.publishedAt);
                if (!isNaN(pubMs) && pubMs < thirtyDaysAgoMs) {
                    continue;
                }

                const itemId = `item_${crypto.randomBytes(12).toString('hex')}`;
                insertItem.run(
                    itemId,
                    channel.id,
                    channel.owner_pubkey,
                    channel.platform,
                    item.externalId,
                    item.url,
                    item.title,
                    item.thumbnailUrl,
                    item.publishedAt || now,
                    channel.category,
                    now,
                    now
                );
                insertedOrUpdated++;
            }

            db.prepare(
                `UPDATE creator_channels
                    SET supports_autolist = 1, fail_count = 0, last_error = NULL, is_stale = 0, updated_at = ?
                  WHERE id = ?`
            ).run(now, channel.id);
        })();

        return { count: insertedOrUpdated };
    } catch (err: any) {
        const nextFails = (channel.fail_count || 0) + 1;
        const isStale = nextFails >= 3 ? 1 : (channel.is_stale || 0);
        const errMsg = err?.message || String(err);

        db.prepare(
            `UPDATE creator_channels
                SET fail_count = ?, last_error = ?, is_stale = ?, updated_at = ?
              WHERE id = ?`
        ).run(nextFails, errMsg.slice(0, 500), isStale, now, channel.id);

        return { count: 0, error: errMsg };
    }
}

// ============================================================================
// 7. 30-Day Pruning & Tombstone Scrubbing
// ============================================================================

/**
 * Single tombstone scrubbing helper conforming to Contract A:
 * Non-negotiable rule 1: Deleting an item sets deleted_at and NULLs url, title, and thumbnail_url
 * in the SAME statement so the deletion replicates without carrying the content.
 */
export function scrubPulseItems(
    target: { channelId?: string; ownerPubkey?: string; id?: string },
    timestamp?: string
): number {
    const now = timestamp || new Date().toISOString();
    let query = `UPDATE pulse_items
                    SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL, updated_at = ?
                  WHERE deleted_at IS NULL`;
    const params: any[] = [now, now];

    if (target.id) {
        query += ' AND id = ?';
        params.push(target.id);
    }
    if (target.channelId) {
        query += ' AND channel_id = ?';
        params.push(target.channelId);
    }
    if (target.ownerPubkey) {
        query += ' AND owner_pubkey = ?';
        params.push(target.ownerPubkey);
    }

    const info = db.prepare(query).run(...params);
    return info.changes;
}

/**
 * Prunes pulse items older than 30 days by tombstoning them.
 */
export function prunePulseItems(maxAgeDays = 30): number {
    const now = new Date().toISOString();
    const cutoffMs = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const cutoff = new Date(cutoffMs).toISOString();

    const info = db.prepare(
        `UPDATE pulse_items
            SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL, updated_at = ?
          WHERE deleted_at IS NULL AND published_at < ?`
    ).run(now, now, cutoff);

    return info.changes;
}

// ============================================================================
// 8. Scheduler Tick
// ============================================================================

let isSchedulerRunning = false;
let schedulerTimer: NodeJS.Timeout | null = null;

export async function runPulseSchedulerTick(): Promise<void> {
    if (isSchedulerRunning) return;
    isSchedulerRunning = true;

    try {
        prunePulseItems(30);

        const channels = db.prepare(
            `SELECT id FROM creator_channels
              WHERE deleted_at IS NULL AND syndicate_to_node = 1 AND supports_autolist = 1
              ORDER BY fail_count ASC, updated_at ASC
              LIMIT 10`
        ).all() as { id: string }[];

        for (const ch of channels) {
            try {
                await resolveChannel(ch.id);
            } catch {
                // Ignore individual resolver failure in scheduler loop
            }
            await new Promise(r => setTimeout(r, 100));
        }
    } finally {
        isSchedulerRunning = false;
    }
}

export function startPulseScheduler(intervalMs = 5 * 60 * 1000): void {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
        runPulseSchedulerTick().catch(() => {});
    }, intervalMs);
}

export function stopPulseScheduler(): void {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }
}

// ============================================================================
// 9. Contract B Feed Query & Item Muting
// ============================================================================

export interface PulseFeedOptions {
    cursor?: string;
    category?: string;
    limit?: number;
}

/**
 * The feed's sort key. NULL published_at sorts as '' — last under DESC — so an
 * item the source gave no date for still has a stable, reachable position.
 * The two feed indexes in schema.sql index this exact expression; change one and
 * you must change the other or the feed silently starts scanning.
 */
const FEED_SORT_KEY = "COALESCE(i.published_at, '')";

/** Cursor is `<sort key>|<id>` — ISO timestamps carry no '|' and ids are hex. */
export function encodePulseCursor(publishedAt: string | null, id: string): string {
    return `${publishedAt ?? ''}|${id}`;
}

/**
 * Tolerant of a cursor with no id: that page boundary is then timestamp-only,
 * which is the pre-keyset behaviour and merely risks repeating an item rather
 * than skipping one.
 */
export function decodePulseCursor(cursor: string): { sortKey: string; id: string | null } {
    const sep = cursor.lastIndexOf('|');
    if (sep === -1) return { sortKey: cursor, id: null };
    return { sortKey: cursor.slice(0, sep), id: cursor.slice(sep + 1) || null };
}

export function getPulseFeed(options: PulseFeedOptions = {}): { items: PulseFeedCard[]; nextCursor: string | null } {
    const limit = Math.min(50, Math.max(1, typeof options.limit === 'number' ? options.limit : 20));
    const conditions: string[] = [
        'c.deleted_at IS NULL',
        'c.syndicate_to_node = 1',
        'i.deleted_at IS NULL',
        'i.muted = 0',
        "m.status = 'active'",
    ];
    const params: unknown[] = [];

    if (options.category && typeof options.category === 'string') {
        conditions.push('i.category = ?');
        params.push(options.category);
    }

    // Keyset pagination on (published_at, id), not published_at alone. A feed
    // routinely publishes a batch of items with one identical timestamp, and
    // `published_at < cursor` drops every one of them that did not fit on the
    // page. COALESCE keeps NULL-dated items reachable too: `NULL < cursor` is
    // NULL, so under the old clause they could never appear past page 1.
    if (options.cursor && typeof options.cursor === 'string') {
        const { sortKey, id } = decodePulseCursor(options.cursor);
        if (id === null) {
            conditions.push(`${FEED_SORT_KEY} < ?`);
            params.push(sortKey);
        } else {
            conditions.push(`(${FEED_SORT_KEY} < ? OR (${FEED_SORT_KEY} = ? AND i.id < ?))`);
            params.push(sortKey, sortKey, id);
        }
    }

    const rows = db.prepare(
        `SELECT i.id, i.owner_pubkey, i.platform, i.url, i.title, i.thumbnail_url,
                i.published_at, i.category, i.source, c.oauth_verified_at,
                m.callsign, m.avatar_url
           FROM pulse_items i
           JOIN creator_channels c ON c.id = i.channel_id
           JOIN members m ON m.public_key = i.owner_pubkey
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${FEED_SORT_KEY} DESC, i.id DESC
          LIMIT ?`
    ).all(...params, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
    const nextCursor = last ? encodePulseCursor(last.published_at, last.id) : null;

    const items: PulseFeedCard[] = pageRows.map(r => ({
        id: r.id,
        ownerPubkey: r.owner_pubkey,
        callsign: r.callsign || 'Neighbour',
        avatarUrl: r.avatar_url || null,
        platform: r.platform,
        category: r.category,
        url: r.url || null,
        title: r.title || null,
        thumbnailUrl: r.thumbnail_url || null,
        publishedAt: r.published_at || null,
        source: r.source,
        isVerified: Boolean(r.oauth_verified_at),
    }));

    return { items, nextCursor };
}

export function setPulseItemMute(actorPubkey: string, itemId: string, muted: boolean): { success: boolean; item: PulseFeedCard } {
    const row = db.prepare(
        `SELECT i.id, i.owner_pubkey, i.platform, i.url, i.title, i.thumbnail_url,
                i.published_at, i.category, i.source, i.muted, i.deleted_at,
                c.oauth_verified_at, m.callsign, m.avatar_url
           FROM pulse_items i
           JOIN creator_channels c ON c.id = i.channel_id
           JOIN members m ON m.public_key = i.owner_pubkey
          WHERE i.id = ?`
    ).get(itemId) as any;

    if (!row || row.deleted_at !== null) {
        throw new PulseError('NOT_FOUND', 'Item not found.');
    }

    if (row.owner_pubkey !== actorPubkey) {
        throw new PulseError('NOT_YOURS', 'That item belongs to another member.');
    }

    const now = new Date().toISOString();
    const mutedInt = muted ? 1 : 0;

    db.prepare(
        `UPDATE pulse_items
            SET muted = ?, updated_at = ?
          WHERE id = ?`
    ).run(mutedInt, now, itemId);

    return {
        success: true,
        item: {
            id: row.id,
            ownerPubkey: row.owner_pubkey,
            callsign: row.callsign || 'Neighbour',
            avatarUrl: row.avatar_url || null,
            platform: row.platform,
            category: row.category,
            url: row.url || null,
            title: row.title || null,
            thumbnailUrl: row.thumbnail_url || null,
            publishedAt: row.published_at || null,
            source: row.source,
            isVerified: Boolean(row.oauth_verified_at),
        },
    };
}
