/**
 * One community's server speaking to another's: the server's key, published, and the signature on every request one
 * server sends another (messages across communities, slice X1: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.2,
 * and DESIGN-cross-community-chat-fable.md §2.4, slice S2.1). The shape is Matrix's server-to-server one (a key document
 * with a validity, and a request signature naming origin and destination), written here from that design, not from any
 * code of theirs.
 *
 * **The key document**, `GET /api/node/key` on every server: its own Ed25519 key (the node key, data/libp2p_key, which
 * already signs its push notices), until when that key may be trusted (`validUntil`, never more than NODE_KEY_VALIDITY_MS
 * ahead), and the keys it signed with before, each with until when a request signed by it may still be accepted. Signed by
 * the key it names, so it proves the server holds that key. Another server fetches it over TLS from the host a request
 * names as its origin: that host's certificate is what ties the key to the name (trust on first use). Nothing of ours is
 * asked, and any domain or public address with a certificate will do.
 *
 * **The request signature**, header X-BeanPool-Node:
 *
 *   v=1, origin=<host>, destination=<host>, key=<64 hex>, ts=<ms>, nonce=<32 hex>, sig=<base64>
 *
 * over the bytes
 *
 *   0xFF ‖ utf8( "beanpool-node-request/1\n" ORIGIN "\n" DESTINATION "\n" METHOD "\n" PATH "\n" TS "\n" NONCE "\n"
 *                hex(SHA-256(BODY)) )
 *
 * the member format-2 shape (request-signing.ts) under its own tag, so no member signature can be taken for a server's and
 * no server's for a member's. ORIGIN is the sending server's own name, DESTINATION the host it connected to, both in the one
 * form {@link audienceOf} writes (lower case, no scheme, port, path or trailing dot). PATH is the path alone, as the
 * receiver's router sees it. The receiving server takes a request only when DESTINATION is one of its own names, the time
 * is within NODE_REQUEST_SKEW_MS of its clock, the key is ORIGIN's (its key document names it, current or previous, still
 * valid), the signature checks out, and the nonce was never spent (apps/server engine/node-signature.ts).
 *
 * One spelling for everything: a key, a nonce and a time are each one exact form, and a signature is canonical base64 of 64
 * bytes. Every check is strict RFC 8032 (`zip215: false`): one signature for one key and message.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { audienceOf, signedPathOf, signedRequestBytes, toBase64, utf8Bytes, type Signer } from './request-signing.js';

/** The tag line of a server's request signature. */
export const NODE_REQUEST_TAG = 'beanpool-node-request/1';
/** The tag line of a server's key document. */
export const NODE_KEY_TAG = 'beanpool-node-key/1';
/** The header a server's request signature travels in. */
export const NODE_REQUEST_HEADER = 'X-BeanPool-Node';
/** Where every server publishes its key document. */
export const NODE_KEY_PATH = '/api/node/key';
/** The version this code writes and reads, of the header and of the key document. */
export const NODE_REQUEST_VERSION = 1;
/** How far a request's time may be from the receiving server's clock, either way. */
export const NODE_REQUEST_SKEW_MS = 5 * 60_000;
/** The longest a key document may promise its key for. A receiver asks again by then. */
export const NODE_KEY_VALIDITY_MS = 7 * 24 * 60 * 60_000;
/** The most previous keys a key document may list. */
export const NODE_KEY_PREVIOUS_MAX = 8;

const KEY_HEX = /^[0-9a-f]{64}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const DIGITS = /^(0|[1-9][0-9]{0,15})$/;
const METHOD = /^[A-Z]{1,16}$/;
const SIG_B64 = /^[A-Za-z0-9+/]{86}==$/;

// ─── Spellings ──────────────────────────────────────────────────────────────────────────────

/** Whether `host` is a server name in the one form signed: exactly what {@link audienceOf} makes of it. */
export function isNodeHost(host: unknown): host is string {
    return typeof host === 'string' && host.length > 0 && host.length <= 253 && audienceOf(host) === host;
}

/** A path as a router sees it: from the first `/`, no query, no fragment, no line break, no backslash. */
function isRequestPath(path: unknown): path is string {
    return typeof path === 'string' && path.startsWith('/') && path.length <= 2048 && !/[?#\s\\]/.test(path);
}

/** A time in milliseconds as signed: digits only, no sign, no leading zero, a safe integer. */
function timeOf(text: unknown): number | null {
    if (typeof text !== 'string' || !DIGITS.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
}

/** 64 signature bytes from canonical base64 (its one spelling), or null. */
export function signatureBytesOf(sig: unknown): Uint8Array | null {
    if (typeof sig !== 'string' || !SIG_B64.test(sig)) return null;
    const bytes = new Uint8Array(Buffer.from(sig, 'base64'));
    return bytes.length === 64 && toBase64(bytes) === sig ? bytes : null;
}

/** Strict Ed25519 (RFC 8032): never throws. */
function verifiesStrictly(sig: Uint8Array, message: Uint8Array, keyHex: string): boolean {
    if (!KEY_HEX.test(keyHex)) return false;
    try {
        return ed25519.verify(sig, message, hexToBytes(keyHex), { zip215: false });
    } catch {
        return false;
    }
}

/** hex SHA-256 of a request body: of its UTF-8 when it is text, of the bytes themselves otherwise. */
export function nodeBodyHash(body: string | Uint8Array): string {
    return bytesToHex(sha256(typeof body === 'string' ? utf8Bytes(body) : body));
}

// ─── The request signature ──────────────────────────────────────────────────────────────────

export interface NodeRequestFields {
    origin: string;
    destination: string;
    method: string;
    path: string;
    /** Milliseconds, as the header writes it. */
    timestamp: string;
    nonce: string;
    /** {@link nodeBodyHash} of the body as sent. */
    bodyHash: string;
}

/** The text a server's request signature is over (the signed bytes are 0xFF, then this in UTF-8). */
export function nodeRequestText(f: NodeRequestFields): string {
    return `${NODE_REQUEST_TAG}\n${f.origin}\n${f.destination}\n${f.method}\n${f.path}\n${f.timestamp}\n${f.nonce}\n${f.bodyHash}`;
}

/** The bytes a server signs for a request: 0xFF, then {@link nodeRequestText} in UTF-8. */
export function nodeRequestBytes(f: NodeRequestFields): Uint8Array {
    return signedRequestBytes(nodeRequestText(f));
}

/** The X-BeanPool-Node header, read: every field in its one spelling. */
export interface NodeRequestHeader {
    origin: string;
    destination: string;
    /** The signing key, raw Ed25519, lower-case hex. */
    key: string;
    /** As written, and as a number. */
    timestamp: string;
    at: number;
    nonce: string;
    sig: Uint8Array;
}

const HEADER_FIELDS = ['v', 'origin', 'destination', 'key', 'ts', 'nonce', 'sig'] as const;

/**
 * The X-BeanPool-Node header read back, or null when it is not one: every field present once, no other, each in its one
 * spelling. Nothing here says the request is good; only that it is well formed.
 */
export function parseNodeRequestHeader(value: unknown): NodeRequestHeader | null {
    if (typeof value !== 'string' || value.length > 1024) return null;
    const fields = new Map<string, string>();
    for (const part of value.split(',')) {
        const item = part.trim();
        const eq = item.indexOf('=');
        if (eq <= 0) return null;
        const name = item.slice(0, eq);
        if (!(HEADER_FIELDS as readonly string[]).includes(name) || fields.has(name)) return null;
        fields.set(name, item.slice(eq + 1));
    }
    if (fields.size !== HEADER_FIELDS.length || fields.get('v') !== String(NODE_REQUEST_VERSION)) return null;
    const origin = fields.get('origin')!, destination = fields.get('destination')!, key = fields.get('key')!;
    const timestamp = fields.get('ts')!, nonce = fields.get('nonce')!;
    const at = timeOf(timestamp);
    const sig = signatureBytesOf(fields.get('sig'));
    if (!isNodeHost(origin) || !isNodeHost(destination) || !KEY_HEX.test(key) || at === null || !NONCE_HEX.test(nonce) || !sig) return null;
    return { origin, destination, key, timestamp, at, nonce, sig };
}

/** The X-BeanPool-Node header for these fields and signature. */
export function formatNodeRequestHeader(h: Omit<NodeRequestHeader, 'at'>): string {
    return `v=${NODE_REQUEST_VERSION}, origin=${h.origin}, destination=${h.destination}, key=${h.key}, ts=${h.timestamp}, `
        + `nonce=${h.nonce}, sig=${toBase64(h.sig)}`;
}

/**
 * Whether `h`'s signature is its key's over this request: the method and path the receiver routed, and the body exactly as
 * it arrived. Says nothing about whether the key is the origin's (its key document) or the nonce is new.
 */
export function nodeRequestSignatureVerifies(h: NodeRequestHeader, request: { method: string; path: string; body: string | Uint8Array }): boolean {
    if (!METHOD.test(request.method) || !isRequestPath(request.path)) return false;
    const bytes = nodeRequestBytes({
        origin: h.origin, destination: h.destination, method: request.method, path: request.path,
        timestamp: h.timestamp, nonce: h.nonce, bodyHash: nodeBodyHash(request.body),
    });
    return verifiesStrictly(h.sig, bytes, h.key);
}

export interface NodeRequestInput {
    method: string;
    /** The full URL the request goes to: the destination is its host, the path its path. */
    url: string;
    /** Exactly the body sent ('' for none). */
    body: string | Uint8Array;
    /** The sending server's own name, as it is reached (its primary address). */
    origin: string;
    /** The sending server's key, raw Ed25519, lower-case hex: the one its key document names. */
    keyHex: string;
    sign: Signer;
    /** Defaults to now. */
    timestamp?: number;
    /** Defaults to 16 random bytes in hex. */
    nonce?: string;
}

/** The X-BeanPool-Node header for a request a server sends. Throws, having signed nothing, on anything it can't carry. */
export async function buildNodeRequestHeaders(input: NodeRequestInput): Promise<Record<string, string>> {
    const destination = audienceOf(input.url);
    if (!destination) throw new Error(`Cannot sign a server request for ${JSON.stringify(input.url)}: it names no host`);
    if (!isNodeHost(input.origin)) throw new Error(`Cannot sign a server request from ${JSON.stringify(input.origin)}: not a bare host name`);
    if (!KEY_HEX.test(input.keyHex)) throw new Error('Cannot sign a server request: the key is not 64 lower-case hex characters');
    const method = input.method.toUpperCase();
    const path = signedPathOf(input.url);
    if (!METHOD.test(method) || !isRequestPath(path)) throw new Error('Cannot sign a server request with that method or path');
    const timestamp = String(input.timestamp ?? Date.now());
    if (timeOf(timestamp) === null) throw new Error('Cannot sign a server request at that time');
    const nonce = input.nonce ?? bytesToHex(randomBytes(16));
    if (!NONCE_HEX.test(nonce)) throw new Error('A server request nonce is 32 lower-case hex characters');
    const fields = { origin: input.origin, destination, method, path, timestamp, nonce, bodyHash: nodeBodyHash(input.body) };
    const sig = await input.sign(nodeRequestBytes(fields));
    return { [NODE_REQUEST_HEADER]: formatNodeRequestHeader({ origin: input.origin, destination, key: input.keyHex, timestamp, nonce, sig }) };
}

// ─── The key document ───────────────────────────────────────────────────────────────────────

/** A key a server signed with before, and until when a request it signed may still be accepted. */
export interface PreviousNodeKey {
    key: string;
    validUntil: number;
}

/** What `GET /api/node/key` answers. */
export interface NodeKeyDocument {
    v: 1;
    /** The key this server signs with now: raw Ed25519, lower-case hex. */
    key: string;
    /** Until when (ms) `key` may be trusted. Never more than NODE_KEY_VALIDITY_MS after the document was made. */
    validUntil: number;
    /** Keys it signed with before, none past the document's own validUntil, newest first. */
    previousKeys: PreviousNodeKey[];
    /** By `key`, over {@link nodeKeyDocumentBytes}, base64. */
    sig: string;
}

export type NodeKeyDocumentFields = Omit<NodeKeyDocument, 'v' | 'sig'>;

/** The bytes a key document is signed as: 0xFF, then the tag, the key, its validity and one line per previous key. */
export function nodeKeyDocumentBytes(d: NodeKeyDocumentFields): Uint8Array {
    const previous = d.previousKeys.map((p) => `\n${p.key} ${p.validUntil}`).join('');
    return signedRequestBytes(`${NODE_KEY_TAG}\n${d.key}\n${d.validUntil}${previous}`);
}

function fieldsProblem(d: NodeKeyDocumentFields): string | null {
    if (!KEY_HEX.test(d.key)) return 'the key is not 64 lower-case hex characters';
    if (!Number.isSafeInteger(d.validUntil) || d.validUntil <= 0) return 'validUntil is not a time';
    if (!Array.isArray(d.previousKeys) || d.previousKeys.length > NODE_KEY_PREVIOUS_MAX) return 'too many previous keys';
    const seen = new Set<string>([d.key]);
    for (const p of d.previousKeys) {
        if (!p || !KEY_HEX.test(p.key) || seen.has(p.key)) return 'a previous key is malformed or repeated';
        if (!Number.isSafeInteger(p.validUntil) || p.validUntil <= 0 || p.validUntil > d.validUntil) return 'a previous key outlives the document';
        seen.add(p.key);
    }
    return null;
}

/** A key document signed by its own key. Throws, having signed nothing, when the fields are not a document's. */
export async function signNodeKeyDocument(d: NodeKeyDocumentFields, sign: Signer): Promise<NodeKeyDocument> {
    const problem = fieldsProblem(d);
    if (problem) throw new Error(`Cannot sign a key document: ${problem}`);
    const fields: NodeKeyDocumentFields = { key: d.key, validUntil: d.validUntil, previousKeys: d.previousKeys.map((p) => ({ key: p.key, validUntil: p.validUntil })) };
    const sig = await sign(nodeKeyDocumentBytes(fields));
    return { v: 1, ...fields, sig: toBase64(sig) };
}

/**
 * A key document read back: well formed and signed by the key it names, or null. Exactly the fields above: anything else
 * in it is ignored, never trusted. Says nothing about whether it is still valid (see {@link nodeKeyStanding}).
 */
export function readNodeKeyDocument(json: unknown): NodeKeyDocument | null {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    const o = json as Record<string, unknown>;
    if (o.v !== 1 || typeof o.key !== 'string' || typeof o.validUntil !== 'number' || !Array.isArray(o.previousKeys)) return null;
    const previousKeys: PreviousNodeKey[] = [];
    for (const p of o.previousKeys as unknown[]) {
        if (!p || typeof p !== 'object') return null;
        const { key, validUntil } = p as Record<string, unknown>;
        if (typeof key !== 'string' || typeof validUntil !== 'number') return null;
        previousKeys.push({ key, validUntil });
    }
    const fields: NodeKeyDocumentFields = { key: o.key, validUntil: o.validUntil, previousKeys };
    if (fieldsProblem(fields)) return null;
    const sig = signatureBytesOf(o.sig);
    if (!sig || !verifiesStrictly(sig, nodeKeyDocumentBytes(fields), fields.key)) return null;
    return { v: 1, ...fields, sig: o.sig as string };
}

/**
 * How `keyHex` stands in a server's key document at `now`: its current key while the document is valid, a previous key
 * while that key's own time lasts, `expired` past either, `unknown` when the document doesn't name it.
 */
export type NodeKeyStanding = 'current' | 'previous' | 'expired' | 'unknown';

export function nodeKeyStanding(doc: NodeKeyDocument, keyHex: string, now: number): NodeKeyStanding {
    if (keyHex === doc.key) return now < doc.validUntil ? 'current' : 'expired';
    const previous = doc.previousKeys.find((p) => p.key === keyHex);
    if (!previous) return 'unknown';
    return now < previous.validUntil ? 'previous' : 'expired';
}
