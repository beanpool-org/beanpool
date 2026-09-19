/**
 * Unlocking with an owner's phone (sealed-keys.md §5.2, §6.2 step 2, §7; slice 6).
 *
 * A standby taking over, or a fresh server restoring a sealed backup, holds an envelope it cannot open. Any one owner
 * can open it with the member key already on their phone — but the phone must never see the payload (the node key,
 * the admin password hash, the database), and the data key must never be on the wire in the clear. So:
 *
 *   1. The server makes a SESSION: an ephemeral X25519 keypair, in memory only, single use, 10 minutes. It shows a
 *      QR (and the same thing as a link): which server, which session, the session's public key, which envelope,
 *      and the SHA-256 of that envelope's header. {@link buildOwnerUnlockQr} / {@link parseOwnerUnlockQr}.
 *   2. The owner's app fetches the header from that server, checks it hashes to what the QR said, and finds its own
 *      stanza. It shows the community, the server and what will happen; then the phone's own unlock.
 *   3. {@link approveOwnerUnlock}: the app unwraps the data key from ITS stanza only, re-wraps it to the session's
 *      public key, zeroes it, and signs the request with the member key. Only 48 bytes of ciphertext leave the phone.
 *   4. {@link openOwnerUnlockRequest}: the server checks the signer is an owner the header names, the signature, the
 *      session, the envelope, the header hash and the community, and unwraps the data key with the session's secret.
 *      It then opens the envelope itself (`{ type: 'dataKey' }`) — a data key that does not open the body fails
 *      there, so nothing is trusted on the phone's word.
 *
 * {@link OwnerUnlockSessions} is the session store both uses share: it refuses an unknown, expired or used session,
 * and a session that has seen too many bad requests. The silent open check (§7) is {@link canOpenAsOwner}.
 *
 * ## The re-wrap
 *
 * Ephemeral X25519 → ECDH with the session public key → HKDF-SHA256, info `beanpool-seal-unlock-v1` →
 * XChaCha20-Poly1305 over the data key, AAD = `"bpseal-unlock/v1" ‖ purpose ‖ envelopeId ‖ sessionId ‖ signer pubkey`.
 * The AAD ties it to one session, one envelope and one owner: lifted into another session, or relabelled as coming
 * from another owner, it fails its tag. The same shape as keeper-crypto's `rewrapShareToDevice`, with its own label.
 *
 * ## Key formats
 *
 * The owner's key goes through `toEd25519Seed` (`openOwnerStanza`, and `ownerSeed` here): the native raw seed
 * and the PWA's 48-byte PKCS8 both work, hex or bytes.
 */

import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import {
    canonicalJson, openOwnerStanza, sealedHeaderHash, validateSealedHeader, verifySealedHeader, SealedEnvelopeError,
    type OwnerStanza, type SealedEnvelopeHeader, type SealedEnvelopeKind,
} from './sealed-envelope.js';

export const OWNER_UNLOCK_VERSION = 'bpseal-unlock/v1';
/** What the QR says. Not a web link: a phone camera app has nothing to open; only the BeanPool app reads it. */
export const OWNER_UNLOCK_QR_PREFIX = 'beanpool-unlock:v1?';
/** The same payload as a link, for an owner whose standby's Settings is open on the same phone. */
export const OWNER_UNLOCK_LINK_PREFIX = 'beanpool://unlock-keys?';
/** A session lives ten minutes (§5.2). */
export const OWNER_UNLOCK_SESSION_TTL_MS = 10 * 60_000;
/** Bad requests a session takes before it closes: a typo'd retry is fine, a stream of guesses is not. */
export const OWNER_UNLOCK_MAX_BAD_ATTEMPTS = 5;

export type OwnerUnlockPurpose = 'takeover' | 'restore';

const HKDF_INFO_UNLOCK = utf8ToBytes('beanpool-seal-unlock-v1');
const SIGN_DOMAIN = utf8ToBytes(`${OWNER_UNLOCK_VERSION}\n`);
const ID_RE = /^[0-9a-f]{64}$/;
const ENVELOPE_ID_RE = /^[0-9a-f]{32}$/;
const KEY_LEN = 32;
const XNONCE_LEN = 24;
const TAG_LEN = 16;

/**
 * Why an unlock was refused. Callers match on `reason`; the sentence a person reads belongs to the client.
 *
 * - `malformed`       the request is not the shape this version sends
 * - `unknown-session` no such session here (never made, or this server restarted)
 * - `expired`         the ten minutes ran out
 * - `used`            the session already unlocked once
 * - `closed`          too many bad requests; make a new one
 * - `wrong-session`   the request names another session
 * - `wrong-envelope`  the request names another envelope, or the header it hashed is not this one
 * - `wrong-kind`      a take-over envelope offered for a restore, or the other way round
 * - `wrong-community` the envelope is for another community than the one expected
 * - `not-a-recipient` the signer is not one of the owners the envelope is locked to
 * - `bad-signature`   the owner's signature (or the envelope's) does not verify
 * - `did-not-open`    the re-wrapped key did not open with this session's secret
 * - `wrong-signer`    (the phone) a take-over lock not signed by this app's community server
 */
export type OwnerUnlockRefusal =
    | 'malformed' | 'unknown-session' | 'expired' | 'used' | 'closed' | 'wrong-session' | 'wrong-envelope'
    | 'wrong-kind' | 'wrong-community' | 'not-a-recipient' | 'bad-signature' | 'did-not-open' | 'wrong-signer';

export class OwnerUnlockError extends Error {
    constructor(public readonly reason: OwnerUnlockRefusal, message: string) {
        super(message);
        this.name = 'OwnerUnlockError';
    }
}

/** The envelope kind each purpose opens. */
export function envelopeKindFor(purpose: OwnerUnlockPurpose): SealedEnvelopeKind {
    return purpose === 'takeover' ? 'takeover' : 'backup';
}

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function unb64(value: unknown, field: string, len: number): Uint8Array {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new OwnerUnlockError('malformed', `'${field}' is missing or not base64.`);
    }
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (bytes.length !== len) throw new OwnerUnlockError('malformed', `'${field}' must be ${len} bytes.`);
    return bytes;
}

// ── The QR ─────────────────────────────────────────────────────────────────────────────────

export interface OwnerUnlockQr {
    /** The server's origin, e.g. https://standby.example.org (no path, no trailing slash). */
    serverUrl: string;
    sessionId: string;
    /** The session's X25519 public key, 64 hex. */
    sessionPub: string;
    envelopeId: string;
    /** {@link sealedHeaderHash} of the envelope's header. */
    headerHash: string;
    purpose: OwnerUnlockPurpose;
}

/** `https://Node.Example:443/settings/` → `https://node.example`. Null for anything that is not http(s). */
export function unlockServerOrigin(url: string): string | null {
    try {
        const u = new URL(String(url).trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!u.hostname) return null;
        return u.origin.toLowerCase();
    } catch {
        return null;
    }
}

function qrQuery(q: OwnerUnlockQr): string {
    const origin = unlockServerOrigin(q.serverUrl);
    if (!origin) throw new Error('serverUrl must be an http(s) URL');
    for (const [v, re, name] of [
        [q.sessionId, ID_RE, 'sessionId'], [q.sessionPub, ID_RE, 'sessionPub'],
        [q.envelopeId, ENVELOPE_ID_RE, 'envelopeId'], [q.headerHash, ID_RE, 'headerHash'],
    ] as const) {
        if (!re.test(v)) throw new Error(`${name} is not lowercase hex of the right length`);
    }
    if (q.purpose !== 'takeover' && q.purpose !== 'restore') throw new Error('purpose must be takeover or restore');
    return `u=${encodeURIComponent(origin)}&s=${q.sessionId}&k=${q.sessionPub}&e=${q.envelopeId}&h=${q.headerHash}&p=${q.purpose}`;
}

export function buildOwnerUnlockQr(q: OwnerUnlockQr): string {
    return OWNER_UNLOCK_QR_PREFIX + qrQuery(q);
}

export function buildOwnerUnlockLink(q: OwnerUnlockQr): string {
    return OWNER_UNLOCK_LINK_PREFIX + qrQuery(q);
}

export type ParsedOwnerUnlockQr =
    | ({ ok: true } & OwnerUnlockQr)
    /** not-unlock: some other QR or text. malformed: ours, but damaged. */
    | { ok: false; reason: 'not-unlock' | 'malformed' };

/**
 * Read a scanned QR, an opened link, or pasted text (the PWA has no camera scanner): either prefix, surrounding space
 * ignored. Only what the format allows gets through: an http(s) origin and fixed-width lowercase hex.
 */
export function parseOwnerUnlockQr(text: unknown): ParsedOwnerUnlockQr {
    if (typeof text !== 'string') return { ok: false, reason: 'not-unlock' };
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const prefix = [OWNER_UNLOCK_QR_PREFIX, OWNER_UNLOCK_LINK_PREFIX].find((p) => lower.startsWith(p));
    if (!prefix) return { ok: false, reason: 'not-unlock' };
    if (raw.length > 600) return { ok: false, reason: 'malformed' };
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(raw.slice(prefix.length));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const serverUrl = unlockServerOrigin(params.get('u') || '');
    const sessionId = (params.get('s') || '').toLowerCase();
    const sessionPub = (params.get('k') || '').toLowerCase();
    const envelopeId = (params.get('e') || '').toLowerCase();
    const headerHash = (params.get('h') || '').toLowerCase();
    const purpose = params.get('p');
    if (!serverUrl || !ID_RE.test(sessionId) || !ID_RE.test(sessionPub) || !ENVELOPE_ID_RE.test(envelopeId)
        || !ID_RE.test(headerHash) || (purpose !== 'takeover' && purpose !== 'restore')) {
        return { ok: false, reason: 'malformed' };
    }
    return { ok: true, serverUrl, sessionId, sessionPub, envelopeId, headerHash, purpose };
}

// ── PeerId → Ed25519 public key (for the phone's pin) ──────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Uint8Array | null {
    if (!s || s.length > 128) return null;
    const bytes: number[] = []; // little-endian while decoding
    for (const ch of s) {
        const v = B58.indexOf(ch);
        if (v < 0) return null;
        let carry = v;
        for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i] * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    // Each leading '1' is a leading zero byte.
    for (const ch of s) {
        if (ch !== '1') break;
        bytes.push(0);
    }
    return new Uint8Array(bytes.reverse());
}

/** The Ed25519 public key a libp2p PeerId (`12D3KooW…`, an identity multihash of the key) embeds, or null. */
export function ed25519KeyOfPeerId(peerId: string): Uint8Array | null {
    const raw = base58Decode(peerId);
    // identity multihash (0x00), length 36 (0x24), protobuf { Type: Ed25519 (0x08 0x01), Data: 32 bytes (0x12 0x20) }
    if (!raw || raw.length !== 38) return null;
    if (raw[0] !== 0x00 || raw[1] !== 0x24 || raw[2] !== 0x08 || raw[3] !== 0x01 || raw[4] !== 0x12 || raw[5] !== 0x20) return null;
    return raw.slice(6);
}

// ── The request the phone sends ────────────────────────────────────────────────────────────

export interface OwnerUnlockRequest {
    v: typeof OWNER_UNLOCK_VERSION;
    purpose: OwnerUnlockPurpose;
    sessionId: string;
    envelopeId: string;
    headerHash: string;
    communityId: string;
    /** The owner's Ed25519 member key, lowercase hex. The actor is this key and nothing else. */
    signer: string;
    rewrap: { eph: string; nonce: string; wrappedDek: string };
    /** Ed25519 by `signer` over `"bpseal-unlock/v1\n" ‖ canonicalJson(request minus sig)`, base64. */
    sig: string;
}

function signedBytes(req: Omit<OwnerUnlockRequest, 'sig'> | OwnerUnlockRequest): Uint8Array {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sig: _sig, ...rest } = req as OwnerUnlockRequest;
    return concatBytes(SIGN_DOMAIN, utf8ToBytes(canonicalJson(rest)));
}

function rewrapAad(purpose: OwnerUnlockPurpose, envelopeId: string, sessionId: string, signer: Uint8Array): Uint8Array {
    return concatBytes(utf8ToBytes(OWNER_UNLOCK_VERSION), utf8ToBytes(purpose), hexToBytes(envelopeId), hexToBytes(sessionId), signer);
}

function agree(secret: Uint8Array, pub: Uint8Array, what: string): Uint8Array {
    try {
        return hkdf(sha256, x25519.getSharedSecret(secret, pub), undefined, HKDF_INFO_UNLOCK, KEY_LEN);
    } catch (e) {
        // @noble refuses the all-zero shared secret, which is what a small-order session key gives.
        throw new OwnerUnlockError('malformed', `${what} could not be agreed: ${(e as Error).message}`);
    }
}

/** Where the phone stands against the header before it offers to unlock. */
export interface OwnerUnlockCheck {
    header: SealedEnvelopeHeader;
    /** This owner's stanza. */
    stanza: OwnerStanza;
    /**
     * `pinned`: signed by the community server this phone knows. `unpinned`: the phone knows no server key yet, and
     * the header is signed by the key it names. `other`: signed by a key this phone does not know as its community's
     * (a restore of a file some other machine locked; a take-over refuses it).
     */
    signer: 'pinned' | 'unpinned' | 'other';
}

/**
 * The phone's checks on the header a server sent, before the owner is asked anything. Throws {@link OwnerUnlockError}.
 *
 * @param expected.communityId the community this app belongs to, when it knows it (the silent open check learns it
 *                             from its own server). An envelope for another community is refused.
 * @param expected.nodePeerId  the PeerId of this app's community server, when known: the pin. A take-over envelope
 *                             signed by anyone else is refused (966 follow-up #2).
 */
export function checkUnlockHeader(
    qr: OwnerUnlockQr, headerValue: unknown, ownerPublicKeyHex: string,
    expected: { communityId?: string | null; nodePeerId?: string | null } = {},
): OwnerUnlockCheck {
    let header: SealedEnvelopeHeader;
    try {
        header = validateSealedHeader(headerValue);
    } catch (e) {
        throw new OwnerUnlockError('malformed', `The server sent a header that is not readable: ${(e as Error).message}`);
    }
    if (header.envelopeId !== qr.envelopeId || sealedHeaderHash(header) !== qr.headerHash) {
        throw new OwnerUnlockError('wrong-envelope', 'The server sent a different lock from the one its screen shows.');
    }
    if (header.kind !== envelopeKindFor(qr.purpose)) {
        throw new OwnerUnlockError('wrong-kind', `This is a '${header.kind}' lock, not the one a ${qr.purpose} opens.`);
    }
    if (expected.communityId && header.communityId !== expected.communityId) {
        throw new OwnerUnlockError('wrong-community', 'This lock belongs to another community, not the one this app is in.');
    }
    const ownKey = ed25519KeyOfPeerId(header.nodePeerId);
    if (!ownKey || !verifySealedHeader(header, ownKey)) {
        throw new OwnerUnlockError('bad-signature', 'This lock has been altered: its signature does not match the server it names.');
    }
    let signer: OwnerUnlockCheck['signer'] = 'unpinned';
    if (expected.nodePeerId) {
        signer = header.nodePeerId === expected.nodePeerId ? 'pinned' : 'other';
        if (signer === 'other' && qr.purpose === 'takeover') {
            throw new OwnerUnlockError('wrong-signer', "This lock was not made by your community's server.");
        }
    }
    const me = ownerPublicKeyHex.trim().toLowerCase();
    const stanza = header.recipients.find((r): r is OwnerStanza => r.type === 'owner' && r.pubkey === me);
    if (!stanza) throw new OwnerUnlockError('not-a-recipient', 'This lock is not locked to you, so this phone cannot open it.');
    return { header, stanza, signer };
}

function ownerSeed(privateKey: string | Uint8Array): Uint8Array {
    const bytes = typeof privateKey === 'string' ? hexToBytes(privateKey.trim().toLowerCase()) : privateKey;
    try {
        return toEd25519Seed(bytes);
    } catch (e) {
        throw new SealedEnvelopeError(`privateKey: ${(e as Error).message}`);
    }
}

/**
 * The phone's step (§5.2 step 5), after the owner said yes and passed the phone's unlock: unwrap the data key from
 * this owner's stanza, re-wrap it to the session, zero it, sign. The header must already have passed
 * {@link checkUnlockHeader}. Returns the request body to POST; it holds no secret but the re-wrapped key.
 */
export function approveOwnerUnlock(qr: OwnerUnlockQr, header: SealedEnvelopeHeader, privateKey: string | Uint8Array): OwnerUnlockRequest {
    const seed = ownerSeed(privateKey);
    const signerPub = ed25519.getPublicKey(seed);
    const dek = openOwnerStanza(header, seed);
    let rewrap: OwnerUnlockRequest['rewrap'];
    try {
        const ephSecret = randomBytes(KEY_LEN);
        const key = agree(ephSecret, hexToBytes(qr.sessionPub), "The session's key");
        const nonce = randomBytes(XNONCE_LEN);
        const wrapped = xchacha20poly1305(key, nonce, rewrapAad(qr.purpose, header.envelopeId, qr.sessionId, signerPub)).encrypt(dek);
        rewrap = { eph: b64(x25519.getPublicKey(ephSecret)), nonce: b64(nonce), wrappedDek: b64(wrapped) };
        ephSecret.fill(0);
        key.fill(0);
    } finally {
        dek.fill(0);
    }
    const unsigned: Omit<OwnerUnlockRequest, 'sig'> = {
        v: OWNER_UNLOCK_VERSION,
        purpose: qr.purpose,
        sessionId: qr.sessionId,
        envelopeId: header.envelopeId,
        headerHash: sealedHeaderHash(header),
        communityId: header.communityId,
        signer: bytesToHex(signerPub),
        rewrap,
    };
    return { ...unsigned, sig: b64(ed25519.sign(signedBytes(unsigned), seed)) };
}

/**
 * The silent per-envelope open check (§7): can this key open its stanza in this header? The data key is unwrapped and
 * zeroed at once; nothing else is touched. False for "not a recipient" as well as for a stanza that does not open —
 * the caller tells the two apart from the header if it needs to.
 */
export function canOpenAsOwner(header: SealedEnvelopeHeader, privateKey: string | Uint8Array): boolean {
    try {
        const dek = openOwnerStanza(header, privateKey);
        const ok = dek.length === KEY_LEN;
        dek.fill(0);
        return ok;
    } catch {
        return false;
    }
}

// ── The server's side ──────────────────────────────────────────────────────────────────────

export interface OwnerUnlockSessionKeys {
    sessionId: string;
    /** X25519 secret. Memory only. */
    sessionSecret: Uint8Array;
    sessionPub: string;
}

export function createOwnerUnlockSessionKeys(): OwnerUnlockSessionKeys {
    const sessionSecret = randomBytes(KEY_LEN);
    return {
        sessionId: bytesToHex(randomBytes(32)),
        sessionSecret,
        sessionPub: bytesToHex(x25519.getPublicKey(sessionSecret)),
    };
}

/** Is it shaped like a request at all? Throws `malformed`. */
function requireRequestShape(value: unknown): OwnerUnlockRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnerUnlockError('malformed', 'The request is not an object.');
    const r = value as Record<string, unknown>;
    const allowed = new Set(['v', 'purpose', 'sessionId', 'envelopeId', 'headerHash', 'communityId', 'signer', 'rewrap', 'sig']);
    if (Object.keys(r).some((k) => !allowed.has(k))) throw new OwnerUnlockError('malformed', 'The request has fields this version does not send.');
    if (r.v !== OWNER_UNLOCK_VERSION) throw new OwnerUnlockError('malformed', `This is not a ${OWNER_UNLOCK_VERSION} request.`);
    if (r.purpose !== 'takeover' && r.purpose !== 'restore') throw new OwnerUnlockError('malformed', 'Unknown purpose.');
    if (typeof r.sessionId !== 'string' || !ID_RE.test(r.sessionId)) throw new OwnerUnlockError('malformed', 'sessionId is not 64 hex.');
    if (typeof r.envelopeId !== 'string' || !ENVELOPE_ID_RE.test(r.envelopeId)) throw new OwnerUnlockError('malformed', 'envelopeId is not 32 hex.');
    if (typeof r.headerHash !== 'string' || !ID_RE.test(r.headerHash)) throw new OwnerUnlockError('malformed', 'headerHash is not 64 hex.');
    if (typeof r.communityId !== 'string' || !r.communityId || r.communityId.length > 128) throw new OwnerUnlockError('malformed', 'communityId is missing.');
    if (typeof r.signer !== 'string' || !ID_RE.test(r.signer)) throw new OwnerUnlockError('malformed', 'signer is not an Ed25519 key.');
    const w = r.rewrap as Record<string, unknown> | undefined;
    if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).length !== 3) throw new OwnerUnlockError('malformed', 'rewrap is missing.');
    unb64(w.eph, 'rewrap.eph', KEY_LEN);
    unb64(w.nonce, 'rewrap.nonce', XNONCE_LEN);
    unb64(w.wrappedDek, 'rewrap.wrappedDek', KEY_LEN + TAG_LEN);
    unb64(r.sig, 'sig', 64);
    return r as unknown as OwnerUnlockRequest;
}

export interface OpenedOwnerUnlock {
    /** The envelope's data key. The caller opens the envelope with `{ type: 'dataKey' }` and zeroes this. */
    dataKey: Uint8Array;
    signer: string;
    callsign: string;
}

/**
 * The server's step (§5.2 step 6). Refuses, in this order: a malformed request, another session, another envelope
 * or header, a purpose that does not match, another community (than the header's, and than `expectedCommunityId`
 * when the server has one), a signer the header does not list as an owner, a bad signature, a re-wrap that does not
 * open. Session life (expired, used) is {@link OwnerUnlockSessions}' job; this checks one request against one session.
 */
export function openOwnerUnlockRequest(opts: {
    request: unknown;
    header: SealedEnvelopeHeader;
    purpose: OwnerUnlockPurpose;
    keys: OwnerUnlockSessionKeys;
    expectedCommunityId?: string | null;
}): OpenedOwnerUnlock {
    const req = requireRequestShape(opts.request);
    const { header } = opts;
    if (req.sessionId !== opts.keys.sessionId) throw new OwnerUnlockError('wrong-session', 'This request is for another session.');
    if (req.purpose !== opts.purpose) throw new OwnerUnlockError('wrong-kind', `This session is for a ${opts.purpose}, not a ${req.purpose}.`);
    if (header.kind !== envelopeKindFor(opts.purpose)) throw new OwnerUnlockError('wrong-kind', `A ${opts.purpose} cannot open a '${header.kind}' envelope.`);
    if (req.envelopeId !== header.envelopeId || req.headerHash !== sealedHeaderHash(header)) {
        throw new OwnerUnlockError('wrong-envelope', 'This request is for another envelope than the session holds.');
    }
    if (req.communityId !== header.communityId || (opts.expectedCommunityId && header.communityId !== opts.expectedCommunityId)) {
        throw new OwnerUnlockError('wrong-community', 'This envelope is for another community.');
    }
    const stanza = header.recipients.find((r): r is OwnerStanza => r.type === 'owner' && r.pubkey === req.signer);
    if (!stanza) throw new OwnerUnlockError('not-a-recipient', 'The signer is not one of the owners this envelope is locked to.');
    const signerPub = hexToBytes(req.signer);
    let sigOk: boolean;
    try {
        sigOk = ed25519.verify(unb64(req.sig, 'sig', 64), signedBytes(req), signerPub, { zip215: false });
    } catch {
        sigOk = false;
    }
    if (!sigOk) throw new OwnerUnlockError('bad-signature', "The owner's signature does not verify.");
    const key = agree(opts.keys.sessionSecret, unb64(req.rewrap.eph, 'rewrap.eph', KEY_LEN), 'The re-wrapped key');
    let dataKey: Uint8Array;
    try {
        dataKey = xchacha20poly1305(key, unb64(req.rewrap.nonce, 'rewrap.nonce', XNONCE_LEN), rewrapAad(req.purpose, req.envelopeId, req.sessionId, signerPub))
            .decrypt(unb64(req.rewrap.wrappedDek, 'rewrap.wrappedDek', KEY_LEN + TAG_LEN));
    } catch {
        throw new OwnerUnlockError('did-not-open', 'The re-wrapped key did not open with this session.');
    } finally {
        key.fill(0);
    }
    return { dataKey, signer: req.signer, callsign: stanza.callsign };
}

/** One session and what the server keeps with it. */
export interface OwnerUnlockSession<T> {
    keys: OwnerUnlockSessionKeys;
    purpose: OwnerUnlockPurpose;
    header: SealedEnvelopeHeader;
    createdAt: number;
    expiresAt: number;
    /** `closed`: too many bad requests, or the server closed it. `expired`: its ten minutes ran out. */
    state: 'waiting' | 'unlocked' | 'expired' | 'closed';
    badAttempts: number;
    data: T;
}

/**
 * The sessions a server has open, in memory only. One server opens few, so at most `max` are kept (the oldest goes).
 * `redeem` is the only way to a data key, and it works once per session.
 */
export class OwnerUnlockSessions<T> {
    private sessions = new Map<string, OwnerUnlockSession<T>>();
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly max: number;

    constructor(opts: { ttlMs?: number; now?: () => number; max?: number } = {}) {
        this.ttlMs = opts.ttlMs ?? OWNER_UNLOCK_SESSION_TTL_MS;
        this.now = opts.now ?? (() => Date.now());
        this.max = opts.max ?? 4;
    }

    create(purpose: OwnerUnlockPurpose, header: SealedEnvelopeHeader, data: T): OwnerUnlockSession<T> {
        if (header.kind !== envelopeKindFor(purpose)) {
            throw new OwnerUnlockError('wrong-kind', `A ${purpose} cannot open a '${header.kind}' envelope.`);
        }
        if (!header.recipients.some((r) => r.type === 'owner')) {
            throw new OwnerUnlockError('not-a-recipient', 'This envelope is not locked to any owner, so no phone can open it.');
        }
        const now = this.now();
        const s: OwnerUnlockSession<T> = {
            keys: createOwnerUnlockSessionKeys(), purpose, header, createdAt: now, expiresAt: now + this.ttlMs,
            state: 'waiting', badAttempts: 0, data,
        };
        this.sessions.set(s.keys.sessionId, s);
        while (this.sessions.size > this.max) {
            const oldest = this.sessions.keys().next().value as string;
            this.forget(oldest);
        }
        return s;
    }

    /** The QR for a session, pointing at `serverUrl`. */
    qrFor(s: OwnerUnlockSession<T>, serverUrl: string): OwnerUnlockQr {
        return {
            serverUrl, sessionId: s.keys.sessionId, sessionPub: s.keys.sessionPub, envelopeId: s.header.envelopeId,
            headerHash: sealedHeaderHash(s.header), purpose: s.purpose,
        };
    }

    /** A session a phone may still unlock, or the reason it may not. Never returns a used or expired one as live. */
    lookup(sessionId: unknown): { ok: true; session: OwnerUnlockSession<T> } | { ok: false; reason: 'unknown-session' | 'expired' | 'used' | 'closed' } {
        if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return { ok: false, reason: 'unknown-session' };
        const s = this.sessions.get(sessionId);
        if (!s) return { ok: false, reason: 'unknown-session' };
        if (s.state === 'unlocked') return { ok: false, reason: 'used' };
        if (s.state === 'waiting' && this.now() > s.expiresAt) this.close(s, 'expired');
        if (s.state === 'expired') return { ok: false, reason: 'expired' };
        if (s.state === 'closed') return { ok: false, reason: 'closed' };
        return { ok: true, session: s };
    }

    /** The session whatever its state — for the screen that made it, following it. Undefined once forgotten. */
    peek(sessionId: unknown): OwnerUnlockSession<T> | undefined {
        if (typeof sessionId !== 'string') return undefined;
        const s = this.sessions.get(sessionId);
        if (s && s.state === 'waiting' && this.now() > s.expiresAt) this.close(s, 'expired');
        return s;
    }

    /**
     * Check one request against its session and unwrap the data key. On success the session is spent: a second
     * request, even the same one, gets `used`. A bad request counts; after {@link OWNER_UNLOCK_MAX_BAD_ATTEMPTS} the
     * session closes. Throws {@link OwnerUnlockError}.
     */
    redeem(sessionId: unknown, request: unknown, expectedCommunityId?: string | null): { session: OwnerUnlockSession<T> } & OpenedOwnerUnlock {
        const found = this.lookup(sessionId);
        if (!found.ok) {
            const words: Record<typeof found.reason, string> = {
                'unknown-session': 'There is no such unlock session on this server.',
                expired: 'This unlock session ran out (10 minutes). Start again on the server.',
                used: 'This unlock session has already been used.',
                closed: 'This unlock session was closed after too many bad requests. Start again on the server.',
            };
            throw new OwnerUnlockError(found.reason, words[found.reason]);
        }
        const s = found.session;
        try {
            const opened = openOwnerUnlockRequest({ request, header: s.header, purpose: s.purpose, keys: s.keys, expectedCommunityId });
            s.state = 'unlocked';
            s.keys.sessionSecret.fill(0);
            return { session: s, ...opened };
        } catch (e) {
            s.badAttempts++;
            if (s.badAttempts >= OWNER_UNLOCK_MAX_BAD_ATTEMPTS) this.close(s);
            throw e;
        }
    }

    close(s: OwnerUnlockSession<T>, as: 'closed' | 'expired' = 'closed'): void {
        if (s.state === 'waiting') s.state = as;
        s.keys.sessionSecret.fill(0);
    }

    forget(sessionId: string): void {
        const s = this.sessions.get(sessionId);
        if (s) this.close(s);
        this.sessions.delete(sessionId);
    }

    clear(): void {
        for (const id of [...this.sessions.keys()]) this.forget(id);
    }
}

// ── The silent open check (§7) ─────────────────────────────────────────────────────────────

/** Signed GET on the main server: the current take-over header, for an owner (routes/takeover-envelope.ts). */
export const TAKEOVER_HEADER_PATH = '/api/node/takeover-envelope/header';
/** Signed POST on the main server: `{ envelopeId, opened }` — this owner's device could (not) open that lock. */
export const OWNER_LOCK_OPEN_CHECK_PATH = '/api/node/owner/lock-open-check';
