import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { SAVED_NODES_STORE_KEY } from './storage-keys';
import { assertPlainNodeAddress, isPlainNodeAddress, plainOriginOf } from './node-url';
import { clearPendingProfileChange } from './pending-profile-sync';
import { communityKeyOf, communityRecordOf, recordHolds } from './community-index';
import { forgetCommunityRecord, keepCommunityRecord } from './community-record';

export interface SavedNode {
    url: string;
    alias?: string;
    lastConnected?: string;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
}

export async function getSavedNodes(): Promise<SavedNode[]> {
    try {
        const data = await AsyncStorage.getItem(SAVED_NODES_STORE_KEY);
        const nodes: SavedNode[] = data ? JSON.parse(data) : [];
        
        // Auto-migrate standard legacy active node if it exists. Never an address that isn't plain (node-url.ts):
        // nothing is saved from one.
        const currentActiveUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (currentActiveUrl && isPlainNodeAddress(currentActiveUrl) && !nodes.find(n => n.url === currentActiveUrl)) {
            nodes.push({ url: currentActiveUrl, lastConnected: new Date().toISOString() });
            await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
        }
        return nodes;
    } catch (e) {
        console.error("Failed parsing saved nodes:", e);
        return [];
    }
}

/**
 * Save `url` to the phone's list of communities, or refresh its entry. Throws, saving nothing, for an address whose
 * authority isn't exactly `host[:port]` (node-url.ts `assertPlainNodeAddress`).
 */
export async function addSavedNode(url: string, alias?: string, currencyType?: 'text'|'image', currencyValue?: string) {
    assertPlainNodeAddress(url);
    const nodes = await getSavedNodes();
    const existing = nodes.find(n => n.url === url);
    if (!existing) {
        nodes.push({ url, alias, lastConnected: new Date().toISOString(), currencyType, currencyValue });
    } else {
        existing.lastConnected = new Date().toISOString();
        if (alias) existing.alias = alias;
        if (currencyType) existing.currencyType = currencyType;
        if (currencyValue) existing.currencyValue = currencyValue;
    }
    await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(nodes));
    // The first contact makes the community's record (community-record.ts), as an app start does for a saved one.
    await keepCommunityRecord(url);
}

/** What the saved list is read and written through: the phone's storage, or a caller's (delete-here.ts takes one). */
export interface SavedListStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/**
 * The one way a community comes off the phone's saved list: the rows `isGone` picks by their address go, and the record
 * (community-record.ts) of each goes with it, and the record of `address` itself, so a record never stays on the phone
 * after its row. By default the rows saved at exactly `address` go; Delete here and the update block's Leave pick by
 * their own spelling rule. Nothing else writes the list to take a row off (utils/__tests__/saved-list-writes.test.ts);
 * the whole list goes only as an account leaves the phone, with every record (account-leaves-phone.ts forgetCommunities).
 *
 * A list that can't be read is left as it is, and `address`'s record still goes (a row still saved gets a record again at
 * the next app start, as any saved row without one does: community-record.ts). Throws when the list can't be written;
 * the records go all the same.
 */
export async function takeOffSavedList(
    address: string,
    isGone: (url: unknown) => boolean = (url) => url === address,
    storage: SavedListStorage = AsyncStorage,
): Promise<void> {
    const gone = new Set<string>([address]);
    try {
        let rows: unknown;
        try {
            const raw = await storage.getItem(SAVED_NODES_STORE_KEY);
            rows = raw ? JSON.parse(raw) : [];
        } catch (e) {
            console.warn('[nodes] The saved list could not be read; it is left as it is', e);
            return;
        }
        if (!Array.isArray(rows)) return;
        const kept = rows.filter((row) => {
            const url: unknown = row && typeof row === 'object' ? (row as { url?: unknown }).url : undefined;
            if (!isGone(url)) return true;
            if (typeof url === 'string') gone.add(url);
            return false;
        });
        if (kept.length !== rows.length) await storage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(kept));
    } finally {
        for (const url of gone) await forgetCommunityRecord(url, storage);
    }
}

/**
 * Take `url` off the phone's list of communities, with its record ({@link takeOffSavedList}). A profile change still
 * waiting to reach it goes with it (pending-profile-sync.ts): it is no longer the phone's to send. A community followed
 * to its new address carried its change there first (address-follow.ts). A community that goes for good is told to drop
 * this phone's push token first: call this from inside account-leaves-phone.ts `forgetCommunityPush`.
 */
export async function removeSavedNode(url: string) {
    // The change waiting is kept under the community's record: cleared while the record still keys it, the row last.
    await clearPendingProfileChange(url);
    await takeOffSavedList(url);
}

/**
 * The saved rows of the community `using` belongs to (its record: community-index.ts recordHolds) become one row at
 * `using`, with the first such row's name and currency (utils/address-verify.ts, after the phone followed the community to
 * another of its addresses, slice S4). The community stays: no record goes and no other community's row is touched. Writes
 * only when something changes; a list that can't be read is left as it is.
 */
export async function followSavedRow(using: string): Promise<void> {
    const record = communityRecordOf(using);
    if (!record) return;
    let rows: unknown;
    try {
        const raw = await AsyncStorage.getItem(SAVED_NODES_STORE_KEY);
        rows = raw ? JSON.parse(raw) : [];
    } catch {
        return;
    }
    if (!Array.isArray(rows)) return;
    const mine = (rows as SavedNode[]).filter((n) => n && typeof n.url === 'string' && recordHolds(record, n.url));
    if (mine.length === 0 || (mine.length === 1 && mine[0].url === using)) return;
    const named = mine.find((n) => n.alias) ?? mine[0];
    const one: SavedNode = { ...mine[0], url: using, ...(named.alias ? { alias: named.alias } : {}) };
    const next: SavedNode[] = [];
    for (const n of rows as SavedNode[]) {
        if (!mine.includes(n)) next.push(n);
        else if (n === mine[0]) next.push(one);
    }
    await AsyncStorage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(next));
}

/** The file a phone with no community open uses (no anchor yet). The same before and after the rename below. */
const NO_COMMUNITY_DATABASE = 'beanpool.db';

/**
 * The SQLite file that holds this phone's copy of the community at `url`. The same name keys that copy's sync cursors
 * and identity epoch (services/pillar-sync.ts `getSyncCursorKey`) and the "did the community change mid-sync" checks.
 *
 * One file per community, and never one file for two: the name ends in a hash of the address's origin (node-url.ts
 * `plainOriginOf`: scheme, host and port, in one spelling), so two communities share a file only if they are one
 * origin. The old name blotted every character but a letter or digit to `_`, so `https://mullum.beanpool.org` and
 * `https://mullum-beanpool.org` (a domain anyone can buy) opened the same file: the second showed and overwrote the
 * first's listings, members, conversations and balances (multi-community review F1). Any domain, address or port
 * works the same way (no-domain-lock-in). The host in front is only so a person reading the directory can tell which
 * is which. An address that isn't plain (it is never a community's) is hashed as written, apart from every origin.
 *
 * A phone's files under the old names move to these once, before any is opened (utils/cache-file-migration.ts).
 * e.g. "https://riverside.example" -> "community_riverside.example_<32 hex>.db"
 *
 * The file goes through the community's record (utils/community-index.ts `communityKeyOf`): it is named from the address
 * the record was made at, so an address the record proved as another of its own (slice S4) opens the same file.
 */
export function getDatabaseFilenameForNode(address: string | null): string {
    if (!address) return NO_COMMUNITY_DATABASE;
    const url = communityKeyOf(address);
    const origin = plainOriginOf(url);
    const host = origin ? origin.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '') : 'unplain';
    const readable = host.replace(/[^a-z0-9.-]/g, '_').slice(0, 40);
    const hash = bytesToHex(sha256(utf8ToBytes(origin ?? `unplain:${url}`))).slice(0, 32);
    return `community_${readable}_${hash}.db`;
}

/**
 * The name `getDatabaseFilenameForNode` gave `url`'s file before every community got a file of its own (F1): kept only
 * so the files a phone already holds can move to their new names (utils/cache-file-migration.ts) and leave with their
 * account (utils/community-cache.ts). Two old Beanpool addresses shared the no-community file on purpose.
 */
export function legacyDatabaseFilenameForNode(url: string | null): string {
    if (!url) return NO_COMMUNITY_DATABASE;
    if (url === 'https://review.beanpool.org:8443' || url === 'https://beanpool.org:8443') {
        return NO_COMMUNITY_DATABASE;
    }
    const sanitized = url.replace(/[^a-zA-Z0-9]/g, '_');
    return `beanpool_${sanitized}.db`;
}

// ── Deliberate guest visits ───────────────────────────────────────────────────
//
// Browsing a community you are not a member of is a legitimate state (read-only
// guest), but it is indistinguishable from the error the root layout watches for —
// "this node doesn't recognise you", i.e. a mistyped address. Without a record of
// intent the watcher ejects deliberate guests to /node-mismatch, which is how a
// member gets thrown out of the very Register screen that would fix it (2026-09-02).
//
// So intent is recorded explicitly: only set when the member is told they are not a
// member and chooses to continue anyway. Cleared the moment they register, so a real
// member is never treated as a guest.
const GUEST_KEY = 'beanpool_guest_nodes';

async function readGuestNodes(): Promise<string[]> {
    try {
        const raw = await AsyncStorage.getItem(GUEST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
        return [];
    }
}

export async function markGuestNode(url: string): Promise<void> {
    if (!url) return;
    try {
        const urls = await readGuestNodes();
        if (!urls.includes(url)) {
            urls.push(url);
            await AsyncStorage.setItem(GUEST_KEY, JSON.stringify(urls));
        }
    } catch {
        // Non-fatal: worst case the watcher diverts to node-mismatch, which is now
        // escapable via the saved-node picker rather than being a dead end.
    }
}

export async function clearGuestNode(url: string): Promise<void> {
    if (!url) return;
    try {
        const urls = await readGuestNodes();
        const next = urls.filter((u) => u !== url);
        if (next.length !== urls.length) {
            await AsyncStorage.setItem(GUEST_KEY, JSON.stringify(next));
        }
    } catch {}
}

/**
 * Every guest mark on the phone goes: an account arriving on a phone that held none, whose marks were the look's
 * (utils/look-around.ts forgetTheLook). Never throws.
 */
export async function clearGuestNodes(): Promise<void> {
    try {
        await AsyncStorage.removeItem(GUEST_KEY);
    } catch {}
}

export async function isGuestNode(url: string): Promise<boolean> {
    if (!url) return false;
    return (await readGuestNodes()).includes(url);
}

/**
 * True when a guest mark names `address`'s community however either is spelled: compared by the copy's file, as the
 * phone keeps one copy per community (slice S2, #3305 review F2: a chat in place is never opened on a guest's look by a
 * link spelling the address in capitals or with a trailing path).
 */
export async function isGuestCopy(address: string): Promise<boolean> {
    if (!address) return false;
    const file = getDatabaseFilenameForNode(address);
    return (await readGuestNodes()).some((u) => getDatabaseFilenameForNode(u) === file);
}
