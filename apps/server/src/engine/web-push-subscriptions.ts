/**
 * The browsers that take this server's web pushes (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, slice W1).
 * The push itself, its encryption and the node's key are services/web-push.ts; the routes are routes/web-push.ts.
 *
 * ## Who has a row
 *
 * W1 keeps one kind, `asker`: a key with an open request to join here that tapped "Tell me when they answer" on the waiting
 * page. One row per key (a second browser replaces the first). No reference to `members`: the key is no member yet. The row
 * goes when the request is cancelled or declined (engine/knocks.ts cancelKnock, declineKnock) and when it lapses (tidyKnocks,
 * every minute); it stays once the request is approved (the yes is what it waits for) and when the key joins (the same key,
 * now a member). What it is sent: `join.answered`, and nothing else (`webPushTargetsFor`).
 *
 * The bound: a row needs an open request, and requests have the knock rules' ceilings (30 a day on the node, 50 open made in
 * three days, one per key), so the table holds at most a few hundred rows of about 400 bytes.
 *
 * ## Locked at rest
 *
 * The endpoint, the browser's `p256dh` and `auth` and the node's https address as the browser reached it (the push's
 * `sub`) are the full right to put words on that browser, with the node's key. As push tokens are (services/push-token-
 * seal.ts), they are never in the database in the clear: `sub_id` is HMAC-SHA256 of the endpoint and `sub_box` the four
 * sealed with XChaCha20-Poly1305 (a random nonce, bound to the key and the id), both keys from data/recovery-seal.key with
 * info `beanpool-web-push/v1`. A copy of the database alone opens none. This server's own (replication-manifest.ts,
 * `local`): after a take-over the asker loses only the buzz, never the yes, which the waiting page reads every 5 minutes and
 * the 30-day invite keeps.
 */
import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { isLang, type Lang, type PushNoticeKind } from '@beanpool/core';
import { db } from '../db/db.js';
import { recoverySealSubkey, RecoverySealKeyMissing, RECOVERY_SEAL_KEY_FILE } from '../services/recovery-seal-key.js';
import {
    isBrowserKeys, isPushServiceEndpoint, pushTtl, readVapidKey, sendWebPush, type PushUrgency, type WebPushTarget,
} from '../services/web-push.js';

const INFO = 'beanpool-web-push/v1';
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

interface Keys { box: Uint8Array; id: Uint8Array }

function requireKeys(): Keys {
    const k = recoverySealSubkey(INFO, 64);
    if (!k) throw new RecoverySealKeyMissing(`This server cannot lock browser subscriptions: data/${RECOVERY_SEAL_KEY_FILE} is missing.`);
    return { box: k.subarray(0, 32), id: k.subarray(32) };
}

const idUnder = (keys: Keys, endpoint: string) => crypto.createHmac('sha256', keys.id).update(endpoint, 'utf8').digest('hex');
const aad = (publicKey: string, subId: string) => Buffer.from(JSON.stringify([INFO, publicKey, subId]), 'utf8');

/** A browser's subscription as it sends it (PushSubscription.toJSON()): the endpoint and its two keys, base64url. */
export interface BrowserSubscription { endpoint: string; p256dh: string; auth: string }

/** What is sealed in a row: the subscription and the node's address the browser reached (the push's `sub`). */
interface Sealed extends BrowserSubscription { contact: string }

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** The subscription in a request body, or null when it is not one a browser push service would give. */
export function parseBrowserSubscription(raw: unknown): BrowserSubscription | null {
    const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    if (!s || typeof s !== 'object' || !isPushServiceEndpoint(s.endpoint)) return null;
    const { p256dh, auth } = s.keys ?? {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 50 || !B64URL.test(p256dh) || !B64URL.test(auth)) return null;
    if (!isBrowserKeys({ p256dh: Buffer.from(p256dh, 'base64url'), auth: Buffer.from(auth, 'base64url') })) return null;
    try {
        // A point on the curve: anything else would only fail at the first send.
        const probe = crypto.createECDH('prime256v1');
        probe.generateKeys();
        probe.computeSecret(Buffer.from(p256dh, 'base64url'));
    } catch {
        return null;
    }
    return { endpoint: s.endpoint, p256dh, auth };
}

/** The id a browser's row is found by: its endpoint's HMAC under this server's key. Throws {@link RecoverySealKeyMissing}. */
export function webPushSubId(endpoint: string): string {
    return idUnder(requireKeys(), endpoint);
}

/**
 * Keep this browser for a key whose request to join is open here (the caller has checked: routes/web-push.ts), in place of
 * any browser it kept before. Returns the row's id. Throws {@link RecoverySealKeyMissing}; never stores a subscription
 * unlocked.
 */
export function putAskerSubscription(publicKey: string, sub: BrowserSubscription, contact: string, lang: Lang | null): string {
    const keys = requireKeys();
    const subId = idUnder(keys, sub.endpoint);
    const sealed: Sealed = { ...sub, contact };
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const box = Buffer.concat([nonce, xchacha20poly1305(keys.box, nonce, aad(publicKey, subId)).encrypt(Buffer.from(JSON.stringify(sealed), 'utf8'))])
        .toString('base64');
    db.transaction(() => {
        db.prepare(`DELETE FROM web_push_subscriptions WHERE public_key = ? AND kind = 'asker'`).run(publicKey);
        db.prepare(`INSERT INTO web_push_subscriptions (public_key, sub_id, sub_box, lang, kind) VALUES (?, ?, ?, ?, 'asker')`)
            .run(publicKey, subId, box, lang);
    })();
    return subId;
}

/** The signer's own row with this id, gone. How many went (0 or 1). */
export function removeWebPushSubscription(publicKey: string, subId: string): number {
    return db.prepare('DELETE FROM web_push_subscriptions WHERE public_key = ? AND sub_id = ?').run(publicKey, subId).changes;
}

/** A cancelled or declined request: the browser kept for its key goes. */
export function dropAskerSubscriptionsOf(publicKey: string): number {
    return db.prepare(`DELETE FROM web_push_subscriptions WHERE public_key = ? AND kind = 'asker'`).run(publicKey.toLowerCase()).changes;
}

function openBox(keys: Keys, publicKey: string, subId: string, box: string): Sealed | null {
    try {
        const bytes = Buffer.from(box, 'base64');
        if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
        const plain = xchacha20poly1305(keys.box, bytes.subarray(0, NONCE_BYTES), aad(publicKey, subId)).decrypt(bytes.subarray(NONCE_BYTES));
        const s = JSON.parse(Buffer.from(plain).toString('utf8')) as Sealed;
        if (idUnder(keys, s.endpoint) !== subId || typeof s.contact !== 'string') return null;
        return s;
    } catch {
        return null;
    }
}

export interface WebPushRecipient { subId: string; lang: Lang | null; target: WebPushTarget }

/**
 * The browsers a push of this kind reaches for this key: in W1, `join.answered` to the browser the key asked with, and
 * nothing for any other kind (W2 adds members' browsers). A row this server's key does not open is skipped. Never throws.
 */
export function webPushTargetsFor(publicKey: string, kind: PushNoticeKind): WebPushRecipient[] {
    if (kind !== 'join.answered') return [];
    let keys: Keys;
    try {
        keys = requireKeys();
    } catch {
        return [];
    }
    const rows = db.prepare(`SELECT sub_id, sub_box, lang FROM web_push_subscriptions WHERE public_key = ? AND kind = 'asker'`).all(publicKey) as
        { sub_id: string; sub_box: string; lang: string | null }[];
    const out: WebPushRecipient[] = [];
    for (const r of rows) {
        const s = openBox(keys, publicKey, r.sub_id, r.sub_box);
        if (!s) continue;
        out.push({
            subId: r.sub_id, lang: isLang(r.lang) ? r.lang : null,
            target: { endpoint: s.endpoint, p256dh: Buffer.from(s.p256dh, 'base64url'), auth: Buffer.from(s.auth, 'base64url'), contact: s.contact },
        });
    }
    return out;
}

/** How a kind is delivered (design §2.2): W1's one kind, `join.answered`, lives as long as its invite, normal, topic `join`. */
export function webPushDelivery(_kind: 'join.answered', ttlSeconds: number | undefined): { ttlSeconds: number; urgency: PushUrgency; topic: string } {
    return { ttlSeconds: pushTtl(ttlSeconds ?? 0), urgency: 'normal', topic: 'join' };
}

export interface WebPushSend {
    publicKey: string;
    subId: string;
    target: WebPushTarget;
    payload: Record<string, unknown>;
    ttlSeconds: number;
    urgency: PushUrgency;
    topic?: string;
}

/**
 * Hand each message to its browser's push service, in turn (services/web-push.ts), and forget a browser whose service says
 * it is gone (404, 410). Returns at once; never throws.
 */
export function sendWebPushes(sends: readonly WebPushSend[]): void {
    if (sends.length === 0) return;
    let key: ReturnType<typeof readVapidKey>;
    try {
        key = readVapidKey();
    } catch (e: any) {
        console.warn(`[WebPush] Nothing sent: ${e?.message || e}`);
        return;
    }
    if (!key) return;
    for (const s of sends) {
        void sendWebPush(s.target, s, key).then((outcome) => {
            if (outcome === 'gone') removeWebPushSubscription(s.publicKey, s.subId);
        }).catch(() => { /* sendWebPush never throws */ });
    }
}
