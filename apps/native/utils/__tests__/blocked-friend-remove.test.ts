// @vitest-environment jsdom
/**
 * "Also remove from friends" on Settings → Manage Blocked Users (components/BlockedFriendRemove.tsx), rendered for real,
 * over the phone's real friends table (utils/db.ts on an in-memory SQLite, as nearby-keep-db.test.ts does) and its real
 * block list (utils/blocklist.ts over an in-memory AsyncStorage). A block does not end a friendship (#1913, measured by
 * the Argon shadow), and a block made in the phone app stays on the phone: the node never hears of it, and still has
 * them as your friend. This ends it in one step:
 *   - offered only for someone blocked who is still your friend;
 *   - removing goes through the same friend route as any removal (POST /api/friends/remove, signed) and keeps the block;
 *   - a removal the node did not take is said, and nothing is removed here; a node with no such friend has none to remove.
 * React Native's host components are plain tags in react-dom, as added-you-phone-block-render.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted: the identity mock is read while the modules load (the block list's start-up move).
const ME = vi.hoisted(() => 'c'.repeat(64));
const HARASSER = 'ee'.repeat(32);
const NEIGHBOUR = 'dd'.repeat(32);
const ANCHOR = 'https://test.beanpool.example';

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));

const alerts = vi.hoisted(() => ({ last: null as null | { title: string; body: string; buttons: { text: string; onPress?: () => void }[] } }));
vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Alert: { alert: (title: string, body: string, buttons: any[]) => { alerts.last = { title, body, buttons }; } },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }), emit: () => {} },
    };
});
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
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
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, privateKey: 'me-priv', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));
// Signed as any request is: the test reads which request was signed, not the signature (request-signing has its own).
const signed = vi.hoisted(() => [] as { method: string; url: string; body: string; publicKey: string }[]);
vi.mock('../crypto', async (orig) => ({
    ...(await orig<typeof import('../crypto')>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string, _priv: string, publicKey: string) => {
        signed.push({ method, url, body, publicKey });
        return { 'X-BeanPool-Test-Signed': '1' };
    }),
}));
// A block here sends no report (no reporter is named), so the block itself reaches no node.
vi.mock('../node-post', () => ({ signedPost: vi.fn(async () => { throw new Error('no node for a block in this test'); }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});

import { BlockedFriendRemove, BLOCKED_FRIEND_NOTE, BLOCKED_FRIEND_REMOVED } from '../../components/BlockedFriendRemove';
import { getDb, isFriendLocal } from '../db';
import { blockUser, clearBlocklist, getBlockedUsers } from '../blocklist';

// The node: what it was asked, and how it answers POST /api/friends/remove.
const node = vi.hoisted(() => ({ calls: [] as { url: string; method: string; body: string }[], answer: 'ok' as 'ok' | 'offline' | 'no-such-friend' }));
const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    node.calls.push({ url, method: String(init?.method), body: String(init?.body ?? '') });
    if (node.answer === 'offline') throw new TypeError('Network request failed');
    if (node.answer === 'no-such-friend') {
        return new Response(JSON.stringify({ error: 'Failed to remove friend — friend relationship not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

let host: HTMLDivElement;
let root: Root;
async function settle() {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function draw(pubkey: string, callsign: string) {
    await act(async () => { root.render(createElement(BlockedFriendRemove, { myKey: ME, pubkey, callsign }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const shown = () => host.textContent ?? '';
const removeButton = (callsign: string) => host.querySelector(`[aria-label="Also remove ${callsign} from friends"]`) as HTMLElement | null;
async function pressRemoveAndConfirm(callsign: string) {
    await act(async () => { removeButton(callsign)!.click(); });
    expect(alerts.last?.body).toBe(`${callsign} stays blocked and is no longer your friend. They can notice a removal.`);
    await act(async () => { alerts.last!.buttons.find(b => b.text === 'Remove')!.onPress!(); });
    await settle();
}
async function befriend(friend: string) {
    const db = await getDb();
    await db.runAsync('INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)', [ME, friend, '2026-10-01T00:00:00.000Z']);
}

beforeEach(async () => {
    mem.async.set('beanpool_anchor_url', ANCHOR);
    vi.stubGlobal('fetch', fetchStub);
    node.calls = [];
    node.answer = 'ok';
    signed.length = 0;
    alerts.last = null;
    await clearBlocklist();
    const db = await getDb();
    await db.runAsync('DELETE FROM friends');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
});

describe('Manage Blocked Users: Also remove from friends (phone)', () => {
    it('is offered only for someone blocked who is still your friend', async () => {
        await blockUser(HARASSER);
        await blockUser(NEIGHBOUR);
        await befriend(HARASSER);

        await draw(NEIGHBOUR, 'Neighbour');
        expect(removeButton('Neighbour')).toBeNull();
        expect(shown()).toBe('');

        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await draw(HARASSER, 'Harasser');
        expect(removeButton('Harasser')).not.toBeNull();
        expect(shown()).toContain(BLOCKED_FRIEND_NOTE);
        expect(shown()).toContain('Also remove from friends');
    });

    it('a phone-only block removes the friend through the same friend route, and the block stays', async () => {
        await blockUser(HARASSER);
        await befriend(HARASSER);
        await draw(HARASSER, 'Harasser');
        // The block was the phone's alone: nothing went to the node for it.
        expect(node.calls).toEqual([]);

        await pressRemoveAndConfirm('Harasser');

        expect(node.calls).toHaveLength(1);
        expect(node.calls[0].method).toBe('POST');
        expect(node.calls[0].url).toBe(`${ANCHOR}/api/friends/remove`);
        expect(JSON.parse(node.calls[0].body)).toEqual({ ownerPubkey: ME, friendPubkey: HARASSER });
        expect(signed).toEqual([expect.objectContaining({ method: 'POST', url: `${ANCHOR}/api/friends/remove`, publicKey: ME })]);
        expect(await isFriendLocal(ME, HARASSER)).toBe(false);
        expect(await getBlockedUsers()).toEqual([HARASSER]);
        expect(shown()).toContain(BLOCKED_FRIEND_REMOVED);
        expect(removeButton('Harasser')).toBeNull();
    });

    it('Cancel removes nothing; a removal the node did not take is said, and they are still your friend here', async () => {
        await blockUser(HARASSER);
        await befriend(HARASSER);
        await draw(HARASSER, 'Harasser');

        await act(async () => { removeButton('Harasser')!.click(); });
        expect(alerts.last!.buttons.map(b => b.text)).toEqual(['Cancel', 'Remove']);
        expect(node.calls).toEqual([]);

        node.answer = 'offline';
        await pressRemoveAndConfirm('Harasser');
        expect(node.calls).toHaveLength(1);
        expect(shown()).toContain('Couldn’t reach your community, so they are still your friend. Check your connection and try again.');
        expect(await isFriendLocal(ME, HARASSER)).toBe(true);
        expect(removeButton('Harasser')).not.toBeNull();
        expect(shown()).not.toContain(BLOCKED_FRIEND_REMOVED);
        expect(await getBlockedUsers()).toEqual([HARASSER]);
    });

    it('a friend the node never had (kept on this phone alone) is removed here', async () => {
        await blockUser(HARASSER);
        await befriend(HARASSER);
        node.answer = 'no-such-friend';
        await draw(HARASSER, 'Harasser');
        await pressRemoveAndConfirm('Harasser');
        expect(node.calls.map(c => c.url)).toEqual([`${ANCHOR}/api/friends/remove`]);
        expect(await isFriendLocal(ME, HARASSER)).toBe(false);
        expect(shown()).toContain(BLOCKED_FRIEND_REMOVED);
        expect(await getBlockedUsers()).toEqual([HARASSER]);
    });
});
