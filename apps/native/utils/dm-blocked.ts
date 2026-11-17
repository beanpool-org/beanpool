/**
 * A member's block of a person holds across that person's re-keys, wherever the phone reads a DM (review of #3268,
 * finding 2; Signal's model, DESIGN-dm-key-signal-model). After an admin re-keys someone, the phone may hold a DM with both
 * of their keys as participants (it keeps the old key's row until a send, #1872 U7), a card for either or both, and a pin
 * that has followed the listing to the new key with the old one kept in `former`. The member blocked one of those keys,
 * and the name order (db.ts otherParticipantSql) may now pick another. So a DM is read as blocked when ANY key its other
 * person is known by here is on the block list, never only the one key a reader happens to name it by.
 *
 * The block list itself follows a re-key too (blocklist.ts followRekeyedBlocks: the community moved its own copy of the
 * block, and says which key replaced which), so a screen that reads one key (a profile, the market, a forum post) holds it
 * once that has run; this rule holds the DM before then, and after the old participant row has gone.
 *
 * Pure functions: db.ts, the Talk list (app/(tabs)/chats.tsx) and the thread (app/chat/[id].tsx) share them, and
 * utils/__tests__/dm-blocked-after-rekey.test.ts holds them to the table.
 */
import { t } from '@beanpool/core';

/** What a DM's pin says about its other person (dm-peer-pins.ts DmPeerPin), as far as blocks go. */
export interface DmPinKeys {
    peer?: string | null;
    former?: readonly string[] | null;
    offered?: { peer?: string | null } | null;
}

/** A chat type that is a DM between two people: the phone's rows write 'dm', and an older row none. */
export function isDmType(type: string | null | undefined): boolean {
    return !type || type === 'dm';
}

/**
 * Every key a DM's other person is known by on this phone: the other participants' keys (`otherKeys`, a list or SQLite's
 * comma-joined group_concat), the key its pin seals to, the keys pinned before it, and a key a listing offers. Each once.
 */
export function dmPeerKeys(otherKeys: string | readonly string[] | null | undefined, pin?: DmPinKeys | null): string[] {
    const listed = typeof otherKeys === 'string' ? otherKeys.split(',') : (otherKeys ?? []);
    const all = [...listed, pin?.peer, ...(pin?.former ?? []), pin?.offered?.peer];
    return [...new Set(all.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(k => k.trim()))];
}

/** Blocked when any of the DM's other keys is on the member's block list. */
export function isDmBlocked(keys: readonly string[], blocked: readonly string[]): boolean {
    return keys.some(k => blocked.includes(k));
}

/** A chat in Talk's list, as getConversations returns it (db.ts). */
export interface TalkChat {
    type?: string | null;
    peerPubkey?: string | null;
    peerKeys?: readonly string[] | null;
}

/**
 * Talk's list of chats: a group, enterprise or event chat lives under Groups (decision 6), and a DM with someone the member
 * blocked, under any of their keys, is not listed. The list read the peer's key under three names getConversations never
 * returns, so before this a blocked person's DM was always listed (review of #3268).
 */
export function talkShowsChat(c: TalkChat, blocked: readonly string[]): boolean {
    if (c.type === 'group_thread' || c.type === 'event_thread' || c.type === 'enterprise_thread') return false;
    const keys = c.peerKeys && c.peerKeys.length > 0 ? c.peerKeys : (c.peerPubkey ? [c.peerPubkey] : []);
    return !isDmBlocked(keys, blocked);
}

/**
 * The name a chat shows for its other person, in Talk's list, the thread's header and Needs you alike: the chat's own name,
 * the person's card, then the start of their key (no card held yet: a community that says `membersOnDemand`,
 * DESIGN-global-members-by-area §2.4), and "Member" when no other key is known. Never the conversation's id, which named a
 * re-keyed person's DM in the walk of #3263.
 */
export function dmPeerName(row: { name?: string | null; otherCallsign?: string | null; otherPubkey?: string | null }): string {
    const named = row.name?.trim() || row.otherCallsign?.trim();
    if (named) return named;
    const key = row.otherPubkey?.trim();
    return key ? key.slice(0, 8) : t('Member');
}
