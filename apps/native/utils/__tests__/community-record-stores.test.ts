/**
 * Every store in storage-keys.ts says how it is kept per community, and every one kept per community goes through the
 * community's record (scratch/fable-design/DESIGN-several-addresses-fable.md §3.1, slice S3): so a new store can't skip
 * it. The walk reads every export of storage-keys.ts; one this table doesn't name fails, and so does a table row for an
 * export that is gone.
 *
 * - `key`: the address is part of the key, built in storage-keys.ts. Asked with an address a record proved as another of
 *   its own, it must give the record's key, and without that record another key (so the check can fail).
 * - `file`: kept per community file, whose name nodes.ts getDatabaseFilenameForNode gives through the record.
 * - `value`: the address is inside the value, or appended where it is read and written. Exactly the modules named may
 *   touch it, each through community-index.ts `communityKeyOf`; `wipe` modules only remove it whole.
 * - `notYet`: kept per community by address, not yet through the record: the second part of slice S3 (its PR body says
 *   which). This list may only shrink.
 * - `phone`: not kept per community (the phone's, or an account's), or the records themselves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as keys from '../storage-keys';
import { makeCommunityRecord, resetCommunityIndexForTests, setCommunityIndex } from '../community-index';
import { getDatabaseFilenameForNode } from '../nodes';

type Kind =
    | { kind: 'key' }
    | { kind: 'file' }
    | { kind: 'value'; modules: string[]; wipe?: string[] }
    | { kind: 'notYet' }
    | { kind: 'phone' };

const PHONE: Kind = { kind: 'phone' };
const KEY: Kind = { kind: 'key' };
const FILE: Kind = { kind: 'file' };
const NOT_YET: Kind = { kind: 'notYet' };

const STORES: Record<string, Kind> = {
    COMMUNITY_RECORDS_STORE_KEY: PHONE,
    NOTIFICATION_PERMISSION_STORE_KEY: PHONE,
    KNOCK_KEY_STORE_KEY: PHONE,
    QUESTIONS_OPENED_STORE_KEY: PHONE,
    TYPED_PLACE_STORE_KEY: PHONE,
    CANONICAL_PROFILE_STORE_KEY: PHONE,
    PENDING_ABUSE_REPORTS_STORE_KEY: PHONE,
    blockedUsersStoreKey: PHONE,
    MESSAGE_REQUESTS_STORE_PREFIX: PHONE,
    PUSH_TOKEN_STORE_KEY: PHONE,
    PUSH_STAMP_STORE_KEY: PHONE,
    IDENTITY_THIS_DEVICE_STORE_KEY: PHONE,
    VAULT_RESTORE_STORE_KEY: PHONE,
    COMMUNITY_RESTORE_STORE_KEY: PHONE,
    vaultMoveLaterStoreKey: PHONE,
    vaultMoveUnfinishedStoreKey: PHONE,
    vaultPushTokenStoreKey: PHONE,
    vaultConnectWantedStoreKey: PHONE,
    vaultCopyKnownStoreKey: PHONE,
    vaultApprovedHoldsStoreKey: PHONE,
    wordsWrittenDownStoreKey: PHONE,
    copyListsCommunitiesStoreKey: PHONE,
    oneWayBackAskedStoreKey: PHONE,
    HOME_STORE_PREFIX: PHONE,
    FAV_CATEGORIES_STORE_KEY: PHONE,
    homeRevealStoreKey: PHONE,
    homeHintStoreKey: PHONE,
    homeTipsStoreKey: PHONE,

    homeAnswerStoreKey: KEY,
    homeLayoutStoreKey: KEY,
    homeLayoutPhoneOnlyStoreKey: KEY,
    homeLayoutPhoneOnlySentStoreKey: KEY,
    homeInterestsOwedStoreKey: KEY,

    messageRequestsStoreKey: FILE,
    dmPeerPinsStoreKey: FILE,
    dmPeerPinsSetAsideStoreKey: FILE,
    dmConversationsSeenStoreKey: FILE,
    dmConversationsSeenSetAsideStoreKey: FILE,
    dmLinesAtUpdateStoreKey: FILE,
    PER_FILE_STORE_KEYS: FILE,

    copiesRuleSeenStoreKey: { kind: 'value', modules: ['utils/copies-rule.ts'] },
    wordsKeptOwedStoreKey: { kind: 'value', modules: ['utils/words-kept.ts'] },
    PENDING_PROFILE_STORE_PREFIX: { kind: 'value', modules: ['utils/pending-profile-sync.ts'], wipe: ['utils/identity.ts'] },
    PENDING_PROFILE_REFUSAL_STORE_PREFIX: { kind: 'value', modules: ['utils/pending-profile-sync.ts'] },
    PENDING_ARCHETYPE_STORE_PREFIX: { kind: 'value', modules: ['utils/pending-profile-sync.ts'] },

    // The second part of S3: each holds community addresses that are also where requests went, so each splits into the
    // record's key for storage and `using` for the network.
    SAVED_NODES_STORE_KEY: NOT_YET,
    PUSH_PINS_STORE_KEY: NOT_YET,
    NOTICE_COUNTS_STORE_KEY: NOT_YET,
    UNREAD_ROUNDS_STORE_KEY: NOT_YET,
    PUSH_REGISTERED_AT_STORE_KEY: NOT_YET,
    PUSH_REGISTRATIONS_DUE_STORE_KEY: NOT_YET,
    PUSH_ALERTS_OFF_STORE_KEY: NOT_YET,
    PUSH_LEAVES_OWED_STORE_KEY: NOT_YET,
    PUSH_LEAVE_STATEMENTS_STORE_KEY: NOT_YET,
    communityBlocksStoreKey: NOT_YET,
    pendingAbuseReportsStoreKey: NOT_YET,
    ADMIN_KNOCKS_COUNT_STORE_KEY: NOT_YET,
    KNOCK_ROLE_STORE_KEY: NOT_YET,
    KNOCKS_STORE_KEY: NOT_YET,
    BRING_LISTINGS_STORE_KEY: NOT_YET,
    SHOWN_ON_GLOBAL_STORE_KEY: NOT_YET,
    LISTING_AFTER_JOIN_STORE_KEY: NOT_YET,
    oneWayBackStoreKey: NOT_YET,
};

/** The stores left for the second part, as this slice leaves them. A store may leave this list; none may join it. */
const NOT_YET_AT_THIS_SLICE = 18;

const FIRST = 'https://riverside.example';
const SECOND = 'https://second.riverside.example';
const PK = 'cd'.repeat(32);

const NATIVE = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sources(path, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
    }
    return out;
}

const ALL_SOURCES = ['utils', 'services', 'app', 'components', 'hooks', 'tools', 'contexts']
    .map((d) => join(NATIVE, d))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .flatMap((d) => sources(d))
    .map((path) => ({ rel: relative(NATIVE, path), text: readFileSync(path, 'utf8') }));

beforeEach(() => resetCommunityIndexForTests());

/** An index where SECOND is a proved address of the record made at FIRST (what slice S4 writes). */
function provedSecond() {
    setCommunityIndex([{ ...makeCommunityRecord(FIRST), using: SECOND, proved: { [SECOND]: { at: 1 } } }]);
}

describe('every store in storage-keys.ts says how it is kept per community', () => {
    const exported = Object.keys(keys).sort();

    it('the table names every export, and no export that is gone', () => {
        expect(exported.filter((name) => !(name in STORES)), 'a new store: say in this table how it goes through the record').toEqual([]);
        expect(Object.keys(STORES).filter((name) => !exported.includes(name)).sort()).toEqual([]);
    });

    it('the stores not yet through the record only shrink', () => {
        const notYet = Object.entries(STORES).filter(([, k]) => k.kind === 'notYet').map(([n]) => n);
        expect(notYet.length).toBeLessThanOrEqual(NOT_YET_AT_THIS_SLICE);
    });

    for (const [name, kind] of Object.entries(STORES)) {
        if (kind.kind === 'key') {
            it(`${name}: keyed by the record`, () => {
                const make = (keys as Record<string, unknown>)[name] as (pk: string, url: string) => string;
                expect(make(PK, SECOND), 'without a record, two addresses are two keys').not.toBe(make(PK, FIRST));
                provedSecond();
                expect(make(PK, SECOND), `${name} bypasses the record`).toBe(make(PK, FIRST));
            });
        }
        if (kind.kind === 'file') {
            it(`${name}: per file, and the file goes through the record`, () => {
                const value = (keys as Record<string, unknown>)[name];
                const fns = Array.isArray(value) ? value : [value];
                for (const fn of fns) {
                    expect(typeof fn).toBe('function');
                    // (publicKey, file): the second argument is the community's file, never an address.
                    expect(String(fn).replace(/\s+/g, ' ')).toMatch(/^function \w+\(publicKey, file\)/);
                }
                expect(getDatabaseFilenameForNode(SECOND)).not.toBe(getDatabaseFilenameForNode(FIRST));
                provedSecond();
                expect(getDatabaseFilenameForNode(SECOND)).toBe(getDatabaseFilenameForNode(FIRST));
            });
        }
        if (kind.kind === 'value') {
            it(`${name}: only the modules named touch it, through the record`, () => {
                const word = new RegExp(`\\b${name}\\b`);
                const touching = ALL_SOURCES.filter((s) => s.rel !== 'utils/storage-keys.ts' && word.test(s.text)).map((s) => s.rel).sort();
                expect(touching, `a module touches ${name} that this table doesn't name`).toEqual([...kind.modules, ...(kind.wipe ?? [])].sort());
                for (const rel of kind.modules) {
                    const text = ALL_SOURCES.find((s) => s.rel === rel)!.text;
                    expect(text, `${rel} keeps ${name} without the record`).toMatch(/import \{[^}]*\bcommunityKeyOf\b[^}]*\} from '\.\/community-index'/);
                }
            });
        }
    }
});
