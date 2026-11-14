/**
 * The browsers that take this server's web pushes (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, slice W1).
 * The push itself, its encryption and the node's key are services/web-push.ts; the routes are routes/web-push.ts.
 *
 * ## Who has a row
 *
 * Two kinds. `asker` (W1): a key with an open request to join here that tapped "Tell me when they answer" on the waiting
 * page. One row per key (a second browser replaces the first). No reference to `members`: the key is no member yet. The row
 * goes when the request is cancelled or declined (engine/knocks.ts cancelKnock, declineKnock) and when it lapses (tidyKnocks,
 * every minute); it stays once the request is approved (the yes is what it waits for) and when the key joins (the same key,
 * now a member). What it is sent: `join.answered`, and nothing else (`webPushTargetOpener`). Bound: a row needs an open
 * request, and requests have the knock rules' ceilings (30 a day on the node, 50 open made in three days, one per key).
 *
 * `member` (W2): a member's own browser, from "Turn on" (the web app's card or its Settings row). One row per browser, as
 * a phone's push token is: every kind the member's phone is pushed, under the same switches (state-engine.ts
 * dispatchPushNotification). Bound as phones are ({@link MEMBER_BROWSER_RULES}, KEY_PUSH_RULES' numbers): 10 live a key,
 * the stalest going past it, and 20 new a day. The same browser again (its endpoint) is the same row, never a new one, an
 * asker's row for that browser becomes the member's, and another key's row for it goes (a browser is one account's). A member's rows go with the member: removed (engine/member-
 * wizards.ts), re-keyed (engine/key-move.ts), or found gone at the tidy-up ({@link dropLapsedMemberBrowsers}).
 *
 * ## Locked at rest
 *
 * The endpoint, the browser's `p256dh` and `auth` and the node's https address as the browser reached it (the push's
 * `sub`) are the full right to put words on that browser, with the node's key. As push tokens are (services/push-token-
 * seal.ts), they are never in the database in the clear: `sub_id` is HMAC-SHA256 of the endpoint and `sub_box` the four
 * sealed with XChaCha20-Poly1305 (a random nonce, bound to the key and the id), both keys from data/recovery-seal.key with
 * info `beanpool-web-push/v1`. A copy of the database alone opens none. This server's own (replication-manifest.ts,
 * `local`): after a take-over the asker loses only the buzz, never the yes, which the waiting page reads every 5 minutes and
 * the 30-day invite keeps; a member's browser is subscribed again at the web app's next open (lib/web-push.ts
 * keepWebPushAtOpen posts the subscription each time it is open and allowed), and the bell has what came between.
 */
import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { isLang, PUSH_NOTICE_LIFETIME_SECONDS, type Lang, type PushNoticeKind } from '@beanpool/core';
import { db } from '../db/db.js';
import { recoverySealSubkey, RecoverySealKeyMissing, RECOVERY_SEAL_KEY_FILE } from '../services/recovery-seal-key.js';
import {
    isBrowserKeys, isPushServiceEndpoint, pushTtl, readVapidKey, sendWebPush, type PushUrgency, type WebPushTarget,
} from '../services/web-push.js';

const INFO = 'beanpool-web-push/v1';
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const DAY_SECONDS = 24 * 60 * 60;

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

function sealRow(keys: Keys, publicKey: string, subId: string, sealed: Sealed): string {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    return Buffer.concat([nonce, xchacha20poly1305(keys.box, nonce, aad(publicKey, subId)).encrypt(Buffer.from(JSON.stringify(sealed), 'utf8'))])
        .toString('base64');
}

/**
 * Keep this browser for a key whose request to join is open here (the caller has checked: routes/web-push.ts), in place of
 * any browser it kept before. Returns the row's id. Throws {@link RecoverySealKeyMissing}; never stores a subscription
 * unlocked.
 */
export function putAskerSubscription(publicKey: string, sub: BrowserSubscription, contact: string, lang: Lang | null): string {
    const keys = requireKeys();
    const subId = idUnder(keys, sub.endpoint);
    const box = sealRow(keys, publicKey, subId, { ...sub, contact });
    db.transaction(() => {
        db.prepare(`DELETE FROM web_push_subscriptions WHERE public_key = ? AND kind = 'asker'`).run(publicKey);
        db.prepare(`INSERT INTO web_push_subscriptions (public_key, sub_id, sub_box, lang, kind) VALUES (?, ?, ?, ?, 'asker')`)
            .run(publicKey, subId, box, lang);
    })();
    return subId;
}

/**
 * What one key may keep and add of its browsers: a phone's numbers (state-engine.ts KEY_PUSH_RULES), so an account on
 * several computers and phones is far inside them and no key can fill the table.
 */
export const MEMBER_BROWSER_RULES = {
    /** Browsers a key holds at once; a new one past this drops the key's stalest (subscribed again longest ago). */
    liveBrowsers: 10,
    /** New browsers a key may add in any 24 hours, then `key_rate_limited`. The same browser again is never new. */
    newBrowsersPerDay: 20,
} as const;

/** Each key's new browsers in the last day, by time (ms): {@link MEMBER_BROWSER_RULES}.newBrowsersPerDay. */
const newBrowsers = new Map<string, number[]>();

/**
 * Keep this browser for a member (the caller has checked the key is one: routes/web-push.ts). The same browser again keeps
 * its row, sealed afresh with this answer's language and address, and an asker's row for it becomes the member's.
 * Returns the row's id, or `key_rate_limited` past {@link MEMBER_BROWSER_RULES}.newBrowsersPerDay. Throws
 * {@link RecoverySealKeyMissing}; never stores a subscription unlocked.
 */
export function putMemberSubscription(publicKey: string, sub: BrowserSubscription, contact: string, lang: Lang | null, now = Date.now()): string | 'key_rate_limited' {
    const keys = requireKeys();
    const subId = idUnder(keys, sub.endpoint);
    const box = sealRow(keys, publicKey, subId, { ...sub, contact });
    return db.transaction((): string | 'key_rate_limited' => {
        const held = !!db.prepare(`SELECT 1 FROM web_push_subscriptions WHERE public_key = ? AND sub_id = ? AND kind = 'member'`).get(publicKey, subId);
        if (!held) {
            // Counted in memory, rows since dropped included (a restart forgets it: the live cap still holds the rows).
            const day = (newBrowsers.get(publicKey) ?? []).filter((t) => t > now - DAY_SECONDS * 1000);
            if (day.length >= MEMBER_BROWSER_RULES.newBrowsersPerDay) return 'key_rate_limited';
            day.push(now);
            newBrowsers.set(publicKey, day);
            if (newBrowsers.size > 10_000) newBrowsers.delete(newBrowsers.keys().next().value!);
        }
        // A browser is one account's: the same browser kept for another key (an account signed out here without its row
        // going) goes, so it is never told that account's notices, which it could only refuse as not for this one.
        db.prepare('DELETE FROM web_push_subscriptions WHERE sub_id = ? AND public_key != ?').run(subId, publicKey);
        db.prepare(`INSERT INTO web_push_subscriptions (public_key, sub_id, sub_box, lang, kind) VALUES (?, ?, ?, ?, 'member')
            ON CONFLICT (public_key, sub_id) DO UPDATE SET sub_box = excluded.sub_box, lang = excluded.lang, kind = 'member',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(publicKey, subId, box, lang);
        // Past its live browsers, the key's stalest go (never this one).
        db.prepare(`DELETE FROM web_push_subscriptions WHERE public_key = ? AND kind = 'member' AND sub_id IN (
            SELECT sub_id FROM web_push_subscriptions WHERE public_key = ? AND kind = 'member' AND sub_id != ?
            ORDER BY updated_at DESC, created_at DESC, sub_id DESC LIMIT -1 OFFSET ?)`)
            .run(publicKey, publicKey, subId, MEMBER_BROWSER_RULES.liveBrowsers - 1);
        return subId;
    })();
}

/** Every browser of this key, of both kinds, gone: the member was removed, or its key replaced. How many went. */
export function dropWebPushSubscriptionsOf(publicKey: string): number {
    return db.prepare('DELETE FROM web_push_subscriptions WHERE public_key = ?').run(publicKey).changes;
}

/**
 * The tidy-up's part for members' browsers (engine/knocks.ts tidyKnocks, every minute): a row whose key is replaced, or is
 * no member here any more (removed, a visitor's, never one), goes. An asker's rows are the knock rules' (tidyKnocks).
 */
export function dropLapsedMemberBrowsers(): number {
    return db.prepare(`DELETE FROM web_push_subscriptions WHERE kind = 'member' AND (
            EXISTS (SELECT 1 FROM invalidated_keys i WHERE i.public_key = web_push_subscriptions.public_key)
            OR NOT EXISTS (SELECT 1 FROM members m WHERE m.public_key = web_push_subscriptions.public_key AND m.is_visitor = 0 AND m.status != 'pruned'))`).run().changes;
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

/** The browsers a push of this kind reaches for one key: {@link webPushTargetOpener}'s answer. */
export type WebPushTargetOpener = (publicKey: string, kind: PushNoticeKind) => WebPushRecipient[];

/**
 * The browsers a push of this kind reaches for a key: a member's own browsers for every kind (W2), and the browser an
 * asker tapped "Tell me when they answer" on for `join.answered` only (W1), which asked for nothing else. A row this
 * server's key does not open is skipped.
 *
 * This server's key is read, and the two reads prepared, once, when the opener is made: for a send to many members (an
 * announcement reaches every one), which would otherwise read the key file for each, as services/push-token-seal.ts
 * pushTokenOpener is for phones. With no key (or one that can't be read) it finds none. Never throws.
 */
export function webPushTargetOpener(): WebPushTargetOpener {
    let keys: Keys;
    try {
        keys = requireKeys();
    } catch {
        return () => [];
    }
    const memberRows = db.prepare(`SELECT sub_id, sub_box, lang FROM web_push_subscriptions WHERE public_key = ? AND kind = 'member'`);
    const answerRows = db.prepare(`SELECT sub_id, sub_box, lang FROM web_push_subscriptions WHERE public_key = ? AND kind IN ('member', 'asker')`);
    return (publicKey, kind) => {
        const rows = (kind === 'join.answered' ? answerRows : memberRows).all(publicKey) as { sub_id: string; sub_box: string; lang: string | null }[];
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
    };
}


/**
 * How a kind is delivered (design §2.2, "TTL, urgency, topic by kind"):
 * - `join.answered`: as long as its invite (`ttlSeconds`, the sender's), normal, topic `join`;
 * - a chat's (`chat.*`), and a forum reply's or mention's (`forum.reply`, `forum.mention`): a day, normal, topic = the kind,
 *   so a browser away for a week wakes to one "You have a new message.", not forty (a push service keeps only the newest
 *   undelivered message of a topic);
 * - the account's and the owners' (`account.*`, `owner.*`): a day, high;
 * - every other kind (deals, requests to join, events, the market): the notice's own lifetime, 7 days, normal.
 */
export function webPushDelivery(kind: PushNoticeKind, ttlSeconds: number | undefined): { ttlSeconds: number; urgency: PushUrgency; topic?: string } {
    if (kind === 'join.answered') return { ttlSeconds: pushTtl(ttlSeconds ?? 0), urgency: 'normal', topic: 'join' };
    if (kind.startsWith('chat.') || kind === 'forum.reply' || kind === 'forum.mention') return { ttlSeconds: DAY_SECONDS, urgency: 'normal', topic: kind.replace(/\./g, '-') };
    if (kind.startsWith('account.') || kind.startsWith('owner.')) return { ttlSeconds: DAY_SECONDS, urgency: 'high' };
    return { ttlSeconds: pushTtl(PUSH_NOTICE_LIFETIME_SECONDS), urgency: 'normal' };
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
