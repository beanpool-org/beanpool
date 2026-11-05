// @vitest-environment jsdom
/**
 * The one Share button's sheet (components/SharePost.tsx ShareButton, components/ShareSheet.tsx; DP2) holds while a share is
 * being made: Share with members while the phone's share sheet is up, Share outside the community while the community makes
 * the link, Make the invite and share while it makes the invite. Cancel (drawn dimmed), the backdrop and Android Back do
 * nothing then, so the phone's share sheet never opens after the member closed ours (Android), nor tries to while ours is
 * fading out (iOS: it would never answer and the item would stay dimmed). Once the share has answered, the sheet closes.
 * The real components over a fake node: each request waits until the test lets it answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const ctl = vi.hoisted(() => ({
    features: null as any,
    // What the phone's share sheet was handed, and whether our sheet was still up at that moment.
    shared: [] as Array<{ message: string; sheetUp: boolean }>,
    share: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
    peek: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
    invite: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
    // Each request the invite made: its signal, to tell a request given up from one left running.
    inviteFetches: [] as Array<{ signal?: AbortSignal }>,
}));
function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        // A disabled Pressable takes no press, as on the phone.
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.disabled !== undefined) attrs['aria-disabled'] = String(accessibilityState.disabled);
        if (disabled) attrs['data-disabled'] = 'true';
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        // Android Back on a Modal is its onRequestClose: drawn here as a button the test can press.
        Modal: ({ visible, children, onRequestClose }: { visible: boolean; children?: any; onRequestClose?: () => void }) => (visible
            ? createElement('div', { 'data-modal': 'true' },
                createElement('button', { 'data-testid': 'android-back', onClick: () => onRequestClose?.() }), children)
            : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        Share: {
            share: vi.fn(async (m: { message: string }) => {
                ctl.shared.push({ message: m.message, sheetUp: !!document.querySelector('[data-testid="share-sheet"]') });
                return ctl.share ? ctl.share.promise : { action: 'sharedAction' };
            }),
            sharedAction: 'sharedAction', dismissedAction: 'dismissedAction',
        },
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null)) },
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: ctl.features }) }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: 'pk-me', privateKey: 'sk-me', callsign: 'Me' }) }));
vi.mock('../nodes', () => ({ isGuestNode: async () => false }));
vi.mock('../node-admin', () => ({
    askNodeRole: async () => ({ role: null, communityName: 'Mullum' }),
    readPersistedNodeRole: async () => undefined,
    cachedNodeRoleHeard: async () => ({ role: null, communityName: 'Mullum' }),
    persistNodeRole: async () => {},
}));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: 'member' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// The community making the outside link (utils/peek.ts makePeekLink), held until the test answers.
vi.mock('../db', () => ({
    signedGet: vi.fn(),
    signedRequestWithMethod: vi.fn(async (_m: string, path: string) => (path === '/api/peek' && ctl.peek ? ctl.peek.promise : {})),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'Content-Type': 'application/json', 'x-signed': '1' }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});

import { Alert } from 'react-native';
import { INVITE_SHARE_WORDS, t } from '@beanpool/core';
import { SharePostButtons } from '../../components/SharePost';
import { signedRequestWithMethod } from '../db';
import { TIMEOUT_MS } from '../peek';
import { INVITE_FOR_SHARE_WAIT_MS } from '../invite-and-share';

const POST = { id: 'post-123', title: 'Ladder for borrowing', type: 'offer', status: 'active', active: true, audienceScope: 'public' };
const PEEK = { ticket: 'AbCdEfGhIjKlMnOpQrSt_-', postId: 'post-123', expiresAt: '2026-11-12T00:00:00Z' };

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    // Members may share outside here, and any member may invite: every way that shares is offered.
    ctl.features = { door: 'members', shareOutside: true };
    ctl.shared.length = 0; ctl.share = null; ctl.peek = null; ctl.invite = null; ctl.inviteFetches.length = 0;
    vi.mocked(signedRequestWithMethod).mockClear();
    vi.mocked(Alert.alert).mockClear();
    vi.stubGlobal('fetch', async (url: string, init: { signal?: AbortSignal }) => {
        if (typeof url === 'string' && url.includes('/api/invite/generate')) {
            ctl.inviteFetches.push({ signal: init?.signal });
            return ctl.invite ? ctl.invite.promise : { ok: true, status: 200, json: async () => ({ success: true, invite: { code: 'INV-AB12-CD34' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ voucher: false }) };
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove(); root = null; host = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const byId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const backdrop = () => host!.querySelector('[aria-label="Close"]') as HTMLElement | null;
const sheetUp = () => !!byId('share-sheet');
const held = (id: string) => byId(id)?.getAttribute('aria-disabled');
/** The links the community was asked to make, and the signal each went with. */
const peekAsks = () => vi.mocked(signedRequestWithMethod).mock.calls.filter(([, path]) => path === '/api/peek');
/** Time passing while the request waits (fake timers that also follow the real clock, so the sheet's own awaits still run). */
async function wait(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await settle();
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function press(el: HTMLElement | null) {
    expect(el).not.toBeNull();
    await act(async () => { el!.click(); });
    await settle();
}
async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(SharePostButtons, { post: POST }) as any); });
    await settle();
    await press(byId('share-open-button'));
    expect(sheetUp()).toBe(true);
}
/** Cancel, the backdrop and Android Back, each tried: the sheet stays up, and Cancel says it cannot be pressed. */
async function tryEveryClose() {
    await press(byId('share-sheet-cancel'));
    expect(sheetUp()).toBe(true);
    expect(byId('share-sheet-cancel')?.getAttribute('aria-disabled')).toBe('true');
    await press(backdrop());
    expect(sheetUp()).toBe(true);
    await press(byId('android-back'));
    expect(sheetUp()).toBe(true);
}

describe('the Share sheet holds while a share is being made', () => {
    it('Share outside: while the community makes the link, nothing closes the sheet; the phone\'s share sheet opens over it; then it closes', async () => {
        await mount();
        ctl.peek = deferred();
        ctl.share = deferred();
        await press(byId('share-outside-button'));
        expect(byId('share-outside-button')?.getAttribute('aria-disabled')).toBe('true');
        await tryEveryClose();
        expect(ctl.shared).toEqual([]);

        // The link arrives: handed over while our sheet is still up, never after it closed.
        await act(async () => { ctl.peek!.resolve(PEEK); });
        await settle();
        expect(ctl.shared).toEqual([{ message: `Ladder for borrowing\nhttps://mullum.example/?post=post-123&peek=${PEEK.ticket}`, sheetUp: true }]);
        // Still held while the phone's share sheet is up.
        await tryEveryClose();

        await act(async () => { ctl.share!.resolve({ action: 'sharedAction' }); });
        await settle();
        expect(sheetUp()).toBe(false);
        expect(ctl.shared).toHaveLength(1);
    });

    it('Share with members: while the phone\'s share sheet is up, nothing closes ours; it closes once that one has answered', async () => {
        await mount();
        ctl.share = deferred();
        await press(byId('share-members-button'));
        expect(ctl.shared.map((s) => s.sheetUp)).toEqual([true]);
        await tryEveryClose();

        await act(async () => { ctl.share!.resolve({ action: 'dismissedAction' }); });
        await settle();
        expect(sheetUp()).toBe(false);
    });

    it('Make the invite and share: while the community makes the invite, nothing closes the sheet; the invite is handed over with it up; then it closes', async () => {
        await mount();
        await press(byId('invite-and-share-button'));
        ctl.invite = deferred();
        ctl.share = deferred();
        await press(byId('invite-and-share-make'));
        await tryEveryClose();
        expect(ctl.shared).toEqual([]);

        await act(async () => { ctl.invite!.resolve({ ok: true, status: 200, json: async () => ({ success: true, invite: { code: 'INV-AB12-CD34' } }) }); });
        await settle();
        expect(ctl.shared).toHaveLength(1);
        expect(ctl.shared[0].sheetUp).toBe(true);
        expect(ctl.shared[0].message).toContain('invite=INV-AB12-CD34');
        await tryEveryClose();

        await act(async () => { ctl.share!.resolve({ action: 'sharedAction' }); });
        await settle();
        expect(sheetUp()).toBe(false);
    });

    it('with nothing being made, Cancel, the backdrop and Android Back each close it, and Cancel is not dimmed', async () => {
        await mount();
        expect(byId('share-sheet-cancel')?.getAttribute('aria-disabled')).toBe('false');
        await press(byId('share-sheet-cancel'));
        expect(sheetUp()).toBe(false);

        await press(byId('share-open-button'));
        await press(backdrop());
        expect(sheetUp()).toBe(false);

        await press(byId('share-open-button'));
        await press(byId('android-back'));
        expect(sheetUp()).toBe(false);
        expect(ctl.shared).toEqual([]);
    });
});

describe('while a share is being made, every other way waits too (one share at a time; only its answer closes the sheet)', () => {
    it('Share outside being made: Share with members and Invite and share are dimmed and do nothing, and no second link is asked for', async () => {
        await mount();
        ctl.peek = deferred();
        await press(byId('share-outside-button'));
        expect(held('share-members-button')).toBe('true');
        expect(held('invite-and-share-button')).toBe('true');

        await press(byId('share-members-button'));
        await press(byId('invite-and-share-button'));
        await press(byId('share-outside-button'));
        expect(sheetUp()).toBe(true);
        expect(byId('invite-and-share-panel')).toBeNull();
        expect(ctl.shared).toEqual([]);
        expect(peekAsks()).toHaveLength(1);

        // Its own answer closes the sheet; opened again, nothing is held.
        await act(async () => { ctl.peek!.resolve(PEEK); });
        await settle();
        expect(ctl.shared).toEqual([{ message: `Ladder for borrowing\nhttps://mullum.example/?post=post-123&peek=${PEEK.ticket}`, sheetUp: true }]);
        expect(sheetUp()).toBe(false);
        await press(byId('share-open-button'));
        for (const id of ['share-members-button', 'share-outside-button', 'invite-and-share-button', 'share-sheet-cancel']) expect(held(id)).toBe('false');
    });

    it('Share with members up: Share outside and Invite and share wait, and no link is made', async () => {
        await mount();
        ctl.share = deferred();
        await press(byId('share-members-button'));
        expect(held('share-outside-button')).toBe('true');
        expect(held('invite-and-share-button')).toBe('true');
        await press(byId('share-outside-button'));
        await press(byId('invite-and-share-button'));
        expect(peekAsks()).toHaveLength(0);
        expect(ctl.shared).toHaveLength(1);
        expect(sheetUp()).toBe(true);

        await act(async () => { ctl.share!.resolve({ action: 'sharedAction' }); });
        await settle();
        expect(sheetUp()).toBe(false);
    });

    it('where only admins invite: Ask an admin waits while the link is made, so the sheet never closes under it', async () => {
        ctl.features = { door: 'admins', shareOutside: true, inviteAsks: true };
        await mount();
        expect(byId('share-ask-admin-button')).not.toBeNull();
        ctl.peek = deferred();
        await press(byId('share-outside-button'));
        expect(held('share-ask-admin-button')).toBe('true');
        await press(byId('share-ask-admin-button'));
        expect(sheetUp()).toBe(true);

        // The link arrives with our sheet still up: the chooser never opens over an ask form.
        await act(async () => { ctl.peek!.resolve(PEEK); });
        await settle();
        expect(ctl.shared.map((s) => s.sheetUp)).toEqual([true]);
        expect(sheetUp()).toBe(false);
    });
});

describe('the hold ends: a community that does not answer is waited for 15 seconds, no more', () => {
    it('Share outside: at the limit the request is given up, "Not shared" says the community couldn\'t be reached, and a late link is never handed over', async () => {
        await mount();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        ctl.peek = deferred();
        await press(byId('share-outside-button'));
        await wait(TIMEOUT_MS - 1_000);
        expect(held('share-outside-button')).toBe('true');
        expect(held('share-sheet-cancel')).toBe('true');
        expect(Alert.alert).not.toHaveBeenCalled();

        await wait(1_000);
        expect(Alert.alert).toHaveBeenCalledWith('Not shared', "Your community couldn't be reached. Try again.");
        expect((peekAsks()[0]?.[3] as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
        // A failed Share outside lets the sheet go, as before.
        expect(sheetUp()).toBe(false);

        // The answer comes after all: it opens no chooser.
        await act(async () => { ctl.peek!.resolve(PEEK); });
        await settle();
        expect(ctl.shared).toEqual([]);

        // Opened again: nothing dimmed, and Cancel closes it.
        await press(byId('share-open-button'));
        expect(held('share-outside-button')).toBe('false');
        expect(held('share-sheet-cancel')).toBe('false');
        await press(byId('share-sheet-cancel'));
        expect(sheetUp()).toBe(false);
    });

    it('Make the invite and share: at the limit the request is given up, the panel says no answer came, Make and Cancel work again, and a late invite is never handed over', async () => {
        await mount();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await press(byId('invite-and-share-button'));
        ctl.invite = deferred();
        await press(byId('invite-and-share-make'));
        await wait(INVITE_FOR_SHARE_WAIT_MS - 1_000);
        expect(held('invite-and-share-make')).toBe('true');
        expect(held('share-sheet-cancel')).toBe('true');
        expect(byId('invite-and-share-note')).toBeNull();

        await wait(1_000);
        expect(byId('invite-and-share-note')?.textContent).toBe(t(INVITE_SHARE_WORDS.offline));
        expect(ctl.inviteFetches).toHaveLength(1);
        expect(ctl.inviteFetches[0].signal?.aborted).toBe(true);
        expect(held('invite-and-share-make')).toBe('false');
        expect(held('invite-and-share-button')).toBe('false');
        expect(held('share-sheet-cancel')).toBe('false');
        expect(sheetUp()).toBe(true);

        // The invite comes after all: it opens no chooser.
        await act(async () => { ctl.invite!.resolve({ ok: true, status: 200, json: async () => ({ success: true, invite: { code: 'INV-LATE-0001' } }) }); });
        await settle();
        expect(ctl.shared).toEqual([]);

        await press(byId('share-sheet-cancel'));
        expect(sheetUp()).toBe(false);
    });
});
