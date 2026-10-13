/**
 * group-history-unlock — a member's group history from before they changed phones comes back, and only two ways
 * (scratch/global-node/DESIGN-group-history-after-rekey-fable.md; Marty's picks of 13 Oct 2026, all five).
 *
 * Why nothing comes back on its own (§1): a succession statement is the claimant's word. The old key is lost and can't
 * countersign, and a puppet the node adds can sign the same sentence over anyone's old key; everything a phone could use
 * to tell the two apart (who is in the group, who claimed what, when) is an answer the node writes. So history moves only
 * from someone who provably already holds those keys, to a key they verified without the node, after a human decision:
 *
 *   A. the member's own old 12 words (§3): typed on the new phone, they make the old key's seed, which opens that key's
 *      wraps (the node keeps them, GET …/keys/former) and nothing else. Each key is checked against its record's
 *      commitment and wrapped to this phone's own key (POST …/keys/wrap). The words and the seed stay in memory for the
 *      run: never sent, never stored.
 *   B. a fellow member, in person (§4): the new phone shows a code [tag, new key, old key, name]; the member's phone
 *      scans it, checks on its own record that the name was on that old key, and hands the new key exactly the epochs
 *      it holds whose signed record names that old key (GroupKeyring.handToConfirmedPhone).
 *
 * The one limit is human: a member who confirms an impostor met in person hands that person exactly the old key's
 * epochs the confirming member holds. The confirm screen says so.
 */
import { isWellFormedRecoveryPhrase, normaliseRecoveryWords, dmPublicKeyOf } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { BeanPoolIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import { groupKeyring, type GroupKeyStore } from './group-chat-keys';
import { makeTopUp, openMyKey, verifiedFormerKeys, verifyGroupEpochRecord, type GroupEpochRecord, type GroupServedWrap } from './group-chat-crypto';
import { keysThisPhoneKnewFor } from './name-key-memory';

// ─── What the screens say (§7, §3, §4) ──────────────────────────────────────────────────────────────────────────────

/** The one quiet row at the top of the locked span (§7, Marty's pick 5). */
export function lockedHistoryRowText(n: number): string {
    return `🔒 ${n} ${n === 1 ? 'message' : 'messages'} from before you changed phones. Unlock →`;
}
export const LOCKED_HISTORY_SHEET_TITLE = 'Messages from before you changed phones';
export const LOCKED_HISTORY_SHEET_BODY = "They were locked to your old phone's key. They come back only with your old 12 words, or when a member of the group confirms this phone in person.";
export const LOCKED_HISTORY_WORDS = 'I have my old phone or old 12 words';
export const LOCKED_HISTORY_ASK = 'Ask a member of the group to confirm this phone';
export const LOCKED_HISTORY_KEEP = 'Keep them locked';
/** Lines in the locked span sent by the member herself: why they read under her name with no words (§7). */
export const LOCKED_HISTORY_OWN_LINES = 'Your own messages from then show your name; their words are locked with the rest.';

export const OLD_WORDS_NOT_THE_KEY = "These aren't the words of the key this account moved from.";
export const OLD_WORDS_OWNER = "Your old words don't match the key this community says you moved from. Tell an owner.";
export function oldWordsWithheldText(groupName: string): string {
    return `The node didn't hand over your earlier keys for ${groupName}.`;
}
export function oldWordsProgressText(done: number, total: number): string {
    return `Unlocking ${done} of ${total} ${total === 1 ? 'group' : 'groups'}…`;
}
export const OLD_WORDS_DONE = 'Done. Your earlier messages are unlocked on this phone.';

export const NEW_PHONE_SHOW_TITLE = 'Ask a member to confirm this phone';
export const NEW_PHONE_SHOW_BODY = 'Meet a member of your groups in person. They scan this code with "Confirm a member\'s new phone".';
export const NEW_PHONE_CONFIRM_ACTION = "Confirm a member's new phone";
export const NEW_PHONE_BAD_CODE = "This isn't a BeanPool new-phone code.";
export function newPhoneNotListedText(name: string): string {
    return `This isn't the phone the community lists for ${name}.`;
}
export function newPhoneMismatchText(name: string): string {
    return `This phone's record of ${name}'s old key doesn't match what the community says. Don't continue; tell an owner.`;
}
export function newPhoneNoMemoryText(name: string): string {
    return `This phone never knew ${name}'s old key. A longer-standing member's phone can confirm them.`;
}
/** The confirm screen (§4): what the member is about to do, with the human limit in it. */
export function newPhoneConfirmText(name: string, groups: readonly string[]): string {
    const list = groups.length === 1 ? groups[0] : `${groups.slice(0, -1).join(', ')} and ${groups[groups.length - 1]}`;
    return `You're confirming this is ${name}'s new phone. Their old key wrote in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'} you share: ${list}. `
        + `Only confirm if this phone is in ${name}'s hands: whoever holds it can read those groups' earlier messages that you can.`;
}
export function newPhoneProgressText(done: number, total: number): string {
    return `Unlocking ${done} of ${total}…`;
}
export function newPhoneDoneText(name: string): string {
    return `Done. ${name}'s new phone can read those conversations.`;
}

// ─── Path A: the old 12 words (§3) ──────────────────────────────────────────────────────────────────────────────────

/** The old key's seed and public key from typed words, or null when they are not 12 listed words. Kept in memory only. */
export function oldKeyFromWords(typed: string | readonly string[]): { seed: Uint8Array; publicKey: string } | null {
    if (!isWellFormedRecoveryPhrase(typed)) return null;
    const phrase = utf8ToBytes(normaliseRecoveryWords(typed).join(' '));
    const inner = sha256(phrase);
    const seed = sha256(inner);
    phrase.fill(0);
    inner.fill(0);
    return { seed, publicKey: dmPublicKeyOf(bytesToHex(seed)) };
}

export interface HistoryGroup {
    id: string;
    name: string;
    /** Lines this phone shows locked from before the change (§7's row): 0 or absent when it knows of none. */
    locked?: number;
}

export interface OldWordsResult {
    outcome: 'done' | 'not_the_key' | 'owner';
    /** Self-wraps the node stored, per group id. */
    unlocked: Record<string, number>;
    /** Groups whose earlier keys the node didn't hand over (a refusal, or nothing that opened where lines are locked). */
    withheld: HistoryGroup[];
    /** Served wraps that failed their record's commitment (junk): taken from none. */
    refused: number;
}

interface FormerAnswer {
    formerKeys?: unknown;
    epochs?: (Omit<GroupEpochRecord, 'groupId' | 'wraps'>)[];
    wraps?: { epoch: number; recipient: string; wrapper: string; ephPub: string; nonce: string; wrapped: string; sig: string | null }[];
    more?: boolean;
}

/**
 * Path A (§3): the member typed their old 12 words on the new phone. Before anything is fetched, the words must make a
 * key other than this one, and the old key this phone itself signed for here, if it signed one (else "These aren't the
 * words…"). Then, group by group: the old key's wraps (GET …/keys/former) — refused outright when the node's chain for
 * this key doesn't name the words' key (the owner sentence: nothing is posted) — each record verified, each wrap opened
 * with the old seed against its record's commitment, each key wrapped to this phone's own key and posted. Interrupted, it
 * resumes on its own: the node serves only the epochs this key still lacks.
 */
export async function unlockWithOldWords(input: {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    store: GroupKeyStore;
    groups: readonly HistoryGroup[];
    typed: string | readonly string[];
    /** The old key this phone signed the succession statement for here (key-succession.ts oldKeySignedHere). */
    signedHere: string | null;
    onProgress?: (done: number, total: number) => void;
}): Promise<OldWordsResult> {
    const result: OldWordsResult = { outcome: 'done', unlocked: {}, withheld: [], refused: 0 };
    const old = oldKeyFromWords(input.typed);
    const me = input.identity.publicKey;
    if (!old || old.publicKey === me || (input.signedHere && input.signedHere !== old.publicKey)) {
        old?.seed.fill(0);
        return { ...result, outcome: 'not_the_key' };
    }
    // The seed's hex can't be wiped in JS: it lives in this call only and is never written anywhere.
    const seedHex = bytesToHex(old.seed);
    old.seed.fill(0);
    {
        let done = 0;
        for (const g of input.groups) {
            input.onProgress?.(done, input.groups.length);
            let after = 0;
            let opened = 0;
            let posted = 0;
            let failed = false;
            for (let page = 0; page < 50; page++) {
                let a: FormerAnswer;
                try {
                    const res = await signedGet(input.nodeUrl, `/api/groups/${encodeURIComponent(g.id)}/keys/former${after ? `?after=${after}` : ''}`, input.identity);
                    if (!res.ok) { failed = true; break; }
                    a = await res.json();
                } catch {
                    failed = true;
                    break;
                }
                const chain = Array.isArray(a.formerKeys) ? a.formerKeys.filter((k): k is string => typeof k === 'string') : [];
                if (chain.length > 0 && !chain.includes(old.publicKey)) return { ...result, outcome: 'owner' };
                const records = new Map<number, GroupEpochRecord>();
                for (const e of Array.isArray(a.epochs) ? a.epochs : []) {
                    if (e && Number.isSafeInteger(e.epoch)) records.set(e.epoch, { groupId: g.id, ...e, subject: e.subject ?? null });
                }
                const wraps = Array.isArray(a.wraps) ? a.wraps : [];
                for (const w of wraps) {
                    if (!w || w.recipient !== old.publicKey || !Number.isSafeInteger(w.epoch)) continue;
                    const record = records.get(w.epoch);
                    if (!record) continue;
                    let key: Uint8Array;
                    try {
                        verifyGroupEpochRecord(record, { groupId: g.id, epoch: w.epoch });
                        const served: GroupServedWrap = { epoch: w.epoch, wrapper: w.wrapper, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: w.sig ?? null };
                        key = openMyKey(record, served, seedHex, g.id);
                    } catch {
                        result.refused++;
                        continue;
                    }
                    opened++;
                    const t = makeTopUp(key, { myEdPrivHex: input.identity.privateKey, groupId: g.id, epoch: w.epoch, recipientPubHex: me });
                    key.fill(0);
                    const res = await signedPost(input.nodeUrl, `/api/groups/${encodeURIComponent(g.id)}/keys/wrap`,
                        { epoch: w.epoch, recipient: me, ephPub: t.ephPub, nonce: t.nonce, wrapped: t.wrapped, sig: t.sig }, input.identity).catch(() => null);
                    if (res?.status === 201) posted++;
                    else if (res?.status === 429) { failed = true; break; }
                }
                const top = wraps.reduce((m, w) => Math.max(m, Number.isSafeInteger(w?.epoch) ? w.epoch : 0), 0);
                if (failed || !a.more || top <= after) break;
                after = top;
            }
            if (posted > 0) {
                result.unlocked[g.id] = posted;
                const ring = groupKeyring(input.nodeUrl, input.identity, g.id, input.store);
                ring.noteWrapsLanded();
                await ring.sync().catch(() => null);
            }
            if (failed || (opened === 0 && (g.locked ?? 0) > 0)) result.withheld.push(g);
            done++;
            input.onProgress?.(done, input.groups.length);
        }
        return result;
    }
}

// ─── Path B: a fellow member confirms the new phone in person (§4) ──────────────────────────────────────────────────

export const NEW_PHONE_QR_TAG = 'beanpool-new-phone/1';
const PUBKEY_HEX = /^[0-9a-f]{64}$/;

/** The code the new phone shows: its key, the old key from its own chain, and its name. */
export function newPhoneQrPayload(identity: Pick<BeanPoolIdentity, 'publicKey' | 'callsign'>, oldKey: string): string {
    return JSON.stringify([NEW_PHONE_QR_TAG, identity.publicKey, oldKey, identity.callsign ?? '']);
}

export interface ScannedNewPhone { newKey: string; oldKey: string; callsign: string }

/** A scanned code, or null for anything that isn't exactly one. */
export function parseNewPhoneQr(text: string): ScannedNewPhone | null {
    try {
        const v = JSON.parse(text);
        if (!Array.isArray(v) || v.length !== 4 || v[0] !== NEW_PHONE_QR_TAG) return null;
        const [, newKey, oldKey, callsign] = v;
        if (typeof newKey !== 'string' || typeof oldKey !== 'string' || typeof callsign !== 'string') return null;
        if (!PUBKEY_HEX.test(newKey) || !PUBKEY_HEX.test(oldKey) || newKey === oldKey || callsign.length > 64) return null;
        return { newKey, oldKey, callsign };
    } catch {
        return null;
    }
}

export type NewPhoneCheck =
    | { ok: true; name: string; oldKey: string; newKey: string; groups: HistoryGroup[] }
    | { ok: false; reason: 'bad_code' | 'not_listed' | 'mismatch' | 'no_memory'; text: string };

/** The ASCII case fold the node's own callsign uniqueness uses (name-key-memory.ts). */
const fold = (s: string) => s.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The confirming member's phone checks a scanned code (§4), all on this phone: the new key is the current key of an
 * active row with the code's name in a members list read now; that row's verified chain names the code's old key; and
 * THIS phone's own memory says the name was on that old key (name-key-memory.ts: it saw it, the node can't write it
 * now). The last one is the anchor: a phone the node once told "her old key was Zed's" refuses, never hands Zed's.
 */
export async function checkNewPhone(input: {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    groups: readonly HistoryGroup[];
    scanned: string;
}): Promise<NewPhoneCheck> {
    const code = parseNewPhoneQr(input.scanned);
    if (!code || code.newKey === input.identity.publicKey) return { ok: false, reason: 'bad_code', text: NEW_PHONE_BAD_CODE };
    const shared: HistoryGroup[] = [];
    let name: string | null = null;
    let chainNamesOld = true;
    for (const g of input.groups) {
        let rows: any[];
        try {
            const res = await signedGet(input.nodeUrl, `/api/groups/${encodeURIComponent(g.id)}/members`, input.identity);
            if (!res.ok) continue;
            rows = await res.json();
        } catch {
            continue;
        }
        if (!Array.isArray(rows)) continue;
        const row = rows.find((m) => m?.status === 'active' && m.memberPubkey === code.newKey);
        if (!row || typeof row.callsign !== 'string' || fold(row.callsign) !== fold(code.callsign)) continue;
        name = row.callsign;
        if (!verifiedFormerKeys({ memberPubkey: code.newKey, formerKeys: row.formerKeys }).includes(code.oldKey)) chainNamesOld = false;
        shared.push(g);
    }
    const shownName = name ?? (code.callsign || 'this member');
    if (!name || shared.length === 0) return { ok: false, reason: 'not_listed', text: newPhoneNotListedText(shownName) };
    const knew = await keysThisPhoneKnewFor(input.nodeUrl, name, code.newKey);
    if (knew.length === 0) return { ok: false, reason: 'no_memory', text: newPhoneNoMemoryText(name) };
    if (!chainNamesOld || !knew.includes(code.oldKey)) return { ok: false, reason: 'mismatch', text: newPhoneMismatchText(name) };
    return { ok: true, name, oldKey: code.oldKey, newKey: code.newKey, groups: shared };
}

/**
 * "Confirm" (§4): for each shared group, hand the new key the epochs this phone holds whose signed record names the old
 * key and not the new one (GroupKeyring.handToConfirmedPhone). Returns how many went per group, and whether the node's
 * speed limit stopped it (the screen offers to carry on).
 */
export async function confirmNewPhone(input: {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    store: GroupKeyStore;
    check: Extract<NewPhoneCheck, { ok: true }>;
    onProgress?: (handed: number) => void;
}): Promise<{ handed: Record<string, number>; total: number; stopped: boolean }> {
    const handed: Record<string, number> = {};
    let total = 0;
    for (const g of input.check.groups) {
        const ring = groupKeyring(input.nodeUrl, input.identity, g.id, input.store);
        await ring.sync().catch(() => null);
        const r = await ring.handToConfirmedPhone(input.check.oldKey, input.check.newKey, (n) => input.onProgress?.(total + n));
        handed[g.id] = r.handed.length;
        total += r.handed.length;
        if (r.stopped) return { handed, total, stopped: true };
    }
    return { handed, total, stopped: false };
}
