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
    askCanVouch: async () => false,
    signedGet: vi.fn(),
    signedRequestWithMethod: vi.fn(async (_m: string, path: string) => (path === '/api/peek' && ctl.peek ? ctl.peek.promise : {})),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'Content-Type': 'application/json', 'x-signed': '1' }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});

import { SharePostButtons } from '../../components/SharePost';

const POST = { id: 'post-123', title: 'Ladder for borrowing', type: 'offer', status: 'active', active: true, audienceScope: 'public' };
const PEEK = { ticket: 'AbCdEfGhIjKlMnOpQrSt_-', postId: 'post-123', expiresAt: '2026-11-12T00:00:00Z' };

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    // Members may share outside here, and any member may invite: every way that shares is offered.
    ctl.features = { door: 'members', shareOutside: true };
    ctl.shared.length = 0; ctl.share = null; ctl.peek = null; ctl.invite = null;
    vi.stubGlobal('fetch', async () => (ctl.invite ? ctl.invite.promise : { ok: true, status: 200, json: async () => ({ success: true, invite: { code: 'INV-AB12-CD34' } }) }));
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove(); root = null; host = null;
    vi.unstubAllGlobals();
});

const byId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const backdrop = () => host!.querySelector('[aria-label="Close"]') as HTMLElement | null;
const sheetUp = () => !!byId('share-sheet');
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
