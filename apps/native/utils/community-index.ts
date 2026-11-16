/**
 * One community, one record (scratch/fable-design/DESIGN-several-addresses-fable.md §3.1, slice S3): "which community is
 * this address?", answered from the records this phone keeps, with no import at run time, so storage-keys.ts and every store can ask
 * it without loading React Native. The records themselves are read and written by utils/community-record.ts, which loads
 * them here before any community's copy is opened (cache-file-migration.ts communityCachesRenamed).
 *
 * Storage goes through the record, the network through `using`. A community's file and every saved thing kept per
 * community are kept under the record's `id`; requests go to the record's `using`. A change of address (slice S4) writes
 * `using` and nothing else.
 *
 * The rule a record is made by is the rule an address is keyed by today: `id` is the address the phone first met the
 * community at, as written then. So an address no record holds is its own key, and an address a record was made at keys
 * exactly as before, in the spelling it is asked with. Only an address a record has PROVED as another of its own (S4) is
 * keyed by that record's id. In this slice nothing proves another address: every key is what it was.
 */

import type { SignedAddressList } from '@beanpool/core';
import type { AddressLineKind } from './address-decide';

/** One community on this phone. */
export interface CommunityRecord {
    v: 1;
    /** The name its file and saved things are kept under: the address the phone first met it at. Never changes. */
    id: string;
    /** The address requests go to now. The same as `id` until the community is followed by its key (S4). */
    using: string;
    /** Who it is, once known: its server key, community id and take-over count. */
    peerId?: string;
    communityId?: string;
    epoch?: number;
    /** Addresses that signed this phone's fresh question with the record's key (S4), with when and at which take-over count. */
    proved: Record<string, { at: number; epoch?: number }>;
    /** Addresses on the community's list that answered as something else (S4): never used. */
    refused: Record<string, { at: number; why: string }>;
    /** The newest valid signed list seen (S4, @beanpool/core address-list.ts), whole. */
    list?: SignedAddressList;
    /** The main address this phone last followed or stood on (utils/address-decide.ts: another one is new to it). */
    mainSeen?: string;
    /** The address in use not answering (utils/address-verify.ts): when the run of failed tries began, the latest, due now. */
    silent?: { since: number; last: number; due?: true };
    /** The one line Home shows after a move, until Home shows it (components/AddressLine.tsx). */
    line?: { kind: AddressLineKind; from: string; to: string; at: number };
}

/** One spelling of an address for the index: trimmed, no trailing slash, lower case. */
export function addressSpelling(address: string): string {
    return address.trim().replace(/\/+$/, '').toLowerCase();
}

let byOwn = new Map<string, CommunityRecord>();
let byProved = new Map<string, CommunityRecord>();
let byId = new Map<string, CommunityRecord>();
let loaded = false;

/** The records loaded (community-record.ts): the index is built from them, in full, each time. */
export function setCommunityIndex(records: readonly CommunityRecord[]): void {
    byOwn = new Map();
    byProved = new Map();
    byId = new Map();
    for (const record of records) {
        byId.set(record.id, record);
        byOwn.set(addressSpelling(record.id), record);
    }
    for (const record of records) {
        for (const address of [record.using, ...Object.keys(record.proved)]) {
            const spelling = addressSpelling(address);
            if (!byOwn.has(spelling) && !byProved.has(spelling)) byProved.set(spelling, record);
        }
    }
    loaded = true;
}

/** Whether the records are in the index yet (community-record.ts loads them once per app start). */
export function communityIndexLoaded(): boolean {
    return loaded;
}

/**
 * The name `address`'s community keeps its file and saved things under: the address itself when a record was made at it
 * or none holds it (the rule a record is made by), else the id of the record that proved it as one of its own.
 */
export function communityKeyOf(address: string): string {
    const spelling = addressSpelling(address);
    if (byOwn.has(spelling)) return address;
    return byProved.get(spelling)?.id ?? address;
}

/** The address requests for the community kept under `key` go to: its record's `using`, else `key` itself. */
export function usingOf(key: string): string {
    return byId.get(key)?.using ?? byOwn.get(addressSpelling(key))?.using ?? key;
}

/** The record `address` belongs to, or null when none holds it. */
export function communityRecordOf(address: string): CommunityRecord | null {
    const spelling = addressSpelling(address);
    return byOwn.get(spelling) ?? byProved.get(spelling) ?? null;
}

/** Whether two addresses are one community on this phone: one record holds both (its id, `using` or a proved address). */
export function sameCommunityRecord(a: unknown, b: unknown): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const r = communityRecordOf(a);
    return !!r && r === communityRecordOf(b);
}

/** Whether `record` holds `address`: as its id, its `using` or an address it proved. */
export function recordHolds(record: CommunityRecord, address: string): boolean {
    const spelling = addressSpelling(address);
    return [record.id, record.using, ...Object.keys(record.proved)].some((a) => addressSpelling(a) === spelling);
}

/**
 * The one way a record is made, the same on a new install and on a phone updated from a build before records: around the
 * address the phone met the community at, so its file and keys are already where the record expects them. Nothing is
 * renamed, copied or moved. `identity`: who the community is, when the phone already knows.
 */
export function makeCommunityRecord(address: string, identity?: { peerId: string; communityId: string; epoch: number } | null): CommunityRecord {
    return {
        v: 1,
        id: address,
        using: address,
        ...(identity ? { peerId: identity.peerId, communityId: identity.communityId, epoch: identity.epoch } : {}),
        proved: {},
        refused: {},
    };
}

/** Tests only: forget the index, as a cold start does. */
export function resetCommunityIndexForTests(): void {
    byOwn = new Map();
    byProved = new Map();
    byId = new Map();
    loaded = false;
}
