/**
 * key-succession — this phone's key confirms that a re-key's old key was this member's (group chats,
 * scratch/global-node/DESIGN-group-chat-line-display-fable.md §5, §6; Marty's picks of 11 Oct 2026).
 *
 * After a re-key the member's old group lines are signed by a key no roster lists any more. The node's link from the old
 * key to the new one is only the node's word, so the NEW key signs, once, that the old key was its own (core
 * makeKeySuccession), the node stores it (POST /api/community/me/key-succession) and serves it with the roster
 * (`formerKeys`), and every member's phone names those old lines by the verified chain (group-line-display.ts).
 *
 * Two moments sign it:
 *   - the new phone, right after its own re-key completes (app/rekey-code.tsx): the member just did it, so no question.
 *     Only when the node lists exactly one re-key to this brand-new key: a node listing more is asking it to sign for keys
 *     the member never saw, and each is left to the prompt;
 *   - a later sign-in, when GET /api/community/me lists exactly one re-key to this key, with `attested: false` (an
 *     admin-path re-key, or one an older app completed): only after §6's prompt, and "Not me" signs nothing and is
 *     remembered for this key on this node, whatever old key or date the node names next, so the prompt doesn't come
 *     back to wear the member down. The prompt waits for a re-key this run just completed, so a member is never asked
 *     about the one they just did.
 *
 * One statement per key per node, ever, remembered on this phone (review of #1826, NB5): an honest node lists exactly
 * one re-key to a key (completeRekey refuses a new key that is a member's or was invalidated), so a node listing more,
 * attested or not, is asking for keys the member never saw, and gets no statement and no prompt.
 *
 * The date signed is the node's date for the re-key (`rekeyedFrom[].at`), shown in the prompt; the old key is the one
 * the node names. That is the honest limit (§8): a dishonest node could show a member the wrong old key at that moment;
 * the member sees a date, and nothing changes after.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import { makeKeySuccession } from './group-chat-crypto';

/** §6: the prompt at a later sign-in, its buttons, and what "Not me" opens. */
export function keySuccessionPromptText(at: string): string {
    return `This account was re-keyed on ${shortDate(at)}. Confirm it was you, and the messages you sent before then will show under your name again.`;
}
export const KEY_SUCCESSION_PROMPT_YES = 'Yes, that was me';
export const KEY_SUCCESSION_PROMPT_NO = 'Not me';

/** How long each ask of the node may take: a hung one never holds the sign-in prompt. */
export const KEY_SUCCESSION_ASK_MS = 15_000;

async function within<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), KEY_SUCCESSION_ASK_MS);
    try {
        return await run(stop.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** A re-key that replaced some old key with this one, as GET /api/community/me lists it. */
export interface RekeyedFrom {
    pubkey: string;
    at: string;
    attested: boolean;
}

const PUBKEY_HEX = /^[0-9a-f]{64}$/;

/** "3 Oct 2026", the way the details sheet writes dates (group-line-display.ts earlierKeyDetails). */
function shortDate(at: string): string {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return at;
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The re-keys to this key the node lists (GET /api/community/me `rekeyedFrom`); [] when it lists none or won't say. */
export async function rekeysToMe(nodeUrl: string, identity: BeanPoolIdentity): Promise<RekeyedFrom[]> {
    try {
        const body = await within(async (signal) => {
            const res = await signedGet(nodeUrl, '/api/community/me', identity, signal);
            return res.ok ? res.json() : null;
        });
        const rows = Array.isArray(body?.rekeyedFrom) ? body.rekeyedFrom : [];
        return rows.filter((r: any) => r && typeof r.pubkey === 'string' && PUBKEY_HEX.test(r.pubkey) && r.pubkey !== identity.publicKey
            && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)))
            .map((r: any) => ({ pubkey: r.pubkey, at: r.at, attested: r.attested === true }));
    } catch {
        return [];
    }
}

/** What this phone remembers of one key on one node: the old key it signed for, or the one the member said "Not me" to. */
interface SuccessionMemory {
    signed?: string;
    declined?: string;
}
const memoryKey = (nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey'>) =>
    `beanpool_key_succession:${nodeUrl.replace(/\/+$/, '')}|${identity.publicKey}`;

async function readMemory(nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey'>): Promise<SuccessionMemory | null> {
    try {
        const raw = await AsyncStorage.getItem(memoryKey(nodeUrl, identity));
        const m = raw ? JSON.parse(raw) : {};
        return m && typeof m === 'object' ? m : {};
    } catch {
        return null;
    }
}

async function writeMemory(nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey'>, patch: SuccessionMemory): Promise<void> {
    const m = (await readMemory(nodeUrl, identity)) ?? {};
    await AsyncStorage.setItem(memoryKey(nodeUrl, identity), JSON.stringify({ ...m, ...patch })).catch(() => { });
}

/**
 * "Not me" (§6): this key is not asked again on this node, by this phone. Not per (old key, date): an honest node lists
 * one re-key to a key, ever, so a node that changes the date or names another old key gets no new prompt (review of
 * #1826, NB5's remainder).
 */
export async function declineRekey(nodeUrl: string, identity: BeanPoolIdentity, r: RekeyedFrom): Promise<void> {
    await writeMemory(nodeUrl, identity, { declined: r.pubkey });
}

/**
 * The one re-key this key may still sign for on this node, or null: the node lists exactly one, unconfirmed; this phone
 * has signed none here; and (for the prompt) the member hasn't said "Not me" here. Null when the memory can't be read.
 */
async function theOneToSign(nodeUrl: string, identity: BeanPoolIdentity, opts: { declinedCounts: boolean }): Promise<RekeyedFrom | null> {
    const listed = await rekeysToMe(nodeUrl, identity);
    if (listed.length !== 1 || listed[0].attested) return null;
    const m = await readMemory(nodeUrl, identity);
    if (!m || m.signed) return null;
    if (opts.declinedCounts && m.declined) return null;
    return listed[0];
}

/** The re-keys to this key nobody has confirmed yet, as the node lists them. */
export async function unattestedRekeys(nodeUrl: string, identity: BeanPoolIdentity): Promise<RekeyedFrom[]> {
    return (await rekeysToMe(nodeUrl, identity)).filter((r) => !r.attested);
}

/**
 * Signs and sends one statement: this key replaced `oldPubkey` at `at`. 'stored' (201), 'already' (409: set before,
 * never changed), or 'refused' (anything else: not this key's re-key, or the node from before §5).
 */
export async function postKeySuccession(nodeUrl: string, identity: BeanPoolIdentity, oldPubkey: string, at: string): Promise<'stored' | 'already' | 'refused'> {
    try {
        const s = makeKeySuccession({ newEdPrivHex: identity.privateKey, oldPubHex: oldPubkey, at });
        const res = await within((signal) => signedPost(nodeUrl, '/api/community/me/key-succession', { oldPubkey: s.pubkey, at: s.at, sig: s.sig }, identity, signal));
        return res.status === 201 ? 'stored' : res.status === 409 ? 'already' : 'refused';
    } catch {
        return 'refused';
    }
}

/**
 * Confirms the one re-key to this key the node lists, when it is unconfirmed and this phone has signed none on this node
 * (and, when `only` is given, it is the one §6's prompt showed and the member said "Yes, that was me" to): 1 if stored,
 * else 0. A statement once sent (stored, or one the node already had) is remembered: this key signs no other here.
 */
export async function attestOwnRekeys(nodeUrl: string, identity: BeanPoolIdentity, only?: readonly RekeyedFrom[]): Promise<number> {
    const r = await theOneToSign(nodeUrl, identity, { declinedCounts: false });
    if (!r || (only && !only.some((o) => o.pubkey === r.pubkey && o.at === r.at))) return 0;
    const sent = await postKeySuccession(nodeUrl, identity, r.pubkey, r.at);
    if (sent !== 'refused') await writeMemory(nodeUrl, identity, { signed: r.pubkey });
    return sent === 'stored' ? 1 : 0;
}

/** The confirmation this run's own re-key is sending, if any: the sign-in prompt waits for it. */
let justCompleted: Promise<unknown> | null = null;

/**
 * Right after this phone's own re-key (app/rekey-code.tsx): confirms the one re-key the node lists to this key, asking
 * nothing. Signs nothing when the node lists none or more than one (nor is the member asked: theOneToSign). Returns how
 * many were stored.
 */
export function attestJustCompletedRekey(nodeUrl: string, identity: BeanPoolIdentity): Promise<number> {
    const run = attestOwnRekeys(nodeUrl, identity);
    justCompleted = run.catch(() => 0);
    return run;
}

/**
 * The re-key §6's prompt asks about at sign-in, or null: the one the node lists, unconfirmed, that this key hasn't signed
 * for and the member hasn't said "Not me" to. Nothing when the node lists more than one. Waits for this run's own.
 */
export async function rekeyToAsk(nodeUrl: string, identity: BeanPoolIdentity): Promise<RekeyedFrom | null> {
    if (justCompleted) await justCompleted;
    return theOneToSign(nodeUrl, identity, { declinedCounts: true });
}

/** How to reach this community's admins, as its owner chose to publish it (GET /api/local/community-info): for "Not me". */
export async function operatorContact(nodeUrl: string): Promise<{ email: string | null; phone: string | null }> {
    try {
        const body = await within(async (signal) => {
            const res = await fetch(`${nodeUrl.replace(/\/+$/, '')}/api/local/community-info`, { signal });
            return res.ok ? res.json() : null;
        });
        const email = typeof body?.contactEmail === 'string' && /^[^\s@?&#/]+@[^\s@?&#/]+\.[^\s@?&#/]+$/.test(body.contactEmail) ? body.contactEmail : null;
        const phone = typeof body?.contactPhone === 'string' && /^\+?[\d\s().-]{4,30}$/.test(body.contactPhone) ? body.contactPhone : null;
        return { email, phone };
    } catch {
        return { email: null, phone: null };
    }
}
