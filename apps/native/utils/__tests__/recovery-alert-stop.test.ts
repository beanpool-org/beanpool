// @vitest-environment jsdom
/**
 * The owner's recovery banner (components/RecoveryAlertBanner.tsx) against a pile of strangers' sessions (PR #1456
 * deciding review). Strangers can open any number of sessions against a name, so the community sends the count and the
 * newest few, and one Stop takes them all. The banner must show the community's count, stop everything in ONE request,
 * and say "all cancelled" only when the community says nothing is left. Against a community from before, it stops them
 * one by one and still tells the truth.
 *
 * Rendered for real (react-dom in jsdom, React Native's host components as plain tags, as vault-status-no-poll.test.ts
 * does); the community is a stubbed signedRequest, and no vault is configured. Nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert } from 'react-native';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
        createElement(tag, onPress ? { onClick: onPress } : null, children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), TouchableOpacity: el('button'), ActivityIndicator: el('i'),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => {}),
    deleteItemAsync: vi.fn(async () => {}),
}));
const community = vi.hoisted(() => ({
    sent: [] as { path: string; body: any }[],
    mine: (() => ({ collections: [] })) as () => any,
    cancel: ((_: any) => ({})) as (body: any) => any,
}));
vi.mock('../db', () => ({
    signedRequest: vi.fn(async (path: string, body: any) => {
        community.sent.push({ path, body });
        if (path === '/api/recovery/collect/mine') return community.mine();
        if (path === '/api/recovery/collect/cancel') return community.cancel(body);
        throw new Error(`unexpected ${path}`);
    }),
}));
vi.mock('../LocalAuth', () => ({ authenticateUser: vi.fn(async () => true) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null }) }));

import { RecoveryAlertBanner } from '../../components/RecoveryAlertBanner';

/** What signedRequest throws for a refusal (utils/db.ts `_signedRequest`). */
const refused = (msg: string) => { throw new Error(msg); };
const listed = (n: number) => Array.from({ length: n }, (_, i) => ({
    collectionId: `c-${i}`, generation: 1, startedAt: new Date(Date.now() - i * 1000).toISOString(),
}));

let root: Root;
let host: HTMLElement;

beforeEach(() => {
    community.sent = [];
    vi.mocked(Alert.alert).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = document.createElement('div');
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
});

async function mount(): Promise<void> {
    await act(async () => { root.render(createElement(RecoveryAlertBanner) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

/** Press Stop It Now, confirm, and return the words the banner ends on. */
async function stop(): Promise<{ title: string; body: string }> {
    const button = Array.from(host.querySelectorAll('button')).find(b => /Stop It Now/.test(b.textContent ?? ''));
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
    const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    const go = (confirm[2] as { text: string; onPress?: () => Promise<void> }[]).find(b => b.text === 'Stop It Now')!;
    await act(async () => { await go.onPress!(); });
    const [title, body] = vi.mocked(Alert.alert).mock.calls.at(-1)! as [string, string];
    return { title, body };
}

const cancels = () => community.sent.filter(s => s.path === '/api/recovery/collect/cancel');

describe('Stop It Now against a pile of sessions', () => {
    it("shows the community's count, not how many it was sent, and stops all of them in one request", async () => {
        community.mine = () => ({ count: 2100, collections: listed(3) });
        community.cancel = () => ({ cancelled: true, stopped: 2100, live: 0 });
        await mount();
        expect(host.textContent).toMatch(/2100 active sessions/);

        const said = await stop();
        expect(cancels()).toEqual([{ path: '/api/recovery/collect/cancel', body: {} }]);
        expect(said.body).toBe('All active recovery sessions have been cancelled.');
        expect(host.textContent).not.toMatch(/active session/);
    });

    it('never says "all cancelled" when the community says some are still live', async () => {
        community.mine = () => ({ count: 40, collections: listed(3) });
        community.cancel = () => ({ cancelled: true, stopped: 36, live: 4 });
        await mount();
        const said = await stop();
        expect(said.body).not.toMatch(/All active recovery sessions have been cancelled/);
        expect(said).toEqual({ title: 'Not all stopped', body: '4 recovery sessions are still active. Tap Stop It Now again.' });
        expect(cancels().length).toBe(1);
    });

    it('a community from before one Stop: one request per session, and the words count the ones that failed', async () => {
        let n = 0;
        community.mine = () => ({ collections: listed(3) });
        community.cancel = (body) => {
            if (!body?.collectionId) return refused('Which session?');
            return ++n === 2 ? refused('Too many attempts. Try again in 30s') : { cancelled: true };
        };
        await mount();
        expect(host.textContent).toMatch(/3 active sessions/);
        const said = await stop();
        expect(cancels().map(c => c.body?.collectionId ?? null)).toEqual([null, 'c-0', 'c-1', 'c-2']);
        expect(said.body).toBe('1 recovery session is still active. Tap Stop It Now again.');
    });

    it('...and "all cancelled" there only when every one went through', async () => {
        community.mine = () => ({ collections: listed(2) });
        community.cancel = (body) => (body?.collectionId ? { cancelled: true } : refused('Which session?'));
        await mount();
        expect((await stop()).body).toBe('All active recovery sessions have been cancelled.');
    });
});
