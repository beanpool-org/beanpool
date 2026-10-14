// @vitest-environment jsdom
/**
 * The People tab's "added you" lines (components/AddedYouLines.tsx) rendered for real, against the phone's own block list
 * (utils/blocklist.ts, real, over an in-memory AsyncStorage). A block made in the phone app stays on that phone and the
 * node never hears of it (guide settings/blocking.md), so the node's own filter (server engine/friends-added-you.ts) can't
 * leave them out. The phone does, as its People lists do (#1913 review, finding 2):
 *   - someone blocked on this phone is never drawn, and Add back is never offered for them;
 *   - blocking someone while their line shows takes it away at once (BLOCKLIST_UPDATED_EVENT); unblocking brings it back.
 * React Native's host components are plain tags in react-dom, as enterprise-decisions-render.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'c'.repeat(64);
const HARASSER = 'ee'.repeat(32);
const NEIGHBOUR = 'dd'.repeat(32);

// One emitter for the whole app, as React Native's DeviceEventEmitter is.
const events = vi.hoisted(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        listeners,
        addListener: (name: string, fn: (...args: unknown[]) => void) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(fn);
            return { remove: () => { listeners.get(name)?.delete(fn); } };
        },
        emit: (name: string, ...args: unknown[]) => { listeners.get(name)?.forEach((fn) => fn(...args)); },
    };
});
vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Alert: { alert: vi.fn() },
        DeviceEventEmitter: { addListener: events.addListener, emit: events.emit },
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
// The account on this phone. A block here sends no report (no reporter is named), so nothing reaches a node.
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME, callsign: 'Me' }) }));
vi.mock('../node-post', () => ({ signedPost: vi.fn(async () => { throw new Error('no node in this test'); }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: () => h('span', { 'data-avatar': 'true' }) };
});
// The node: who added this member, as GET /api/friends/added-you answers. It knows nothing of a block made on the phone.
const node = vi.hoisted(() => ({ addedYou: [] as { publicKey: string; callsign: string; avatarUrl: null; addedAt: string }[], more: 0, reads: 0 }));
vi.mock('../db', () => ({
    fetchAddedYou: vi.fn(async () => { node.reads += 1; return { addedYou: node.addedYou, more: node.more }; }),
    addFriendLocal: vi.fn(async () => { }),
}));

import { AddedYouLines } from '../../components/AddedYouLines';
import { blockUser, unblockUser, clearBlocklist, getBlockedUsers } from '../blocklist';

const line = (publicKey: string, callsign: string) => ({ publicKey, callsign, avatarUrl: null, addedAt: new Date().toISOString() });

let host: HTMLDivElement;
let root: Root;
async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function draw() {
    await act(async () => { root.render(createElement(AddedYouLines, { myKey: ME, onAddedBack: () => { } }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const shown = () => host.textContent ?? '';
const addBack = (callsign: string) => host.querySelector(`[aria-label="Add ${callsign} back"]`);

beforeEach(async () => {
    await clearBlocklist();
    node.addedYou = [line(HARASSER, 'Harasser'), line(NEIGHBOUR, 'Neighbour')];
    node.more = 0;
    node.reads = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

describe('AddedYouLines and the phone\'s own blocks', () => {
    it('draws everyone who added you when nobody is blocked', async () => {
        await draw();
        expect(shown()).toContain('Harasser added you');
        expect(shown()).toContain('Neighbour added you');
        expect(addBack('Harasser')).not.toBeNull();
    });

    it('never draws someone blocked on this phone, nor offers to add them back', async () => {
        expect(await blockUser(HARASSER)).toBe(true);
        expect(await getBlockedUsers()).toEqual([HARASSER]);
        await draw();
        expect(node.reads).toBeGreaterThan(0);
        expect(shown()).not.toContain('Harasser');
        expect(addBack('Harasser')).toBeNull();
        expect(shown()).toContain('Neighbour added you');
    });

    it('draws nothing at all when the only one who added you is blocked on this phone', async () => {
        node.addedYou = [line(HARASSER, 'Harasser')];
        await blockUser(HARASSER);
        await draw();
        expect(host.querySelector('[data-testid="added-you"]')).toBeNull();
        expect(shown()).toBe('');
    });

    it('takes a line away as soon as they are blocked on this phone, and brings it back on unblock', async () => {
        await draw();
        expect(shown()).toContain('Harasser added you');
        await act(async () => { await blockUser(HARASSER); });
        await settle();
        expect(shown()).not.toContain('Harasser');
        expect(shown()).toContain('Neighbour added you');
        await act(async () => { await unblockUser(HARASSER); });
        await settle();
        expect(shown()).toContain('Harasser added you');
    });
});
