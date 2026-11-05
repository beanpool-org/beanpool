// @vitest-environment jsdom
/**
 * "Invite and share" on a listing (components/InviteAndShare.tsx; utils/invite-and-share.ts), driven as the real components
 * through the one Share button's sheet (components/SharePost.tsx, DP2) with a fake node (the fetch is stubbed; nothing leaves
 * the test):
 *   - who is offered the button: a member where the community takes invites and its door lets them; nobody else (a guest, a
 *     member where only admins invite, a community that takes none): there is no button, and nothing is asked of the node
 *   - what a tap makes: the node's own invite, and nothing else in its body (the vouching reset, R0: an invite carries no
 *     vouch), handed to the share sheet with the listing's title and `{community}/?invite={code}&post={id}`
 *   - what it never makes: an offline ticket. With no answer the member is told so, and nothing is shared; a refusal says the
 *     community's words, and nothing is shared
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ctl = vi.hoisted(() => ({
    profile: null as any,
    guest: false,
    role: null as any,
    shared: [] as any[],
    asked: [] as string[],
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', alert: 'alert', radio: 'radio', radiogroup: 'radiogroup' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.expanded !== undefined) attrs['aria-expanded'] = String(accessibilityState.expanded);
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: any }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
        Alert: { alert: () => {} },
        Share: { share: async (m: unknown) => { ctl.shared.push(m); return { action: 'sharedAction' }; } },
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null)) },
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ctl.profile }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: 'pk-me', privateKey: 'sk-me', callsign: 'Me' }) }));
vi.mock('../nodes', () => ({ isGuestNode: async () => ctl.guest }));
vi.mock('../node-admin', () => ({
    askNodeRole: async () => { ctl.asked.push('role'); return { role: ctl.role, communityName: 'Mullum' }; },
    readPersistedNodeRole: async () => undefined,
    // The sheet's lines read the role through the header's cache (utils/use-share-role.ts).
    cachedNodeRoleHeard: async () => ({ role: ctl.role, communityName: 'Mullum' }),
    persistNodeRole: async () => {},
}));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: 'member' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// The phone's database is never read here: utils/peek.ts (the Share sheet's link to share outside) imports it, and its real
// module would load expo's runtime.
vi.mock('../db', () => ({ signedGet: vi.fn(), signedRequestWithMethod: vi.fn() }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'Content-Type': 'application/json', 'x-signed': '1' }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});

import { SharePostButtons } from '../../components/SharePost';
import { offersInviteAndShare, makeInviteForShare, INVITE_FOR_SHARE_WAIT_MS } from '../invite-and-share';

const POST = { id: '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34', title: 'Ladder for borrowing' };
const NODE = 'https://mullum.example';

const fake = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: any }>, reply: null as null | (() => Promise<any>) }));
const okInvite = (code = 'INV-AB12-CD34') => async () => ({ ok: true, status: 200, json: async () => ({ success: true, invite: { code } }) });

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    ctl.profile = { profile: 'local', features: { door: 'members' } };
    ctl.guest = false; ctl.role = null; ctl.shared.length = 0; ctl.asked.length = 0;
    fake.calls.length = 0; fake.reply = okInvite();
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
        fake.calls.push({ url, body: JSON.parse(init.body) });
        return fake.reply!();
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove(); root = null; host = null;
    vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(SharePostButtons, { post: POST }) as any); });
    await settle();
    // Invite and share is a way in the one Share button's sheet (DP2).
    await act(async () => { byId('share-open-button')!.click(); });
    await settle();
}
const byId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function tap(id: string) { await act(async () => { byId(id)!.click(); }); await settle(); }

describe('who is offered the button', () => {
    it('a member, where the community takes invites and any member may make them', async () => {
        await mount();
        // The way's name, with its sentence under it in the same item.
        expect(byId('invite-and-share-button')?.firstElementChild?.textContent).toBe('Invite and share');
        expect(byId('invite-and-share-line')?.textContent).toBe('One invite, for one person: a code works once.');
        // Asked nothing of the node until they tap: no role (any member may invite).
        expect(ctl.asked).toEqual([]);
    });

    it('no button where the community takes no invites', async () => {
        ctl.profile = { profile: 'global', features: { invites: false } };
        await mount();
        expect(byId('invite-and-share-button')).toBeNull();
    });

    it('no button for a guest of the community', async () => {
        ctl.guest = true;
        await mount();
        expect(byId('invite-and-share-button')).toBeNull();
    });

    it('where only admins invite: a plain member has none, an owner or an admin has it', async () => {
        ctl.profile = { profile: 'local', features: { door: 'admins' } };
        ctl.role = null;
        await mount();
        // The sheet's line already says only admins invite here (the role through the header's cache): Invite and share is
        // not offered, so it asks the node nothing more.
        expect(ctl.asked).toEqual([]);
        expect(byId('invite-and-share-button')).toBeNull();
        act(() => root?.unmount()); host?.remove();
        for (const role of ['owner', 'admin']) {
            ctl.role = role;
            ctl.asked.length = 0;
            await mount();
            expect(ctl.asked, role).toContain('role');
            expect(byId('invite-and-share-button'), role).toBeTruthy();
            act(() => root?.unmount()); host?.remove();
        }
    });

    it('where Invite and share is not offered, nothing is read for it: no role asked on a community that takes no invites', async () => {
        ctl.profile = { profile: 'local', features: { door: 'admins', invites: false } };
        ctl.role = 'owner';
        await mount();
        expect(byId('invite-and-share-button')).toBeNull();
        expect(ctl.asked).toEqual([]);
    });

    it('the rule, on its own: no post id, no button', () => {
        const features = { door: 'members' } as any;
        expect(offersInviteAndShare({ features, role: undefined, guest: false, postId: POST.id })).toBe(true);
        expect(offersInviteAndShare({ features, role: undefined, guest: false, postId: '' })).toBe(false);
        expect(offersInviteAndShare({ features, role: undefined, guest: false, postId: undefined })).toBe(false);
    });
});

describe('what a tap makes', () => {
    it('the node\'s invite, handed to the share sheet with the listing\'s title and the link that lands on it', async () => {
        await mount();
        await tap('invite-and-share-button');
        expect(byId('invite-and-share-panel')?.textContent).toContain('lands on this listing');
        // The panel makes nothing until the member says so.
        expect(fake.calls).toEqual([]);
        await tap('invite-and-share-make');
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].url).toBe(`${NODE}/api/invite/generate`);
        expect(fake.calls[0].body).toEqual({ publicKey: 'pk-me' });
        expect(ctl.shared).toEqual([{ message: `${POST.title}\n${NODE}/?invite=INV-AB12-CD34&post=${POST.id}`, title: POST.title }]);
        // Done: the panel and the sheet are closed, no note.
        expect(byId('invite-and-share-panel')).toBeNull();
        expect(byId('invite-and-share-note')).toBeNull();
        expect(byId('share-sheet')).toBeNull();
    });

    // The vouching reset (R0): no vouch on an invite. The panel reads no vouch word, and the body carries the member's key and
    // nothing else, on the first invite and the next.
    it('no vouch choice and no vouch in the body, on a community with Beans', async () => {
        ctl.profile = { profile: 'local', features: { door: 'members', beans: true } };
        await mount();
        expect(host!.textContent).not.toMatch(/vouch/i);
        await tap('invite-and-share-button');
        expect(byId('invite-and-share-panel')?.textContent).not.toMatch(/vouch/i);
        expect(host!.textContent).not.toMatch(/vouch/i);
        expect(host!.querySelector('[role="radiogroup"]')).toBeNull();
        await tap('invite-and-share-make');
        expect(fake.calls[0].body).toEqual({ publicKey: 'pk-me' });

        // Shared: the sheet closed. The next invite is a new tap on Share, and the same.
        await tap('share-open-button');
        await tap('invite-and-share-button');
        await tap('invite-and-share-make');
        expect(fake.calls[1].body).toEqual({ publicKey: 'pk-me' });
        expect(ctl.shared).toHaveLength(2);
    });
});

describe('what it never makes', () => {
    it('with no answer from the node: no ticket, nothing shared, and the member is told', async () => {
        fake.reply = async () => { throw new TypeError('Network request failed'); };
        await mount();
        await tap('invite-and-share-button');
        await tap('invite-and-share-make');
        expect(ctl.shared).toEqual([]);
        expect(byId('invite-and-share-note')?.textContent).toContain('needs a connection');
        expect(byId('invite-and-share-note')?.getAttribute('role')).toBe('alert');
    });

    it('a refusal says the community\'s words and shares nothing', async () => {
        fake.reply = async () => ({ ok: false, status: 403, json: async () => ({ code: 'admins_only', error: 'Only admins invite here.' }) });
        await mount();
        await tap('invite-and-share-button');
        await tap('invite-and-share-make');
        expect(ctl.shared).toEqual([]);
        expect(byId('invite-and-share-note')?.textContent).toBe('Only admins invite here.');
    });

    it('a reply with no code is no invite', async () => {
        fake.reply = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
        await mount();
        await tap('invite-and-share-button');
        await tap('invite-and-share-make');
        expect(ctl.shared).toEqual([]);
        expect(byId('invite-and-share-note')?.textContent).toBe('The invite was not made.');
    });

    it('makeInviteForShare, on its own: offline is told apart from a refusal', async () => {
        const id = { publicKey: 'pk', privateKey: 'sk', callsign: 'x' } as any;
        const signedHeaders = (async () => ({})) as any;
        const down = await makeInviteForShare(NODE, id, undefined, { signedHeaders, fetchImpl: (async () => { throw new Error('down'); }) as any });
        expect(down).toMatchObject({ ok: false, offline: true });
        const refused = await makeInviteForShare(NODE, id, undefined, { signedHeaders, fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any });
        expect(refused).toMatchObject({ ok: false, offline: false });
    });

    it('makeInviteForShare, on its own: a community that never answers is no answer at INVITE_FOR_SHARE_WAIT_MS, and the request is given up', async () => {
        vi.useFakeTimers();
        try {
            const id = { publicKey: 'pk', privateKey: 'sk', callsign: 'x' } as any;
            const signals: AbortSignal[] = [];
            const fetchImpl = ((_url: string, init: { signal: AbortSignal }) => { signals.push(init.signal); return new Promise(() => {}); }) as any;
            let settled: unknown = 'waiting';
            void makeInviteForShare(NODE, id, undefined, { signedHeaders: (async () => ({})) as any, fetchImpl }).then((r) => { settled = r; });
            await vi.advanceTimersByTimeAsync(INVITE_FOR_SHARE_WAIT_MS - 1);
            expect(settled).toBe('waiting');
            expect(signals[0]?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toMatchObject({ ok: false, offline: true });
            expect(signals[0].aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
