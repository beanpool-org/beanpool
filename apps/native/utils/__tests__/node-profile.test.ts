/**
 * What kind of node a community is (utils/node-profile.ts): the profile and features it reports, kept per node,
 * the global community's door check, and the tabs a node with Beans off hides.
 *
 * Nothing here contacts a node: every answer comes from a fetch stub, and anything else it is asked fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => store.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    },
}));

import {
    GLOBAL_NODE_URL,
    GLOBAL_DOOR_MESSAGES,
    readNodeProfile,
    fetchNodeProfile,
    getCachedNodeProfile,
    checkGlobalDoor,
    hiddenTabsFor,
    beansOn,
} from '../node-profile';

const GLOBAL_INFO = {
    memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0,
    currency: { type: 'image', value: 'bean' },
    profile: 'global',
    features: {
        beans: false, escrow: false, enterprises: false, openJoin: true, knocks: false,
        distanceSearch: true, probation: true, autoHideReports: true, autoMute: true,
    },
};
const LOCAL_INFO = { ...GLOBAL_INFO, profile: 'local', features: { ...GLOBAL_INFO.features, beans: true, openJoin: false } };

function answering(byUrl: Record<string, { status: number; body?: unknown } | 'offline'>) {
    return vi.fn(async (input: any) => {
        const url = String(input);
        const a = byUrl[url];
        if (!a || a === 'offline') throw new TypeError(`Network request failed: ${url}`);
        return {
            ok: a.status >= 200 && a.status < 300,
            status: a.status,
            json: async () => a.body,
        } as unknown as Response;
    });
}

beforeEach(() => {
    store.clear();
});

describe('the global community', () => {
    it('is global.beanpool.org', () => {
        expect(GLOBAL_NODE_URL).toBe('https://global.beanpool.org');
    });
});

describe('readNodeProfile', () => {
    it('reads the profile and features a node reports', () => {
        const p = readNodeProfile(GLOBAL_INFO, new Date('2026-09-26T00:00:00Z'))!;
        expect(p.profile).toBe('global');
        expect(p.features).toMatchObject({ beans: false, openJoin: true, distanceSearch: true });
        expect(p.checkedAt).toBe('2026-09-26T00:00:00.000Z');
    });

    it('reads a node that says nothing about its profile as local, with no features (every node before G0)', () => {
        const p = readNodeProfile({ memberCount: 12, currency: { type: 'image', value: 'bean' } })!;
        expect(p.profile).toBe('local');
        expect(p.features).toEqual({});
    });

    it('makes only the exact word "global" global', () => {
        for (const profile of ['GLOBAL', 'Global ', 'glob', 'open', 1, true, null]) {
            expect(readNodeProfile({ profile })!.profile).toBe('local');
        }
    });

    it('keeps only true and false from the features', () => {
        const p = readNodeProfile({ profile: 'global', features: { beans: 'false', openJoin: 1, knocks: false, bogus: true } })!;
        expect(p.features).toEqual({ knocks: false });
    });

    it('is null for an answer that is not an info answer', () => {
        expect(readNodeProfile(null)).toBeNull();
        expect(readNodeProfile('global')).toBeNull();
        expect(readNodeProfile([GLOBAL_INFO])).toBeNull();
    });
});

describe('fetchNodeProfile and the per-node cache', () => {
    it('asks /api/community/info and keeps the answer for that node', async () => {
        const fetchImpl = answering({ 'https://mullum.beanpool.org/api/community/info': { status: 200, body: LOCAL_INFO } });
        const fetched = await fetchNodeProfile('https://mullum.beanpool.org', fetchImpl as any);
        expect(fetched?.profile).toBe('local');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const cached = await getCachedNodeProfile('https://mullum.beanpool.org');
        expect(cached?.profile).toBe('local');
        expect(cached?.features.beans).toBe(true);
    });

    it('keeps one entry per node, whatever the spelling of its address', async () => {
        const fetchImpl = answering({ 'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO } });
        await fetchNodeProfile('https://global.beanpool.org/', fetchImpl as any);
        expect((await getCachedNodeProfile('https://GLOBAL.beanpool.org'))?.profile).toBe('global');
        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.features.beans).toBe(false);
    });

    it('keeps each node apart', async () => {
        const fetchImpl = answering({
            'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO },
            'https://mullum.beanpool.org/api/community/info': { status: 200, body: LOCAL_INFO },
        });
        await fetchNodeProfile('https://global.beanpool.org', fetchImpl as any);
        await fetchNodeProfile('https://mullum.beanpool.org', fetchImpl as any);
        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.profile).toBe('global');
        expect((await getCachedNodeProfile('https://mullum.beanpool.org'))?.profile).toBe('local');
    });

    it('leaves what it knew alone when the node cannot be asked, and says it could not', async () => {
        const good = answering({ 'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO } });
        await fetchNodeProfile('https://global.beanpool.org', good as any);

        const offline = answering({ 'https://global.beanpool.org/api/community/info': 'offline' });
        expect(await fetchNodeProfile('https://global.beanpool.org', offline as any)).toBeNull();
        const failing = answering({ 'https://global.beanpool.org/api/community/info': { status: 502, body: {} } });
        expect(await fetchNodeProfile('https://global.beanpool.org', failing as any)).toBeNull();

        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.profile).toBe('global');
    });

    it('knows nothing about a node it never asked', async () => {
        expect(await getCachedNodeProfile('https://castlemaine.beanpool.org')).toBeNull();
        expect(await getCachedNodeProfile(null)).toBeNull();
    });
});

describe('checkGlobalDoor: refused unless the node says it is the global community, with its door open', () => {
    const INFO = `${GLOBAL_NODE_URL}/api/community/info`;

    it('lets a member through to the door of the global community', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: GLOBAL_INFO } }) as any);
        expect(check.ok).toBe(true);
    });

    it('refuses a node that is not global, so a stale build can never open-join a local community', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: LOCAL_INFO } }) as any);
        expect(check).toEqual({ ok: false, reason: 'not_global' });
    });

    it('refuses a node that says nothing about its profile', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: { memberCount: 1 } } }) as any);
        expect(check).toEqual({ ok: false, reason: 'not_global' });
    });

    it('says the door is shut when the global community is not taking members', async () => {
        const shut = { ...GLOBAL_INFO, features: { ...GLOBAL_INFO.features, openJoin: false } };
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: shut } }) as any))
            .toEqual({ ok: false, reason: 'door_closed' });
        const unsaid = { ...GLOBAL_INFO, features: { beans: false } };
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: unsaid } }) as any))
            .toEqual({ ok: false, reason: 'door_closed' });
    });

    it('says it cannot reach the global community, even when this phone once heard it was open', async () => {
        await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: GLOBAL_INFO } }) as any);
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: 'offline' }) as any))
            .toEqual({ ok: false, reason: 'unreachable' });
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 503, body: {} } }) as any))
            .toEqual({ ok: false, reason: 'unreachable' });
    });

    it('always leaves invites as the way in when it refuses', () => {
        expect(GLOBAL_DOOR_MESSAGES.unreachable).toMatch(/try again, or join with an invite/i);
        expect(GLOBAL_DOOR_MESSAGES.not_global).toMatch(/invite/);
        expect(GLOBAL_DOOR_MESSAGES.door_closed).toMatch(/invite/);
    });
});

describe('the tabs a node hides', () => {
    it('hides Commons and Ledger where Beans are off', () => {
        expect(hiddenTabsFor({ beans: false })).toEqual(['projects', 'ledger']);
        expect(beansOn({ beans: false })).toBe(false);
    });

    it('hides nothing where Beans are on, or where the node does not say', () => {
        expect(hiddenTabsFor({ beans: true })).toEqual([]);
        expect(hiddenTabsFor({})).toEqual([]);
        expect(hiddenTabsFor(null)).toEqual([]);
        expect(hiddenTabsFor(undefined)).toEqual([]);
        expect(beansOn(undefined)).toBe(true);
    });

    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'), 'utf-8');

    it('the tab bar takes Commons and Ledger off the strip from the node\'s features', () => {
        const src = layout();
        expect(src).toMatch(/hiddenTabsFor\(/);
        expect(src).toMatch(/name="projects"\s*options=\{\{\s*\.\.\.\(hiddenTabs\.includes\('projects'\) \? \{ href: null \} : \{\}\)/);
        expect(src).toMatch(/name="ledger"\s*options=\{\{\s*\.\.\.\(hiddenTabs\.includes\('ledger'\) \? \{ href: null \} : \{\}\)/);
    });

    it('leaves every other tab as it was', () => {
        const src = layout();
        for (const tab of ['index', 'map', 'chats', 'pulse']) {
            const at = src.indexOf(`name="${tab}"`);
            expect(at).toBeGreaterThan(-1);
            expect(src.slice(at, at + 200)).not.toMatch(/hiddenTabs/);
        }
    });
});
