/**
 * A member's signature counts only at the community it was signed for (request binding, format 2).
 *
 * Before this, a signed request was `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY` and nothing else, and each community keeps
 * its own nonces. So for five minutes a request a member sent to community A was just as good at every other community
 * B where the same key is a member, and A's operator sees every request in plain text (TLS ends there). "Delete my
 * account" at A deleted it at B too; "send 20 Beans" was paid twice. Format 2 puts the hostname the app actually
 * connected to inside the signed bytes, and each server accepts only its own names (apps/server engine/own-addresses.ts).
 *
 * The bytes signed, one definition for the phone, the web app, the server and the test helpers:
 *
 *   0xFF ‖ utf8( "beanpool-request/2\n" HOST "\n" METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" BODY )
 *
 * with the header `X-Signed-For: HOST` beside X-Public-Key, X-Signature, X-Timestamp and X-Nonce, or on a `/ws` connect
 * the query params `for=HOST&v=2` beside pubkey, ts, nonce and sig (METHOD `WS`, BODY empty).
 *
 * HOST is {@link audienceOf} the URL fetched: the hostname only (what TLS vouches for), lower case, with no port, no
 * userinfo and no trailing dot. The app takes it from the same string it fetches, so a hostile node can't choose it; a
 * redirect to B keeps A's name in the signature, and B refuses it.
 *
 * Why the leading 0xFF: no UTF-8 text encodes to that byte, and every app ever shipped signs only UTF-8 text. The
 * "Manage" button of builds before this signs whatever text a node sends it, so a hostile node could have it sign a
 * complete request for another community. Nothing an old app can be made to sign starts with 0xFF, so once a server
 * stops accepting the old format (the switch, apps/server engine/member-signature.ts), no old app can be used to
 * forge anything for it.
 *
 * The other signatures a member makes follow the same pattern: a tag line, the host, then the fields. The app builds
 * each of them itself; it never signs text a node sent it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';

/** What `/api/community/info` says (`requestSigning`) on a server that verifies format 2. */
export const REQUEST_SIGNING_VERSION = 2;

/** The first byte of every format-2 signature's bytes. No UTF-8 text contains it. */
export const BOUND_SIGNATURE_MARKER = 0xff;

/** The HTTP header naming the host a request was signed for. */
export const SIGNED_FOR_HEADER = 'X-Signed-For';

export const REQUEST_TAG = 'beanpool-request/2';
export const ADMIN_SIGNIN_TAG = 'beanpool-admin-signin/2';
export const SETTINGS_SIGNIN_TAG = 'beanpool-settings-signin/2';
export const INVITE_TICKET_TAG = 'beanpool-invite-ticket/2';
export const RE_ENROLL_TAG = 'beanpool-re-enroll/2';

// ─── The host ───────────────────────────────────────────────────────────────────────────────

const HOST_NAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const HOST_IPV6_RE = /^\[[0-9a-f:.]+\]$/;

/**
 * The host a request to `url` is signed for: the URL's hostname, lower case, with the scheme, userinfo, port, path,
 * query and any trailing dot dropped. A bare host (`a.example`, `a.example:8443`) is read as one. Null for anything
 * that has no such host, or a scheme other than http(s) or ws(s).
 *
 * A plain string reading rather than `new URL()`, so it gives the same answer under Hermes, in a browser and in Node.
 * It accepts only an ASCII host name or a bracketed IPv6 address: a name in another script would reach the network as
 * its punycode, which this doesn't compute, so it is refused rather than signed for the wrong name.
 */
export function audienceOf(url: string): string | null {
    let s = String(url ?? '').trim();
    if (!s) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    if (scheme) {
        if (!['http', 'https', 'ws', 'wss'].includes(scheme[1].toLowerCase())) return null;
        s = s.slice(scheme[0].length);
    } else if (s.startsWith('//')) {
        s = s.slice(2);
    } else if (/^[a-z][a-z0-9+.-]*:[^0-9]/i.test(s)) {
        return null; // mailto:, data:, javascript: and the like
    }
    const end = s.search(/[/?#\\]/);
    let authority = end === -1 ? s : s.slice(0, end);
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1);
    let host: string;
    if (authority.startsWith('[')) {
        const close = authority.indexOf(']');
        if (close === -1) return null;
        host = authority.slice(0, close + 1);
        const rest = authority.slice(close + 1);
        if (rest && !/^:\d*$/.test(rest)) return null;
    } else {
        const colon = authority.indexOf(':');
        host = colon === -1 ? authority : authority.slice(0, colon);
        if (colon !== -1 && !/^\d*$/.test(authority.slice(colon + 1))) return null;
    }
    host = host.toLowerCase().replace(/\.+$/, '');
    if (!host) return null;
    if (!HOST_NAME_RE.test(host) && !HOST_IPV6_RE.test(host)) return null;
    return host;
}

/** The path a request to `url` signs: the part after the host, up to `?` or `#` (the server's `ctx.path`). */
export function signedPathOf(url: string): string {
    let s = String(url ?? '').trim();
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
    if (scheme) s = s.slice(scheme[0].length);
    else if (s.startsWith('//')) s = s.slice(2);
    else if (s.startsWith('/')) return s.split(/[?#]/)[0];
    const slash = s.search(/[/?#]/);
    if (slash === -1 || s[slash] !== '/') return '/';
    return s.slice(slash).split(/[?#]/)[0];
}

// ─── The bytes ──────────────────────────────────────────────────────────────────────────────

/**
 * UTF-8, as TextEncoder writes it (a lone surrogate becomes U+FFFD), written out so every platform encodes the same
 * way. Never emits a byte above 0xF4, so never {@link BOUND_SIGNATURE_MARKER}.
 */
export function utf8Bytes(text: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
                i++;
            } else {
                c = 0xfffd;
            }
        } else if (c >= 0xd800 && c <= 0xdfff) {
            c = 0xfffd;
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
}

/** The bytes a format-2 text is signed as: 0xFF, then the text in UTF-8. */
export function signedRequestBytes(text: string): Uint8Array {
    const body = utf8Bytes(text);
    const out = new Uint8Array(body.length + 1);
    out[0] = BOUND_SIGNATURE_MARKER;
    out.set(body, 1);
    return out;
}

// ─── Signed requests ────────────────────────────────────────────────────────────────────────

export interface RequestFields {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    body: string;
}

/** The text of a format-2 request. It is what a transfer's `auth_payload` stores; verifiers put the 0xFF back. */
export function signedRequestText(f: RequestFields & { host: string }): string {
    return `${REQUEST_TAG}\n${f.host}\n${f.method}\n${f.path}\n${f.timestamp}\n${f.nonce}\n${f.body}`;
}

/**
 * The text of an old-format request, bound to no community: `METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY`, signed as plain
 * UTF-8. Servers accept it only until the switch. Kept here so verifiers and tests of the old apps state it once.
 */
export function unboundRequestText(f: RequestFields): string {
    return `${f.method}\n${f.path}\n${f.timestamp}\n${f.nonce}\n${f.body}`;
}

export type ParsedSignedText =
    | ({ format: 2; host: string } & RequestFields)
    | ({ format: 1; host: null } & RequestFields);

/** A stored or received request text, either format, read back into its fields. Null when it is neither. */
export function parseSignedText(text: string): ParsedSignedText | null {
    if (typeof text !== 'string') return null;
    const bound = text.startsWith(`${REQUEST_TAG}\n`);
    const lines = text.split('\n');
    const head = bound ? 6 : 4;
    if (lines.length < head + 1) return null;
    const at = bound ? 2 : 0;
    const fields: RequestFields = {
        method: lines[at],
        path: lines[at + 1],
        timestamp: lines[at + 2],
        nonce: lines[at + 3],
        body: lines.slice(head).join('\n'),
    };
    return bound ? { format: 2, host: lines[1], ...fields } : { format: 1, host: null, ...fields };
}

/** The body a signed request text carries, in either format. */
export function bodyOfSignedText(text: string): string {
    return parseSignedText(text)?.body ?? '';
}

/** The timestamp (ms) a signed request text carries, in either format, or NaN. */
export function timestampOfSignedText(text: string): number {
    const parsed = parseSignedText(text);
    return parsed ? Number(parsed.timestamp) : NaN;
}

/**
 * The bytes a stored or received request text was signed as: format 2 with the 0xFF in front, the old format as plain
 * UTF-8.
 */
export function bytesOfSignedText(text: string): Uint8Array {
    return text.startsWith(`${REQUEST_TAG}\n`) ? signedRequestBytes(text) : utf8Bytes(text);
}

// ─── The other signatures a member makes ────────────────────────────────────────────────────

/**
 * Settings sign-in from the app's "Manage" button. The app takes only the 64-hex challenge id from the node and
 * builds this itself; it never signs the node's text.
 */
export function adminSigninText(host: string, challengeId: string): string {
    return `${ADMIN_SIGNIN_TAG}\n${host}\n${challengeId}`;
}

/** Approving (or declining) a browser's "Sign in with your phone" pairing. */
export function settingsSigninText(host: string, action: 'approve' | 'decline', pairingId: string, shortCode: string): string {
    return `${SETTINGS_SIGNIN_TAG}\n${host}\n${action}\n${pairingId}\n${shortCode}`;
}

/** An offline invite ticket's payload. `host` is the inviter's community; the ticket joins only there. */
export function inviteTicketText(host: string, inviter: string, timestamp: number, intendedFor?: string | null): string {
    return `${INVITE_TICKET_TAG}\n${host}\n${inviter}\n${timestamp}\n${intendedFor ?? ''}`;
}

export interface ParsedInviteTicketText {
    host: string;
    inviter: string;
    timestamp: number;
    intendedFor?: string;
}

/** A format-2 ticket payload read back, or null when `text` isn't one. */
export function parseInviteTicketText(text: string): ParsedInviteTicketText | null {
    if (typeof text !== 'string' || !text.startsWith(`${INVITE_TICKET_TAG}\n`)) return null;
    const lines = text.split('\n');
    if (lines.length !== 5) return null;
    const timestamp = Number(lines[3]);
    if (!lines[1] || !lines[2] || !/^\d+$/.test(lines[3]) || !Number.isSafeInteger(timestamp)) return null;
    return { host: lines[1], inviter: lines[2], timestamp, ...(lines[4] ? { intendedFor: lines[4] } : {}) };
}

/** A re-enrolment code's proof of possession of the new key (`/api/member/re-enroll`). */
export function reEnrollText(host: string, code: string): string {
    return `${RE_ENROLL_TAG}\n${host}\n${code}`;
}

// ─── Builders ───────────────────────────────────────────────────────────────────────────────

/** Signs bytes with the member key. Given only to the builders below: the app never signs bytes a node chose. */
export type Signer = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** A {@link Signer} over an Ed25519 private key in either stored form (raw seed or PKCS8, see ed25519-key.ts). */
export function ed25519Signer(privateKey: Uint8Array): Signer {
    const seed = toEd25519Seed(privateKey);
    return (bytes) => ed25519.sign(bytes, seed);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding, as the server's Buffer reads it. */
export function toBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
        out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
        out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
        out += c === undefined ? '=' : B64[c & 63];
    }
    return out;
}

function freshNonce(): string {
    return bytesToHex(randomBytes(16));
}

export interface BoundRequestInput {
    method: string;
    /** The full URL the fetch will use. The host and the path are both taken from it. */
    url: string;
    /** Exactly the body string sent ('' for none). */
    body: string;
    publicKeyHex: string;
    sign: Signer;
    /** Defaults to now. */
    timestamp?: number;
    /** Defaults to 16 random bytes in hex. */
    nonce?: string;
}

/** The signed-request headers for a fetch of `url`, in format 2. Throws when the URL has no host to sign for. */
export async function buildBoundRequestHeaders(input: BoundRequestInput): Promise<Record<string, string>> {
    const host = audienceOf(input.url);
    if (!host) throw new Error(`Cannot sign a request for ${JSON.stringify(input.url)}: it names no host`);
    const timestamp = String(input.timestamp ?? Date.now());
    const nonce = input.nonce ?? freshNonce();
    const text = signedRequestText({
        host, method: input.method.toUpperCase(), path: signedPathOf(input.url), timestamp, nonce, body: input.body,
    });
    const signature = await input.sign(signedRequestBytes(text));
    return {
        'X-Public-Key': input.publicKeyHex,
        'X-Signature': toBase64(signature),
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        [SIGNED_FOR_HEADER]: host,
    };
}

export interface BoundWsInput {
    /** The full `ws://` or `wss://` URL the socket will open (its query, if any, is not signed). */
    wsUrl: string;
    publicKeyHex: string;
    sign: Signer;
    timestamp?: number;
    nonce?: string;
}

/** The `/ws` connect params in format 2, as an `&`-joinable fragment. Throws when the URL has no host. */
export async function buildBoundWsParams(input: BoundWsInput): Promise<string> {
    const host = audienceOf(input.wsUrl);
    if (!host) throw new Error(`Cannot sign a socket for ${JSON.stringify(input.wsUrl)}: it names no host`);
    const timestamp = String(input.timestamp ?? Date.now());
    const nonce = input.nonce ?? freshNonce();
    const text = signedRequestText({ host, method: 'WS', path: signedPathOf(input.wsUrl), timestamp, nonce, body: '' });
    const sig = toBase64(await input.sign(signedRequestBytes(text)));
    return `pubkey=${encodeURIComponent(input.publicKeyHex)}&ts=${timestamp}&nonce=${encodeURIComponent(nonce)}`
        + `&sig=${encodeURIComponent(sig)}&for=${encodeURIComponent(host)}&v=${REQUEST_SIGNING_VERSION}`;
}

/** The Settings sign-in signature for challenge `challengeId` at the node at `nodeUrl` (base64). */
export async function signAdminSignin(nodeUrl: string, challengeId: string, sign: Signer): Promise<string> {
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign in: the node address names no host');
    if (!/^[0-9a-f]{64}$/.test(challengeId)) throw new Error('Cannot sign in: that is not a sign-in challenge id');
    return toBase64(await sign(signedRequestBytes(adminSigninText(host, challengeId))));
}

/** The approval (or decline) of a browser pairing shown by the node at `nodeUrl` (base64). */
export async function signSettingsSignin(
    nodeUrl: string, action: 'approve' | 'decline', pairingId: string, shortCode: string, sign: Signer,
): Promise<string> {
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign in: the node address names no host');
    return toBase64(await sign(signedRequestBytes(settingsSigninText(host, action, pairingId, shortCode))));
}

/** An offline invite ticket for the community at `nodeUrl`, as the `BP-` code carries it (base64 of `{p, s}`). */
export async function buildInviteTicket(
    nodeUrl: string, inviter: string, sign: Signer, opts: { timestamp?: number; intendedFor?: string | null } = {},
): Promise<string> {
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot make a ticket: the node address names no host');
    const p = inviteTicketText(host, inviter, opts.timestamp ?? Date.now(), opts.intendedFor);
    const s = toBase64(await sign(signedRequestBytes(p)));
    return toBase64(utf8Bytes(JSON.stringify({ p, s })));
}

/** The re-enrolment proof of possession for `code` at the node at `nodeUrl`, signed by the NEW key (base64). */
export async function signReEnroll(nodeUrl: string, code: string, sign: Signer): Promise<string> {
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot re-enrol: the node address names no host');
    return toBase64(await sign(signedRequestBytes(reEnrollText(host, code.trim().toUpperCase()))));
}
