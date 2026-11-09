// @vitest-environment jsdom
/**
 * "Invited by" and "Brought in n people ›" on a profile (components/InvitedByCard.tsx; DESIGN-invites-vouching-review-fable.md
 * slice I3; Marty, 10 Nov 2026), rendered for real with core's words:
 *   - an owner inviter reads "🌱 Invited by Olive · owner", an admin "… · admin", a plain member no role word;
 *   - on your own profile "🌱 You were invited by …";
 *   - a password card "Invited with an owner’s invite card", the founder "Founding member";
 *   - "Invited directly by the system admin" and "Vetted by the admin at sign-up" are drawn for no kind;
 *   - Brought in shows only when the server sent `broughtIn` (an owner, an admin, or yourself), opens closed, and lists the
 *     branch from GET /api/invite/tree?root= with joined and still-here words.
 * React Native's host components are plain tags in react-dom, as added-you-phone-block-render.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MIA = 'a1'.repeat(32);
const OLIVE = 'b2'.repeat(32);
const BEN = 'c3'.repeat(32);

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
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: el('i'),
        StyleSheet: { create: (s: unknown) => s },
    };
});
const asked = vi.hoisted(() => ({ paths: [] as string[], body: [] as unknown }));
vi.mock('../db', () => ({
    signedGet: vi.fn(async (path: string) => {
        asked.paths.push(path);
        return { ok: true, json: async () => asked.body };
    }),
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: () => h('i') };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: () => h('span', { 'data-avatar': 'true' }) };
});

import { InvitedByCard } from '../../components/InvitedByCard';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    asked.paths = [];
    asked.body = [];
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const member = (role: 'owner' | 'admin' | null) => ({ kind: 'member' as const, publicKey: OLIVE, callsign: 'Olive', avatarUrl: null, tier: 'Elder', role });
const tierWords = (tier: string | null) => tier ?? '';
async function draw(props: Record<string, unknown>) {
    await act(async () => { root.render(createElement(InvitedByCard as any, { isSelf: false, targetPubkey: MIA, tierWords, ...props }) as unknown as Parameters<Root['render']>[0]); });
}
const GONE = ['Invited directly by the system admin', 'Vetted by the admin at sign-up'];

describe('InvitedByCard', () => {
    it('names an owner, an admin and a plain member inviter, with the role word', async () => {
        await draw({ vouchedInBy: member('owner') });
        expect(host.textContent).toContain('🌱 Invited by Olive · owner');
        await draw({ vouchedInBy: member('admin') });
        expect(host.textContent).toContain('🌱 Invited by Olive · admin');
        await draw({ vouchedInBy: member(null) });
        expect(host.textContent).toContain('🌱 Invited by Olive');
        expect(host.textContent).not.toContain('· owner');
        expect(host.textContent).toContain('Elder tier · tap to reach out');
    });

    it('on your own profile: "You were invited by"', async () => {
        await draw({ vouchedInBy: member('owner'), isSelf: true });
        expect(host.textContent).toContain('🌱 You were invited by Olive · owner');
    });

    it("a password card and the founder name nobody; the old sentences are drawn for no kind", async () => {
        await draw({ vouchedInBy: { kind: 'card', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null } });
        expect(host.textContent).toContain('Invited with an owner’s invite card');
        expect(host.textContent).toContain('An owner of this community made it');
        for (const g of GONE) expect(host.textContent).not.toContain(g);
        await draw({ vouchedInBy: { kind: 'founder', publicKey: null, callsign: null, avatarUrl: null, tier: null, role: null } });
        expect(host.textContent).toContain('Founding member');
        for (const g of GONE) expect(host.textContent).not.toContain(g);
        // Anything the server might once have sent as 'admin' draws no old sentence either.
        await draw({ vouchedInBy: { kind: 'admin', publicKey: null, callsign: null, avatarUrl: null, tier: null } });
        for (const g of GONE) expect(host.textContent).not.toContain(g);
    });

    it('nothing at all when the server sent neither line (a plain member, the switch off)', async () => {
        await draw({ vouchedInBy: null });
        expect(host.querySelector('[data-testid="profile-invited-by"]')).toBeNull();
    });

    it('Brought in: only when sent; closed at first; opens to the branch', async () => {
        await draw({ vouchedInBy: member('owner') });
        expect(host.querySelector('[data-testid="profile-brought-in"]')).toBeNull();
        expect(host.textContent).not.toContain('Brought in');
        asked.body = [{ publicKey: MIA, callsign: 'Mia', children: [
            { publicKey: BEN, callsign: 'Ben', joinedAt: '2026-10-01T00:00:00.000Z', status: 'active', children: [] },
            { publicKey: 'd4'.repeat(32), callsign: 'Gil', joinedAt: '2026-09-01T00:00:00.000Z', status: 'pruned', children: [] },
        ] }];
        await draw({ vouchedInBy: null, broughtIn: 2, isSelf: true });
        const row = host.querySelector('[data-testid="profile-brought-in"]') as HTMLElement;
        expect(row?.textContent).toContain('Brought in 2 people ›');
        expect(host.textContent).not.toContain('Ben');
        expect(asked.paths).toEqual([]);
        await act(async () => { row.click(); });
        await act(async () => { await Promise.resolve(); });
        expect(asked.paths).toEqual([`/api/invite/tree?root=${MIA}`]);
        expect(host.textContent).toContain('Ben');
        expect(host.textContent).toContain('Still here');
        expect(host.textContent).toContain('Gil');
        expect(host.textContent).toContain('No longer a member');
        await draw({ vouchedInBy: null, broughtIn: 1 });
        expect(host.textContent).toContain('Brought in 1 person ›');
    });
});
