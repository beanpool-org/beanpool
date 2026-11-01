// @vitest-environment jsdom
/**
 * The BeanPool sheet's Remove (utils/use-communities.ts `remove`), rendered for real with react-dom in jsdom: the hook, the
 * phone's storage code and the real goodbye (utils/account-leaves-phone.ts `forgetCommunityPush`), against a fake community
 * per address (fake-communities.ts). Nothing contacts a node.
 *
 * The row of the community in use comes off the list and the phone stays set to it, so its alerts stay. That guard
 * compared the address as spelled while Forget goes by the community, and two spellings of one community can be on the
 * list: a pasted `https://x.org/` stays as typed, and a later invite join strips the slash, which `getDb` saves as a second
 * row. The duplicate is exactly the row a member would remove, and removing it told the community in use to drop the
 * token: no alerts from it, recovery alerts included, until the next return (#2701, deciding review 4434518917).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const who = vi.hoisted(() => ({ identity: null as unknown }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: { alert: (_title: string, _body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => { alerts.buttons.push(...(buttons ?? [])); } },
}));
vi.mock('expo-router', () => ({ router: { replace() {}, canDismiss: () => false, dismissAll() {} } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn(), getLastSyncTime: vi.fn(async () => null) }));

import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { registerPushTokenWithCommunity } from '../push-registrations';
import { useCommunities } from '../use-communities';
import { Communities, PHONE_TOKEN } from './fake-communities';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';

let kim: BeanPoolIdentity;
let nodes: Communities;

const saved = (...urls: string[]) => { mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(urls.map((url) => ({ url })))); };
const savedNow = () => (JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]') as Array<{ url: string }>).map((n) => n.url);
const deletes = () => nodes.sent.filter((s) => s.method === 'DELETE').map((s) => s.community);

/** The sheet drawn, and the member removing the row at `url`. */
async function removeRow(url: string): Promise<void> {
    const { result } = renderHook(() => useCommunities());
    await waitFor(() => expect(result.current.rows.map((r) => r.url)).toContain(url));
    act(() => result.current.remove(result.current.rows.find((r) => r.url === url)!));
    const remove = alerts.buttons.find((b) => b.text === 'Remove')!;
    await act(async () => { await remove.onPress?.(); });
}

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    alerts.buttons.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kim = await draftIdentity('Kim');
    who.identity = kim;
    nodes = new Communities();
    await importIdentity(kim);
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    for (const community of [BYRON, MULLUM]) {
        mem.async.set(ANCHOR, community);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
    }
    nodes.sent.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Remove on the sheet', () => {
    it('a second spelling of the community in use takes the row and leaves the alerts: nothing is sent to it', async () => {
        saved(MULLUM, `${MULLUM}/`, BYRON);

        await removeRow(`${MULLUM}/`);

        expect(deletes()).toEqual([]);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(savedNow()).toEqual([MULLUM, BYRON]);
    });

    it('the phone set to the slashed spelling, and the plain row removed: the same', async () => {
        mem.async.set(ANCHOR, `${MULLUM}/`);
        saved(MULLUM, `${MULLUM}/`, BYRON);

        await removeRow(MULLUM);

        expect(deletes()).toEqual([]);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
    });

    it('another community is told, as ever', async () => {
        saved(MULLUM, BYRON);

        await removeRow(BYRON);

        expect(deletes()).toEqual([BYRON]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(savedNow()).toEqual([MULLUM]);
    });
});
