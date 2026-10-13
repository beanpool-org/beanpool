/**
 * name-key-memory — the phone remembers which key each name had (group chats, line-display design §10 pick 3, decided).
 *
 * Names are the node's (§8): a node that moves a callsign to another key lies everywhere at once. The phone's own past is
 * the only guard: once it has seen a name on a key, a later roster showing that name on another key, with no succession
 * statement from the new key reaching the old one (core walkKeySuccession over the row's `formerKeys`), is marked
 * "(key changed)" beside the name, as Signal marks a safety-number change. A re-key the member confirmed is no change.
 * The mark stays until such a statement is served. The web app keeps nothing (parent design §4).
 *
 * A claim is only the claimant's word (review of #1826, NB4): a chain reaching a key that is another row's current key in
 * the same roster doesn't count, and a name two rows share is neither moved nor cleared.
 *
 * Per community and per name (ASCII case folded, as the node's own lower(callsign) uniqueness is), in AsyncStorage:
 * { key, changedFrom? }.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { verifiedFormerKeys, type FormerKey } from './group-chat-crypto';

export const KEY_CHANGED_HINT = '(key changed)';

export interface RememberedKey {
    key: string;
    /** The key this name had before, when it moved with no statement: the mark shows until one reaches it. */
    changedFrom?: string;
}
export type NameKeyMemory = Record<string, RememberedKey>;

export interface MemoryRosterRow {
    memberPubkey: string;
    callsign?: string | null;
    formerKeys?: readonly FormerKey[] | null;
}

/** SQLite's lower() folds ASCII only, so "Ána" and "ána" are two members on the node, and two names here. */
const nameKey = (callsign: string) => callsign.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The memory after seeing `roster`, and the keys to mark "(key changed)". Pure: a name first seen is remembered; a name
 * on the same key stays; a name on another key is a change unless the row's verified chain reaches the remembered key.
 */
export function noteRosterNames(memory: NameKeyMemory, roster: readonly MemoryRosterRow[]): { memory: NameKeyMemory; changed: Set<string> } {
    const next: NameKeyMemory = { ...memory };
    const changed = new Set<string>();
    const current = new Set(roster.filter((r) => typeof r?.memberPubkey === 'string').map((r) => r.memberPubkey));
    const named = roster.filter((r): r is MemoryRosterRow & { callsign: string } => !!r?.callsign && typeof r.memberPubkey === 'string');
    const rowsNamed = new Map<string, number>();
    for (const r of named) rowsNamed.set(nameKey(r.callsign), (rowsNamed.get(nameKey(r.callsign)) ?? 0) + 1);
    for (const r of named) {
        const n = nameKey(r.callsign);
        const seen = next[n];
        if ((rowsNamed.get(n) ?? 0) > 1) {
            // Two rows with one name: the node is saying two things; the memory keeps what it had, mark included.
            if (seen?.changedFrom && seen.key === r.memberPubkey) changed.add(r.memberPubkey);
            continue;
        }
        const former = new Set(verifiedFormerKeys(r).filter((k) => !current.has(k)));
        const reaches = (k: string) => former.has(k);
        if (!seen) {
            next[n] = { key: r.memberPubkey };
        } else if (seen.key === r.memberPubkey) {
            if (seen.changedFrom && reaches(seen.changedFrom)) next[n] = { key: r.memberPubkey };
            else if (seen.changedFrom) changed.add(r.memberPubkey);
        } else if (reaches(seen.key)) {
            next[n] = { key: r.memberPubkey };
        } else {
            next[n] = { key: r.memberPubkey, changedFrom: seen.changedFrom ?? seen.key };
            changed.add(r.memberPubkey);
        }
    }
    return { memory: next, changed };
}

const storageKey = (nodeUrl: string) => `beanpool_name_keys:${nodeUrl.replace(/\/+$/, '')}`;

/** Reads this community's memory, notes the roster, writes it back: the keys to mark. Storage failing marks nothing. */
export async function rememberRosterNames(nodeUrl: string, roster: readonly MemoryRosterRow[]): Promise<Set<string>> {
    try {
        const raw = await AsyncStorage.getItem(storageKey(nodeUrl));
        const memory = raw ? (JSON.parse(raw) as NameKeyMemory) : {};
        const { memory: next, changed } = noteRosterNames(memory && typeof memory === 'object' ? memory : {}, roster);
        await AsyncStorage.setItem(storageKey(nodeUrl), JSON.stringify(next));
        return changed;
    } catch {
        return new Set();
    }
}

/** The details line under a marked name (§10 pick 3). */
export const KEY_CHANGED_DETAILS = "This phone knew this name on another key, and the new key hasn't confirmed it was theirs.";

/**
 * A chat's shown lines with the mark: a line whose signer is a marked key gets "(key changed)" beside its name and the
 * details line. A line with no name of its own (unverified, still opening) is left as it is.
 */
export function markKeyChanged<T extends { senderId?: string; unattributed?: boolean; authorName?: string | null; integrityNote?: string | null }>(
    lines: readonly T[], changed: ReadonlySet<string>,
): T[] {
    if (changed.size === 0) return [...lines];
    return lines.map((m) => (!m.unattributed && m.senderId && m.authorName && changed.has(m.senderId)
        ? { ...m, authorName: `${m.authorName} ${KEY_CHANGED_HINT}`, integrityNote: m.integrityNote ? `${m.integrityNote} ${KEY_CHANGED_DETAILS}` : KEY_CHANGED_DETAILS }
        : m));
}
