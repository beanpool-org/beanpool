/**
 * The community record, slice S3 (scratch/fable-design/DESIGN-several-addresses-fable.md §3.1, §9 S3, §10): one record per
 * community, made the same way on a new install and on a phone updated from today's layout, around the file and keys
 * already there; loaded before any community's copy is opened; and no behaviour change: every file name and key is what
 * it was before records.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    reads: [] as string[],
    holdRecords: null as Promise<void> | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => {
            h.reads.push(k);
            if (k === 'beanpool_community_records' && h.holdRecords) await h.holdRecords;
            return h.store.get(k) ?? null;
        }),
        setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { h.store.delete(k); }),
        getAllKeys: vi.fn(async () => [...h.store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) h.store.delete(k); }),
    },
}));
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: 'file:///phone/SQLite' }));
vi.mock('expo-file-system/legacy', () => ({
    getInfoAsync: vi.fn(async () => ({ exists: false })),
    moveAsync: vi.fn(async () => {}),
    copyAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));
vi.mock('../pending-profile-sync', () => ({ clearPendingProfileChange: vi.fn(async () => {}) }));

import { getDatabaseFilenameForNode, addSavedNode, removeSavedNode } from '../nodes';
import {
    communityRecordsReady, keepCommunityRecord, loadCommunityRecords, parseCommunityRecords, resetCommunityRecordsForTests,
    forgetEveryCommunityRecord,
} from '../community-record';
import {
    communityIndexLoaded, communityKeyOf, communityRecordOf, resetCommunityIndexForTests, setCommunityIndex, usingOf,
    makeCommunityRecord,
} from '../community-index';
import { COMMUNITY_RECORDS_STORE_KEY, SAVED_NODES_STORE_KEY, homeAnswerStoreKey, homeLayoutStoreKey } from '../storage-keys';
import { communityCachesRenamed, CACHE_NAMES_DONE_KEY, resetCommunityCachesRenamedForTests } from '../cache-file-migration';
import { communityKey as toolCommunityKey } from '../../tools/community';

const RIVERSIDE = 'https://riverside.example';
const HILLSIDE = 'https://hillside.example:8443';
const PK = 'ab'.repeat(32);

function coldStart() {
    resetCommunityIndexForTests();
    resetCommunityRecordsForTests();
    resetCommunityCachesRenamedForTests();
}

beforeEach(() => {
    h.store.clear();
    h.reads = [];
    h.holdRecords = null;
    coldStart();
});

const recordsKept = () => parseCommunityRecords(h.store.get(COMMUNITY_RECORDS_STORE_KEY) ?? null);

describe('a record is made the same way on an updated phone and a new install', () => {
    it('an update from today\'s layout and a fresh install end with the same records', async () => {
        // A phone updated from a build before records: the community in use and two saved ones, no records.
        h.store.set('beanpool_anchor_url', RIVERSIDE);
        h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside' }, { url: HILLSIDE }]));
        await communityRecordsReady();
        const updated = recordsKept();

        // A new install: the same two communities met for the first time, in the same order.
        h.store.clear();
        coldStart();
        await addSavedNode(RIVERSIDE, 'Riverside');
        h.store.set('beanpool_anchor_url', RIVERSIDE);
        await addSavedNode(HILLSIDE);
        const fresh = recordsKept();

        expect(updated).toEqual([makeCommunityRecord(RIVERSIDE), makeCommunityRecord(HILLSIDE)]);
        expect(fresh).toEqual(updated);
        for (const r of updated) {
            expect(r.id).toBe(r.using);
            expect(r.proved).toEqual({});
        }
    });

    it('a second start makes nothing new, and the record keeps the file and keys already on the phone', async () => {
        // What the phone keys its copy and Home under before any record exists.
        const before = [RIVERSIDE, HILLSIDE].map((u) => [getDatabaseFilenameForNode(u), homeAnswerStoreKey(PK, u), homeLayoutStoreKey(PK, u)]);
        h.store.set('beanpool_anchor_url', RIVERSIDE);
        h.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HILLSIDE }]));
        await communityRecordsReady();
        const first = h.store.get(COMMUNITY_RECORDS_STORE_KEY);
        coldStart();
        await communityRecordsReady();
        expect(h.store.get(COMMUNITY_RECORDS_STORE_KEY)).toBe(first);
        const after = [RIVERSIDE, HILLSIDE].map((u) => [getDatabaseFilenameForNode(u), homeAnswerStoreKey(PK, u), homeLayoutStoreKey(PK, u)]);
        expect(after).toEqual(before);
    });

    it('an address in another spelling is the same record and keys as it is asked (no behaviour change)', async () => {
        await keepCommunityRecord(RIVERSIDE);
        await keepCommunityRecord('https://Riverside.example/');
        expect(recordsKept()).toHaveLength(1);
        expect(communityKeyOf('https://Riverside.example/')).toBe('https://Riverside.example/');
        expect(usingOf(RIVERSIDE)).toBe(RIVERSIDE);
    });

    it('an address that is not plain gets no record, and keys as itself', async () => {
        await keepCommunityRecord('https://user@riverside.example');
        expect(recordsKept()).toEqual([]);
        expect(communityKeyOf('https://user@riverside.example')).toBe('https://user@riverside.example');
    });

    it('a saved row taken off takes its record; an account leaving takes them all', async () => {
        await addSavedNode(RIVERSIDE);
        await addSavedNode(HILLSIDE);
        await removeSavedNode(RIVERSIDE);
        expect(recordsKept().map((r) => r.id)).toEqual([HILLSIDE]);
        expect(communityRecordOf(RIVERSIDE)).toBeNull();
        await forgetEveryCommunityRecord();
        expect(h.store.has(COMMUNITY_RECORDS_STORE_KEY)).toBe(false);
        expect(communityRecordOf(HILLSIDE)).toBeNull();
    });

    it('records that cannot be read leave every address its own key (never a gate)', async () => {
        h.store.set(COMMUNITY_RECORDS_STORE_KEY, '{not json');
        h.store.set('beanpool_anchor_url', RIVERSIDE);
        await loadCommunityRecords();
        expect(communityKeyOf(RIVERSIDE)).toBe(RIVERSIDE);
        expect(recordsKept().map((r) => r.id)).toEqual([RIVERSIDE]);
    });
});

describe('storage goes through the record, the network through `using`', () => {
    it('an address a record proved opens that record\'s file and Home, and requests go to its `using`', () => {
        // What slice S4 writes; here only to show the seam every store already goes through.
        setCommunityIndex([{ ...makeCommunityRecord(RIVERSIDE), using: HILLSIDE, proved: { [HILLSIDE]: { at: 1 } } }]);
        expect(communityKeyOf(HILLSIDE)).toBe(RIVERSIDE);
        expect(getDatabaseFilenameForNode(HILLSIDE)).toBe(getDatabaseFilenameForNode(RIVERSIDE));
        expect(homeAnswerStoreKey(PK, HILLSIDE)).toBe(homeAnswerStoreKey(PK, RIVERSIDE));
        expect(toolCommunityKey(HILLSIDE)).toBe(toolCommunityKey(RIVERSIDE));
        expect(usingOf(RIVERSIDE)).toBe(HILLSIDE);
        resetCommunityIndexForTests();
        expect(toolCommunityKey(HILLSIDE)).not.toBe(toolCommunityKey(RIVERSIDE));
    });
});

describe('boot order: the records load before any copy is named or opened', () => {
    it('the copies\' rename (which every open and cursor read waits for) waits for the records', async () => {
        let release!: () => void;
        h.holdRecords = new Promise<void>((r) => { release = r; });
        h.store.set('beanpool_anchor_url', RIVERSIDE);
        const renamed = communityCachesRenamed();
        await new Promise((r) => setTimeout(r, 10));
        expect(h.reads).toContain(COMMUNITY_RECORDS_STORE_KEY);
        expect(h.reads).not.toContain(CACHE_NAMES_DONE_KEY);
        expect(communityIndexLoaded()).toBe(false);
        release();
        await renamed;
        expect(communityIndexLoaded()).toBe(true);
        expect(h.reads.indexOf(COMMUNITY_RECORDS_STORE_KEY)).toBeLessThan(h.reads.indexOf(CACHE_NAMES_DONE_KEY));
    });

    it('getDb waits for the copies\' rename before it names the file (db.ts)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8');
        const body = src.slice(src.indexOf('export async function getDb()'));
        const wait = body.indexOf('await communityCachesRenamed();');
        const named = body.indexOf('getDatabaseFilenameForNode(url)');
        expect(wait).toBeGreaterThan(-1);
        expect(named).toBeGreaterThan(wait);
    });
});
