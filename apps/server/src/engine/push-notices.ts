/**
 * Push notices on the community's server (scratch/global-node/DESIGN-push-relay-fable.md §4.1, §4.3, §4.4; the wire format
 * is @beanpool/core push-notice.ts).
 *
 * Every push this server sends names a kind, and goes out with that kind's fixed words and a signed `data`
 * (state-engine.ts dispatchPushNotification). What the sender wrote (who, which listing, how many beans, an operator's
 * announcement, where a tap should land) never leaves in the push. It is kept here, one row per notice id, for the member
 * it was sent to, who reads it with a signed request (routes/notices.ts `GET /api/notices/push/:id`).
 *
 * - **The id.** 128 random bits, new for each recipient: two members told of one thing get two unrelated ids, and the id
 *   means nothing to Expo, Apple or Google.
 * - **The signature.** By the node key (data/libp2p_key, the key behind the PeerId), with node:crypto: an announcement to
 *   5,000 members is 5,000 signatures. `pushKey` (its raw public key, hex) is what the app pins, from the answer to its
 *   own registration (routes/community.ts `POST /api/push-tokens`). A server with no node key yet sends its pushes
 *   unsigned (no `c`, no `s`) rather than not at all: no hard gate, and the app treats them as not signed.
 * - **Bounded.** A row lives PUSH_NOTICE_LIFETIME_SECONDS (7 days) and a member keeps their newest
 *   PUSH_NOTICES.perMember; the hourly hygiene job (state-engine.ts runMarketplaceHygiene) takes the rest, and the read
 *   never returns one past its lifetime whenever the tidy last ran. The CHECKs cap a row's size.
 * - **This server's own.** Not copied to a standby (engine/replication-manifest.ts, `local`): a standby sends no push, so
 *   it has no notices of its own, and after a take-over a tap on an older notice finds nothing and the app opens the tab
 *   for its kind. Gone with the member on a prune, a self-deletion or a re-key.
 */
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    pushCommunityTag, pushNoticeBytes, PUSH_NOTICE_LIFETIME_SECONDS, PUSH_NOTICE_VERSION, type PushNoticeFields, type PushNoticeKind,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { readNodeIdentity } from '../services/takeover-envelope.js';
import { makeMemberScrubber } from '../logger.js';

export const PUSH_NOTICES = { perMember: 100 } as const;
/**
 * The longest title, body and data (its JSON) a notice's details may hold, in characters: the schema's CHECKs.
 * `noticeBody` is for `community.notice` rows (an operator's announcement, a moderation notice): their details are the only
 * place a closed phone can read the words later, so they get the push's old ceiling and are never cut at 1,000. The
 * announcement route refuses a longer text (ANNOUNCEMENT_LIMITS), so what the operator sends is what members can read.
 */
export const PUSH_NOTICE_DETAIL_LIMITS = { title: 200, body: 1000, noticeBody: 4000, data: 1000 } as const;
/** What `POST /api/local/admin/announcements` accepts, in characters: the same as a notice's details can hold. */
export const ANNOUNCEMENT_LIMITS = { title: PUSH_NOTICE_DETAIL_LIMITS.title, body: PUSH_NOTICE_DETAIL_LIMITS.noticeBody } as const;

/** The DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface PushSigner {
    /** The node key's raw public key, lower-case hex: what the app pins. */
    pushKey: string;
    /** `data.c`. */
    c: string;
    key: crypto.KeyObject;
}

let signer: PushSigner | null = null;
let warnedNoKey = false;

/**
 * This server's notice signer, from its node key; null while it has none (or it can't be read, warned once). Kept once
 * read: a take-over or a restore that brings another key restarts the server.
 */
function pushSigner(): PushSigner | null {
    if (signer) return signer;
    try {
        const identity = readNodeIdentity();
        if (identity) {
            const pushKey = Buffer.from(ed25519.getPublicKey(identity.seed)).toString('hex');
            const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(identity.seed)]), format: 'der', type: 'pkcs8' });
            signer = { pushKey, c: pushCommunityTag(pushKey), key };
            return signer;
        }
        if (!warnedNoKey) console.warn('[Push] This server has no node key yet (data/libp2p_key), so its pushes go unsigned until it has one.');
    } catch (e: any) {
        if (!warnedNoKey) console.warn(`[Push] The node key could not be read, so pushes go unsigned: ${e?.message || e}`);
    }
    warnedNoKey = true;
    return null;
}

/** The key the app pins for this community's notices (raw Ed25519 public key, hex), or null while there is none. */
export function pushKeyHex(): string | null {
    return pushSigner()?.pushKey ?? null;
}

/**
 * What an app from before signed notices can still use, beside the notice: the one tap it acted on that names no id.
 * Its tap on `kind: 'recovery_started'` opens Settings, where the recovery alert offers Stop (apps/native
 * services/push-notifications.ts). Not signed, and a new app reads only the notice.
 */
const FOR_OLD_APPS: Partial<Record<PushNoticeKind, Record<string, string>>> = {
    'account.recovery-started': { kind: 'recovery_started' },
};

/** A new notice for one recipient: its id, and the `data` its push carries (signed, when this server has its node key). */
export function newPushNotice(kind: PushNoticeKind, recipient: string, sentAt: number): { id: string; data: Record<string, unknown> } {
    const id = crypto.randomBytes(16).toString('hex');
    const s = pushSigner();
    const old = FOR_OLD_APPS[kind] ?? {};
    if (!s) return { id, data: { bp: PUSH_NOTICE_VERSION, k: kind, i: id, t: sentAt, ...old } };
    const fields: PushNoticeFields = { c: s.c, k: kind, i: id, t: sentAt };
    const signature = crypto.sign(null, pushNoticeBytes(fields, recipient), s.key).toString('hex');
    return { id, data: { bp: PUSH_NOTICE_VERSION, ...fields, s: signature, ...old } };
}

// ── The details, kept for the recipient ──────────────────────────────────────────────────────────────────────────────

export interface PushNoticeRow {
    id: string;
    recipient: string;
    kind: PushNoticeKind;
    /** What the sender wrote: the words the app may show, never sent in the push. */
    title: string;
    body: string;
    /** Where a tap lands and what else the sender gave (a post, a conversation, a group): never sent in the push. */
    data: Record<string, unknown>;
    /** Whole seconds, the notice's `t`. */
    sentAt: number;
}

export interface PushNoticeDetails {
    id: string;
    kind: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    sentAt: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function clip(text: unknown, max: number): string {
    const s = typeof text === 'string' ? text : '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function dataText(data: Record<string, unknown>): string {
    try {
        const json = JSON.stringify(data ?? {});
        return json !== undefined && json.length <= PUSH_NOTICE_DETAIL_LIMITS.data ? json : '{}';
    } catch {
        return '{}';
    }
}

/**
 * Keeps the details of the notices just sent, one row each. Never throws: a notice whose details could not be kept still
 * goes out, and a tap on it opens the tab for its kind.
 */
export function keepPushNotices(rows: readonly PushNoticeRow[]): void {
    if (rows.length === 0) return;
    try {
        const insert = db.prepare('INSERT OR IGNORE INTO push_notices (id, recipient, kind, title, body, data, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        db.transaction(() => {
            for (const r of rows) {
                insert.run(r.id, r.recipient, r.kind, clip(r.title, PUSH_NOTICE_DETAIL_LIMITS.title), clip(r.body, r.kind === 'community.notice' ? PUSH_NOTICE_DETAIL_LIMITS.noticeBody : PUSH_NOTICE_DETAIL_LIMITS.body),
                    dataText(r.data), r.sentAt);
            }
        })();
    } catch (e: any) {
        console.warn('[Push] Could not keep the details of a push (it still went out):', e?.message || e);
    }
}

function parseData(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

/** A notice's details, for its recipient only, within its lifetime; null for anyone else and for an id this server forgot. */
export function readPushNotice(id: string, recipient: string, now: number = nowSeconds()): PushNoticeDetails | null {
    const row = db.prepare('SELECT * FROM push_notices WHERE id = ? AND recipient = ? AND sent_at >= ?')
        .get(id, recipient, now - PUSH_NOTICE_LIFETIME_SECONDS) as
        { id: string; kind: string; title: string; body: string; data: string; sent_at: number } | undefined;
    if (!row) return null;
    return { id: row.id, kind: row.kind, title: row.title, body: row.body, data: parseData(row.data), sentAt: row.sent_at };
}

/** The bounds, for every member at once: notices past their lifetime, and each member's past their newest perMember. */
export function tidyPushNotices(now: number = nowSeconds()): number {
    return db.transaction(() => {
        const old = db.prepare('DELETE FROM push_notices WHERE sent_at < ?').run(now - PUSH_NOTICE_LIFETIME_SECONDS).changes;
        const over = db.prepare(`DELETE FROM push_notices WHERE id IN (
                                     SELECT id FROM (
                                         SELECT id, ROW_NUMBER() OVER (PARTITION BY recipient ORDER BY sent_at DESC, rowid DESC) AS n
                                           FROM push_notices)
                                     WHERE n > ?)`).run(PUSH_NOTICES.perMember).changes;
        return old + over;
    })();
}

/** A prune, a self-deletion or a re-key: the details kept for this key go (nobody reads them under it again). */
export function dropPushNoticesOf(pubkey: string): void {
    db.prepare('DELETE FROM push_notices WHERE recipient = ?').run(pubkey);
}

/**
 * A self-deletion or a prune: the notices kept for OTHER members that name this member. What a sender wrote can carry a
 * name or a key in its title, body or data: a DM's "<name> sent you a message", a group's "<name> mentioned you" (and its
 * group-name title), a request or an accepted offer ("<name> requested ..."), a review, a trade update, a succession
 * notice. Rather than list the kinds, every kept row of everyone else is read: the name (whole word, any case) and the
 * key's runs (a key, its first 8 or 12) become "a member", and the text then starts with a capital ("A member sent you a
 * message"). The data is scrubbed as JSON, in its strings only. Call it inside the purge's transaction, with the keys a
 * re-key replaced. Returns how many notices changed.
 */
export function neutralisePushNoticesNaming(callsign: string | null | undefined, keys: readonly string[], ownKey: string): number {
    const neutral = makeMemberScrubber(callsign, keys, 'a member');
    if (neutral.none) return 0;
    const sentence = (t: string): string => {
        const out = neutral.text(t) ?? t;
        return out !== t && /^a member/.test(out) ? `A${out.slice(1)}` : out;
    };
    const rows = db.prepare('SELECT id, title, body, data FROM push_notices WHERE recipient != ?').all(ownKey) as
        { id: string; title: string; body: string; data: string }[];
    const update = db.prepare('UPDATE push_notices SET title = ?, body = ?, data = ? WHERE id = ?');
    let changed = 0;
    for (const r of rows) {
        // "a member" can be longer than the name it replaces, and the table's CHECKs would refuse the row and roll the whole
        // purge back: so the same clip as when the row was kept, and details that no longer fit are dropped.
        const title = clip(sentence(r.title), PUSH_NOTICE_DETAIL_LIMITS.title);
        const body = clip(sentence(r.body), PUSH_NOTICE_DETAIL_LIMITS.noticeBody);
        let data = neutral.json(r.data) ?? r.data;
        if (data.length > PUSH_NOTICE_DETAIL_LIMITS.data) data = '{}';
        if (title !== r.title || body !== r.body || data !== r.data) { update.run(title, body, data, r.id); changed++; }
    }
    return changed;
}
