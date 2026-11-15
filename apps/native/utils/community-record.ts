/**
 * The community records this phone keeps (scratch/fable-design/DESIGN-several-addresses-fable.md §3.1, slice S3), read
 * and written here and indexed in utils/community-index.ts, which every store asks "which community is this address?".
 *
 * Made the same way on a new install and on a phone updated from a build before records, around the file and keys already
 * there (§10: no conversion code): at each app start, before any community's copy is opened (communityCachesRenamed
 * waits for communityRecordsReady), the community in use and every saved community that has no record gets one, made by
 * community-index.ts makeCommunityRecord from the address it is saved at; and the first contact with a community
 * (nodes.ts addSavedNode, reconnect.ts switchPhoneTo) makes its record the same way. Nothing is renamed, copied or moved,
 * and every key stays what it was. Who the community is (its server key) is filled from the first proved read (S4): the
 * public statement the phone reads today is not a proof (address-follow.ts).
 *
 * Never a gate: a record that can't be read or written leaves every address its own key, which is what it was.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';
import { isPlainNodeAddress } from './node-url';
import {
    addressSpelling, communityRecordOf, makeCommunityRecord, setCommunityIndex, type CommunityRecord,
} from './community-index';

export interface RecordStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';

function isRecord(value: unknown): value is CommunityRecord {
    const r = value as Partial<CommunityRecord> | null;
    return !!r && typeof r === 'object' && r.v === 1 && typeof r.id === 'string' && typeof r.using === 'string'
        && !!r.proved && typeof r.proved === 'object' && !!r.refused && typeof r.refused === 'object';
}

/** The records kept, as stored: `{ v: 1, records: [...] }`. Anything else reads as none. */
export function parseCommunityRecords(raw: string | null): CommunityRecord[] {
    try {
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed?.records) ? parsed.records.filter(isRecord) : [];
    } catch {
        return [];
    }
}

function savedAddresses(raw: string | null): string[] {
    try {
        const rows = raw ? JSON.parse(raw) : [];
        return Array.isArray(rows) ? rows.map((n) => (n && typeof n === 'object' ? (n as { url?: unknown }).url : null)).filter(isPlainNodeAddress) : [];
    } catch {
        return [];
    }
}

/**
 * `records` with one made for each of `addresses` that none holds yet, in order. Pure: what an app start and a first
 * contact both run, so a new install and an updated phone that hold the same communities end with the same records.
 */
export function withRecordsFor(records: readonly CommunityRecord[], addresses: readonly string[]): CommunityRecord[] {
    const out = [...records];
    const held = (address: string) => out.some((r) => [r.id, r.using, ...Object.keys(r.proved)].some((a) => addressSpelling(a) === addressSpelling(address)));
    for (const address of addresses) {
        if (isPlainNodeAddress(address) && !held(address)) out.push(makeCommunityRecord(address));
    }
    return out;
}

/** One write at a time, so two first contacts never lose each other's record. */
let writing: Promise<unknown> = Promise.resolve();
function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = writing.then(task, task);
    writing = next.catch(() => {});
    return next;
}

async function write(records: readonly CommunityRecord[], storage: RecordStorage): Promise<void> {
    setCommunityIndex(records);
    await storage.setItem(COMMUNITY_RECORDS_STORE_KEY, JSON.stringify({ v: 1, records }));
}

/**
 * Read the records, make one for the community in use and each saved one that has none, and index them. Never throws:
 * records that can't be read or written leave every address its own key.
 */
export function loadCommunityRecords(storage: RecordStorage = AsyncStorage): Promise<void> {
    return serially(async () => {
        let records: CommunityRecord[] = [];
        try {
            const [raw, anchor, saved] = await Promise.all([
                storage.getItem(COMMUNITY_RECORDS_STORE_KEY), storage.getItem(ANCHOR_STORE_KEY), storage.getItem(SAVED_NODES_STORE_KEY),
            ]);
            records = parseCommunityRecords(raw);
            const made = withRecordsFor(records, [...(anchor ? [anchor] : []), ...savedAddresses(saved)]);
            if (made.length !== records.length) await write(made, storage);
            records = made;
        } catch (e) {
            console.warn('[records] Could not read or keep the community records; every address keys as itself', e);
        }
        setCommunityIndex(records);
    });
}

let ready: Promise<void> | null = null;

/** The records loaded, once per app start. Everything that opens a community's copy waits for it. Never rejects. */
export function communityRecordsReady(): Promise<void> {
    return (ready ??= loadCommunityRecords());
}

/** A first contact: `address` gets its record, made as at an app start, unless one already holds it. Never throws. */
export async function keepCommunityRecord(address: string, storage: RecordStorage = AsyncStorage): Promise<void> {
    await communityRecordsReady();
    if (!isPlainNodeAddress(address) || communityRecordOf(address)) return;
    await serially(async () => {
        try {
            const records = parseCommunityRecords(await storage.getItem(COMMUNITY_RECORDS_STORE_KEY));
            const made = withRecordsFor(records, [address]);
            if (made.length !== records.length) await write(made, storage);
            else setCommunityIndex(records);
        } catch (e) {
            console.warn('[records] Could not keep the record of a community; its address keys as itself', e);
        }
    });
}

/** `address`'s own record goes, as its saved row does (nodes.ts removeSavedNode). Never throws. */
export async function forgetCommunityRecord(address: string, storage: RecordStorage = AsyncStorage): Promise<void> {
    await communityRecordsReady();
    await serially(async () => {
        try {
            const records = parseCommunityRecords(await storage.getItem(COMMUNITY_RECORDS_STORE_KEY));
            const kept = records.filter((r) => addressSpelling(r.id) !== addressSpelling(address));
            if (kept.length !== records.length) await write(kept, storage);
        } catch (e) {
            console.warn('[records] Could not forget the record of a community', e);
        }
    });
}

/** Every record goes with the saved list, as an account leaves the phone (account-leaves-phone.ts forgetCommunities). */
export async function forgetEveryCommunityRecord(storage: { removeItem(key: string): Promise<void> } = AsyncStorage): Promise<void> {
    await serially(async () => {
        setCommunityIndex([]);
        await storage.removeItem(COMMUNITY_RECORDS_STORE_KEY);
    });
}

/** Tests only: play the next app start. */
export function resetCommunityRecordsForTests(): void {
    ready = null;
    writing = Promise.resolve();
}
