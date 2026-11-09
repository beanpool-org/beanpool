/**
 * Web push with this node's own key (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, slice W1). No account,
 * fee, token or address of ours: the node makes its own key pair, a browser subscribes to it, and the node posts straight
 * to that browser's own push service with the payload encrypted end to end, so the push service reads nothing.
 *
 * ## The key: data/vapid.key
 *
 * A P-256 private key, PKCS#8 PEM, 0600, made by a main server at first need ({@link ensureVapidKey}): the first
 * `GET /api/web-push/key` or subscription. Never in the database: it travels only in the take-over bundle
 * (services/takeover-envelope.ts BUNDLED_FILES), so a take-over and a sealed backup carry it. A browser's subscription is
 * bound to the public key it subscribed with, so a server that lost the key would be refused (403) by every push service;
 * a restore without the bundle starts over, and each browser subscribes again at its next tap.
 *
 * ## The payload: RFC 8291 `aes128gcm`
 *
 * {@link encryptPushPayload}: a new P-256 key pair and 16-byte salt per message, ECDH with the browser's `p256dh`, HKDF-SHA256
 * with its `auth` secret into the RFC 8188 content key and nonce, one record of AES-128-GCM (record size 4096, the last
 * record's delimiter 0x02). Node's own crypto does every step: no web-push package handles the key or the endpoint. Tested
 * against RFC 8291 §5's example (test-web-push.ts).
 *
 * ## The request: RFC 8292 VAPID
 *
 * `Authorization: vapid t=<ES256 JWT: aud = the endpoint's origin, exp 12 hours on, sub = this node's own https address>,
 * k=<the public key>`, with `TTL`, `Urgency` and, where given, `Topic`. At most {@link WEB_PUSH_RULES}.inFlight requests at
 * once, a queue behind them: there is no batch call, so an announcement to 5,000 browsers is 5,000 requests.
 *
 * ## Where it may post
 *
 * Only to the push services the browsers use ({@link isPushServiceEndpoint}): Google's (Chrome, Edge on Android, Samsung
 * Internet, Brave, Opera), Mozilla's (Firefox), Apple's (Safari) and Microsoft's (Edge on a computer), over https on
 * port 443. A subscription names its endpoint, and an asker's comes from someone who is not yet a member: anything else
 * would let them have this server post to an address of their choosing.
 *
 * ## What the push service answers
 *
 * 2xx sent; 404 or 410 `gone` (the browser unsubscribed: the caller removes the row, as Expo's `DeviceNotRegistered`); 403
 * `refused`, logged once per server (the key does not match the subscription's); anything else `dropped` (429, 5xx, a
 * network failure: nothing is tried again, and the waiting page's own check, or the bell, still has it).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createKeyFileOnce } from './key-files.js';

export const VAPID_KEY_FILE = 'vapid.key';

export const WEB_PUSH_RULES = {
    /** Requests to push services at once; the rest wait their turn. */
    inFlight: 8,
    /** A request that has not been answered by then is given up (`dropped`). */
    timeoutMs: 15_000,
    /** The longest TTL any push service keeps a message (Google's 28 days); a longer one is cut to it. */
    maxTtlSeconds: 28 * 24 * 60 * 60,
    /** The plaintext of one message, in bytes: one 4096-byte record, under every service's 4 KB body. */
    maxPayloadBytes: 3000,
    /** How long the VAPID token stands (RFC 8292 allows 24 hours at most). */
    tokenSeconds: 12 * 60 * 60,
} as const;

const RECORD_SIZE = 4096;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export function vapidKeyPath(): string {
    return path.join(dataDir(), VAPID_KEY_FILE);
}

export interface VapidKey {
    privateKey: crypto.KeyObject;
    /** The raw public key: 65 bytes, uncompressed (0x04 ‖ x ‖ y). */
    publicKey: Buffer;
    /** The same, base64url: the browser's `applicationServerKey` and the `k=` of the header. */
    publicKeyText: string;
}

let cached: { pem: string; key: VapidKey } | null = null;

/** The node's key as the file holds it now; null when there is none. Throws when the file is not a P-256 key. Never makes one. */
export function readVapidKey(): VapidKey | null {
    let pem: string;
    try {
        pem = fs.readFileSync(vapidKeyPath(), 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`data/${VAPID_KEY_FILE} could not be read.`);
    }
    if (cached?.pem === pem) return cached.key;
    let privateKey: crypto.KeyObject;
    try {
        privateKey = crypto.createPrivateKey(pem);
    } catch {
        throw new Error(`data/${VAPID_KEY_FILE} is not a key.`);
    }
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error(`data/${VAPID_KEY_FILE} is not a P-256 key.`);
    }
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const key = { privateKey, publicKey, publicKeyText: publicKey.toString('base64url') };
    cached = { pem, key };
    return key;
}

/**
 * The node's key, made now if it has none (a main server only: the caller decides). Written to a temporary file and linked
 * into place (services/key-files.ts), so a crash leaves no half a key and a key already there is never written over.
 */
export function ensureVapidKey(): VapidKey {
    const existing = readVapidKey();
    if (existing) return existing;
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    createKeyFileOnce(vapidKeyPath(), Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, 'utf8'));
    const made = readVapidKey();
    if (!made) throw new Error(`data/${VAPID_KEY_FILE} could not be made.`);
    return made;
}

// ── The payload (RFC 8291) ──────────────────────────────────────────────────────────────────────────────────────────

/** A browser's keys from its subscription, as bytes: `p256dh` (65, uncompressed P-256) and `auth` (16). */
export interface BrowserKeys { p256dh: Buffer; auth: Buffer }

/** Whether these are a browser's keys in the shape RFC 8291 takes. */
export function isBrowserKeys(keys: BrowserKeys): boolean {
    return keys.p256dh.length === 65 && keys.p256dh[0] === 4 && keys.auth.length === 16;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer =>
    Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/**
 * The body of a push message, encrypted to the browser (RFC 8291 §3, RFC 8188 §2): salt ‖ record size ‖ key id length ‖
 * this message's public key ‖ one AES-128-GCM record. `fixed` is for RFC 8291 §5's example only: a real message makes its
 * own key pair and salt.
 */
export function encryptPushPayload(plaintext: Buffer, keys: BrowserKeys, fixed?: { senderPrivate: Buffer; salt: Buffer }): Buffer {
    if (!isBrowserKeys(keys)) throw new Error('not a browser push subscription key');
    if (plaintext.length > RECORD_SIZE - 17) throw new Error('a push message holds at most one record');
    const ecdh = crypto.createECDH('prime256v1');
    if (fixed) ecdh.setPrivateKey(fixed.senderPrivate);
    else ecdh.generateKeys();
    const senderPublic = ecdh.getPublicKey();
    const salt = fixed?.salt ?? crypto.randomBytes(16);
    const ecdhSecret = ecdh.computeSecret(keys.p256dh);
    const ikm = hkdf(ecdhSecret, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), keys.p256dh, senderPublic]), 32);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header[20] = senderPublic.length;
    return Buffer.concat([header, senderPublic, record]);
}

// ── The request (RFC 8292) ──────────────────────────────────────────────────────────────────────────────────────────

/** The push services browsers use, by host: an endpoint anywhere else is refused (header, "Where it may post"). */
const PUSH_SERVICE_HOSTS: readonly RegExp[] = [
    /^fcm\.googleapis\.com$/,
    /^android\.googleapis\.com$/,
    /^updates\.push\.services\.mozilla\.com$/,
    /^web\.push\.apple\.com$/,
    /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** Whether a subscription's endpoint is a browser push service's: https, port 443, no credentials, a known host. */
export function isPushServiceEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
    return PUSH_SERVICE_HOSTS.some((h) => h.test(url.hostname));
}

/** The `Authorization` header for a push to `endpoint`, signed by this node's key. `contact`: this node's https address. */
export function vapidAuthorization(endpoint: string, contact: string, key: VapidKey, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const part = (v: object) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const signing = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: nowSeconds + WEB_PUSH_RULES.tokenSeconds, sub: contact })}`;
    const signature = crypto.sign('sha256', Buffer.from(signing, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${signing}.${signature.toString('base64url')}, k=${key.publicKeyText}`;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface WebPushTarget extends BrowserKeys {
    endpoint: string;
    /** This node's https address as the browser reached it: the token's `sub`. */
    contact: string;
}

export interface WebPushMessage {
    payload: Record<string, unknown>;
    ttlSeconds: number;
    urgency: PushUrgency;
    /** Replaces an undelivered message with the same topic (at most 32 base64url characters). */
    topic?: string;
}

export type WebPushOutcome = 'sent' | 'gone' | 'refused' | 'dropped';

let inFlight = 0;
const waiting: (() => void)[] = [];

/** At most WEB_PUSH_RULES.inFlight at once: a finished send hands its place straight to the next in line, so none jumps it. */
async function inTurn<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight < WEB_PUSH_RULES.inFlight) inFlight++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
        return await fn();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else inFlight--;
    }
}

/** Sends being made now, and waiting their turn: for the suite. */
export function _webPushQueueForTests(): { inFlight: number; waiting: number } {
    return { inFlight, waiting: waiting.length };
}

let warnedRefused = false;

/** The fetch the sends use: a suite's fake push service in place of the real ones. */
let pushFetch: typeof fetch = (input, init) => fetch(input, init);

export function _setWebPushFetchForTests(f: typeof fetch | null): void {
    pushFetch = f ?? ((input, init) => fetch(input, init));
    warnedRefused = false;
}

/** The TTL a push service is given: whole seconds, at least 0, at most {@link WEB_PUSH_RULES}.maxTtlSeconds. */
export function pushTtl(seconds: number): number {
    return Math.max(0, Math.min(WEB_PUSH_RULES.maxTtlSeconds, Math.floor(Number.isFinite(seconds) ? seconds : 0)));
}

/** One message to one browser, in its turn. Never throws; never logs an endpoint or a key. */
export async function sendWebPush(target: WebPushTarget, message: WebPushMessage, key: VapidKey): Promise<WebPushOutcome> {
    if (!isPushServiceEndpoint(target.endpoint) || !isBrowserKeys(target)) return 'dropped';
    const plaintext = Buffer.from(JSON.stringify(message.payload), 'utf8');
    if (plaintext.length > WEB_PUSH_RULES.maxPayloadBytes) return 'dropped';
    return inTurn(async () => {
        try {
            const headers: Record<string, string> = {
                Authorization: vapidAuthorization(target.endpoint, target.contact, key),
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                TTL: String(pushTtl(message.ttlSeconds)),
                Urgency: message.urgency,
            };
            if (message.topic && /^[A-Za-z0-9_-]{1,32}$/.test(message.topic)) headers.Topic = message.topic;
            const res = await pushFetch(target.endpoint, {
                method: 'POST', headers, body: new Uint8Array(encryptPushPayload(plaintext, target)), redirect: 'error',
                signal: AbortSignal.timeout(WEB_PUSH_RULES.timeoutMs),
            });
            if (res.status >= 200 && res.status < 300) return 'sent';
            if (res.status === 404 || res.status === 410) return 'gone';
            if (res.status === 403) {
                if (!warnedRefused) {
                    warnedRefused = true;
                    console.warn(`[WebPush] A push service refused this server's key (403): data/${VAPID_KEY_FILE} is not the key those browsers subscribed with. Said once.`);
                }
                return 'refused';
            }
            return 'dropped';
        } catch {
            return 'dropped';
        }
    });
}
