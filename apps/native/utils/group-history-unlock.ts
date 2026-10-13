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
import { keysThisPhoneKnewFor, namesThisPhoneSawFor } from './name-key-memory';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── What the screens say (§7, §3, §4) ──────────────────────────────────────────────────────────────────────────────

/** The one quiet row at the top of the locked span (§7, Marty's pick 5). */
export function lockedHistoryRowText(n: number): string {
    return `🔒 ${n} ${n === 1 ? 'message' : 'messages'} from before you changed phones. Unlock →`;
}
export const LOCKED_HISTORY_SHEET_TITLE = 'Messages from before you changed phones';
export const LOCKED_HISTORY_SHEET_BODY = "They were locked to your old phone's key. They come back only with your old 12 words, or when a member of the group confirms this phone in person. Your own messages from then show under your name, without their words, until they do.";
/** One of the member's own lines in the locked span (§7): drawn under their name, with no words. */
export const LOCKED_OWN_LINE_TEXT = 'Your message from before you changed phones. Its words come back when you unlock them.';
export const LOCKED_HISTORY_WORDS = 'I have my old phone or old 12 words';
export const LOCKED_HISTORY_ASK = 'Ask a member of the group to confirm this phone';
export const LOCKED_HISTORY_KEEP = 'Keep them locked';
const PUBKEY_HEX = /^[0-9a-f]{64}$/;
/** The row's id in a chat's lines: the screen draws it as the one tappable row (GroupChatView). */
export const LOCKED_HISTORY_ROW_ID = 'locked-history-before-phone-change';

/**
 * §7: in a group where this member changed phones (their roster row carries a verified former key), the lines waiting for
 * a key from before the first epoch this phone reads collapse into one row, where the first of them was. The member's
 * own lines of that span (`mine`: written by a key of their own verified chain) stay where they were, drawn by `asMine`
 * under their name with no words, and are counted in the row too. Every other waiting line (a lost wrap, an epoch after
 * the change) keeps its own sentence. Pure; `epochOf` is the line's epoch as the display rule read it, `waiting` whether
 * it waits for a key.
 */
export function collapseLockedHistory<T extends { id: string }>(
    lines: readonly T[], opts: {
        changedPhones: boolean; epochOf: (id: string) => number | null; waiting: (id: string) => boolean; row: (n: number) => T;
        mine?: (id: string) => boolean; asMine?: (line: T) => T;
    },
): T[] {
    if (!opts.changedPhones) return [...lines];
    const readable = lines.filter((l) => !opts.waiting(l.id)).map((l) => opts.epochOf(l.id)).filter((e): e is number => e !== null);
    const firstRead = readable.length ? Math.min(...readable) : Infinity;
    const before = (l: T) => { const e = opts.epochOf(l.id); return opts.waiting(l.id) && e !== null && e < firstRead; };
    const n = lines.filter(before).length;
    if (n === 0) return [...lines];
    const out: T[] = [];
    let placed = false;
    for (const l of lines) {
        if (!before(l)) { out.push(l); continue; }
        if (!placed) { out.push(opts.row(n)); placed = true; }
        if (opts.asMine && opts.mine?.(l.id)) out.push(opts.asMine(l));
    }
    return out;
}

/**
 * The keys the node says wrote a served line (its author column and the sealed line's `sender`): what tells this member's
 * own locked lines apart before their words can be opened (§7). Only ever matched against the member's own verified chain.
 */
export function servedAuthorKeys(m: { authorPubkey?: unknown; metadata?: unknown }): string[] {
    let meta: any = m.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    return [m.authorPubkey, meta?.sender].filter((k): k is string => typeof k === 'string' && PUBKEY_HEX.test(k));
}

export const OLD_WORDS_NOT_THE_KEY = "These aren't the words of the key this account moved from.";
export const OLD_WORDS_OWNER = "Your old words don't match the key this community says you moved from. Tell an owner.";
export function oldWordsWithheldText(groupName: string): string {
    return `The node didn't hand over your earlier keys for ${groupName}.`;
}
export function oldWordsProgressText(done: number, total: number): string {
    return `Unlocking ${done} of ${total} ${total === 1 ? 'group' : 'groups'}…`;
}
export const OLD_WORDS_DONE = 'Done. Your earlier messages are unlocked on this phone.';
/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
export function oldWordsNothingText(groupNames: readonly string[]): string {
    return `Nothing was handed over for ${listOf(groupNames)}. Try again later, or tell an owner.`;
}
export const OLD_WORDS_NOTHING_LISTED = 'Nothing was handed over: the community lists no earlier keys of yours that this phone lacks.';

/**
 * The old-words screen's end (review of #1844, finding 4): "Done" only when some group's keys landed; when none did, the
 * groups the node withheld are named, never counted as done.
 */
export function oldWordsEnd(r: OldWordsResult): { text: string; lines: string[]; ok: boolean } {
    if (r.outcome === 'not_the_key') return { text: OLD_WORDS_NOT_THE_KEY, lines: [], ok: false };
    if (r.outcome === 'owner') return { text: OLD_WORDS_OWNER, lines: [], ok: false };
    if (Object.values(r.unlocked).some((n) => n > 0)) return { text: OLD_WORDS_DONE, lines: r.withheld.map((g) => oldWordsWithheldText(g.name)), ok: true };
    if (r.withheld.length > 0) return { text: oldWordsNothingText(r.withheld.map((g) => g.name)), lines: [], ok: false };
    return { text: OLD_WORDS_NOTHING_LISTED, lines: [], ok: true };
}

export const NEW_PHONE_SHOW_TITLE = 'Ask a member to confirm this phone';
export const NEW_PHONE_SHOW_BODY = 'Meet a member of your groups in person. They scan this code with "Confirm a member\'s new phone".';
export const NEW_PHONE_CONFIRM_ACTION = "Confirm a member's new phone";
/** The chat menu's label for it: ChatMenuSheet keeps a label to one line, and this fits it at 320dp with 1.3× text. */
export const NEW_PHONE_CONFIRM_MENU = 'Confirm new phone';
export const NEW_PHONE_BAD_CODE = "This isn't a BeanPool new-phone code.";
export function newPhoneNotListedText(name: string): string {
    return `This isn't the phone the community lists for ${name}.`;
}
export function newPhoneMismatchText(name: string): string {
    return `This phone's record of ${name}'s old key doesn't match what the community says. Don't continue; tell an owner.`;
}
/** The code's old key was another name's key on this phone (§4 amendment 2): the node may have named the new phone. */
export function newPhoneKeyWasOtherText(name: string, other: string): string {
    return `This phone knew that key as ${other}, not ${name}. Don't continue; tell an owner.`;
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
export function newPhoneRefusedRestText(handed: number, planned: number): string {
    return `Handed ${handed} of ${planned}. The community refused the rest: try again, or tell an owner.`;
}
export function newPhoneNothingText(name: string): string {
    return `Nothing to unlock: this phone holds no earlier key of ${name}'s that the new phone lacks.`;
}
/**
 * The confirming phone's end (review of #1844, finding 4): "Done" only when every planned key was handed; fewer is said
 * as a count, none planned as nothing to unlock, and the node's slow-down as where it stopped.
 */
export function newPhoneEnd(name: string, r: { total: number; already?: number; planned: number; stopped: boolean }): { text: string; ok: boolean } {
    const landed = r.total + (r.already ?? 0);
    if (r.stopped) return { text: `${newPhoneProgressText(landed, r.planned)} The community asked this phone to slow down: scan again in a minute to carry on.`, ok: true };
    if (r.planned === 0) return { text: newPhoneNothingText(name), ok: true };
    if (landed < r.planned) return { text: newPhoneRefusedRestText(landed, r.planned), ok: false };
    return { text: newPhoneDoneText(name), ok: true };
}
/** The new phone's own note of who confirmed it (§4): kept on this phone only, never published. */
export function confirmedByText(name: string, at: number): string {
    return `Confirmed by ${name}, ${new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

// ─── What each chat last showed locked (§7's row), for the old-words screen ─────────────────────────────────────────

const lockedKey = (nodeUrl: string, me: string) => `beanpool_locked_history:${nodeUrl.replace(/\/+$/, '')}:${me}`;

/**
 * Per group (its id lower-cased), how many lines its chat last showed in the "from before you changed phones" row. The
 * old-words screen passes them as `locked`, so a group the node answers empty is named as withheld, never counted as done
 * (review of #1844, finding 4). {} when none or unreadable.
 */
export async function lockedHistoryCounts(nodeUrl: string, me: string): Promise<Record<string, number>> {
    try {
        const v = JSON.parse((await AsyncStorage.getItem(lockedKey(nodeUrl, me))) ?? '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => Number.isSafeInteger(e[1]) && (e[1] as number) > 0));
    } catch {
        return {};
    }
}

/** Keeps one group's row count as its chat shows it now (0 forgets it); writes only when it changed. */
export async function noteLockedHistoryCount(nodeUrl: string, me: string, groupId: string, n: number): Promise<void> {
    const counts = await lockedHistoryCounts(nodeUrl, me);
    const id = groupId.toLowerCase();
    if ((counts[id] ?? 0) === n) return;
    if (n > 0) counts[id] = n;
    else delete counts[id];
    try { await AsyncStorage.setItem(lockedKey(nodeUrl, me), JSON.stringify(counts)); } catch { /* the chat writes it again on its next load */ }
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
    /**
     * Groups whose earlier keys didn't land: a refusal, or nothing stored where there was something to store (wraps served,
     * or lines this phone shows locked: `locked`).
     */
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
            const refusedBefore = result.refused;
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
            // Withheld: refused, or nothing landed where something should have (keys opened or served junk, or the chat
            // shows lines locked). An empty answer for a group with locked lines is the node's to give: named, never "Done".
            if (failed || (posted === 0 && (opened > 0 || result.refused > refusedBefore || (g.locked ?? 0) > 0))) result.withheld.push(g);
            done++;
            input.onProgress?.(done, input.groups.length);
        }
        return result;
    }
}

// ─── Path B: a fellow member confirms the new phone in person (§4) ──────────────────────────────────────────────────

export const NEW_PHONE_QR_TAG = 'beanpool-new-phone/1';

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
 * THIS phone's memory says the name was on that old key before any move the phone saw without a statement
 * (name-key-memory.ts). The last one is the anchor. The memory was written from rosters the node served, so it holds only
 * through its order (§4 amendment): once a name moved to a key with no statement from that key over the one it left, the
 * key it moved to never counts, so a phone the node once showed "Cat" on Zed's key refuses, never hands Zed's. A chain
 * that places the moved-to key older than the key the move left never confirms it, and a key this phone saw under another
 * name is refused (§4 amendment 2). What stays the node's word: a phone that never saw the old key under its owner's name.
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
    // The node names the new phone (rekey-redeem.ts: its `bound` callsign), so the name on the code may be one this phone
    // never saw: a key this phone saw as another name's never counts as this name's old key (§4 amendment 2).
    const listed = name;
    const other = (await namesThisPhoneSawFor(input.nodeUrl, code.oldKey)).find((n) => fold(n) !== fold(listed));
    if (other) return { ok: false, reason: 'mismatch', text: newPhoneKeyWasOtherText(name, other) };
    return { ok: true, name, oldKey: code.oldKey, newKey: code.newKey, groups: shared };
}

/**
 * "Confirm" (§4): for each shared group, hand the new key the epochs this phone holds whose signed record names the old
 * key and not the new one (GroupKeyring.epochsForConfirmedPhone, then handToConfirmedPhone). Every group's list is made
 * first, so progress reads "N of M". Leaves out epochs the new phone already holds. Returns how many went per group, how
 * many the node said were already there, how many were planned, and whether the node's speed limit stopped it (the
 * screen offers to carry on).
 */
export async function confirmNewPhone(input: {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    store: GroupKeyStore;
    check: Extract<NewPhoneCheck, { ok: true }>;
    onProgress?: (handed: number, planned: number) => void;
}): Promise<{ handed: Record<string, number>; total: number; already: number; planned: number; stopped: boolean }> {
    const { oldKey, newKey } = input.check;
    const plans: { ring: ReturnType<typeof groupKeyring>; id: string; epochs: number[] }[] = [];
    for (const g of input.check.groups) {
        const ring = groupKeyring(input.nodeUrl, input.identity, g.id, input.store);
        await ring.sync().catch(() => null);
        plans.push({ ring, id: g.id, epochs: await ring.epochsForConfirmedPhone(oldKey, newKey) });
    }
    const planned = plans.reduce((n, p) => n + p.epochs.length, 0);
    const handed: Record<string, number> = {};
    let total = 0;
    let already = 0;
    input.onProgress?.(0, planned);
    for (const p of plans) {
        const r = await p.ring.handToConfirmedPhone(oldKey, newKey, p.epochs, (n) => input.onProgress?.(total + already + n, planned));
        handed[p.id] = r.handed.length;
        total += r.handed.length;
        already += r.already.length;
        if (r.stopped) return { handed, total, already, planned, stopped: true };
    }
    return { handed, total, already, planned, stopped: false };
}

// ─── The new phone's note of who confirmed it (§4) ─────────────────────────────────────────────────────────────────

/** Per group, the epochs another member wrapped to this phone (GroupKeyring.toppedUpBy), as "epoch:wrapper". */
export async function handOversHeld(nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore, groups: readonly HistoryGroup[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const g of groups) {
        const ring = groupKeyring(nodeUrl, identity, g.id, store);
        // The code is on screen: this phone is waiting for a member's wraps now, so it asks without the minute's wait.
        ring.noteWrapsLanded();
        await ring.sync().catch(() => null);
        for (const t of await ring.toppedUpBy().catch(() => [])) out.add(`${g.id}#${t.epoch}:${t.wrapper}`);
    }
    return out;
}

/**
 * Who handed this phone keys since `before` (handOversHeld, read while its new-phone code was on screen): each member's
 * key, most epochs first. A top-up that opens here is a key that member held; their name is the members list's.
 */
export function handedSince(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
    const count = new Map<string, number>();
    for (const x of after) {
        if (before.has(x)) continue;
        const w = x.slice(x.lastIndexOf(':') + 1);
        count.set(w, (count.get(w) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

export interface ConfirmedNote { name: string; at: number }
const NOTES_MAX = 5;
const notesKey = (nodeUrl: string, me: string) => `beanpool_new_phone_confirmed:${nodeUrl}:${me}`;

/** The "Confirmed by" notes this phone kept (newest first); [] when none or unreadable. */
export async function confirmedNotes(nodeUrl: string, me: string): Promise<ConfirmedNote[]> {
    try {
        const v = JSON.parse((await AsyncStorage.getItem(notesKey(nodeUrl, me))) ?? '[]');
        return Array.isArray(v) ? v.filter((n): n is ConfirmedNote => typeof n?.name === 'string' && Number.isFinite(n?.at)).slice(0, NOTES_MAX) : [];
    } catch {
        return [];
    }
}

/**
 * After a member's confirmation (§4): the members who handed this phone keys since `before`, by the names the groups'
 * members lists give their keys, kept as this phone's own "Confirmed by" notes. Returns every note, newest first.
 */
export async function noteConfirmations(input: {
    nodeUrl: string; identity: BeanPoolIdentity; store: GroupKeyStore; groups: readonly HistoryGroup[]; before: ReadonlySet<string>;
}): Promise<ConfirmedNote[]> {
    const me = input.identity.publicKey;
    const keys = handedSince(input.before, await handOversHeld(input.nodeUrl, input.identity, input.store, input.groups));
    const names = new Map<string, string>();
    for (const g of input.groups) {
        if (keys.every((k) => names.has(k))) break;
        try {
            const res = await signedGet(input.nodeUrl, `/api/groups/${encodeURIComponent(g.id)}/members`, input.identity);
            const rows = res.ok ? await res.json() : [];
            for (const r of Array.isArray(rows) ? rows : []) {
                if (keys.includes(r?.memberPubkey) && typeof r.callsign === 'string' && !names.has(r.memberPubkey)) names.set(r.memberPubkey, r.callsign);
            }
        } catch { /* the next group's list may name them */ }
    }
    const found = keys.map((k) => names.get(k)).filter((n): n is string => !!n);
    return found.length ? keepConfirmedNotes(input.nodeUrl, me, found) : confirmedNotes(input.nodeUrl, me);
}

/** Keeps a note for each name, newest first; on this phone only. */
export async function keepConfirmedNotes(nodeUrl: string, me: string, names: readonly string[], at = Date.now()): Promise<ConfirmedNote[]> {
    const next = [...names.map((name) => ({ name, at })), ...(await confirmedNotes(nodeUrl, me)).filter((n) => !names.includes(n.name))].slice(0, NOTES_MAX);
    try { await AsyncStorage.setItem(notesKey(nodeUrl, me), JSON.stringify(next)); } catch { /* a note, not a record: the history itself is in the keys */ }
    return next;
}
