// @vitest-environment jsdom
/**
 * Settings → "🛡️ Manage <community>" (components/NodeAdminEntry.tsx) for the owner of a community its members reach by its
 * server's public number, with no name yet (HTTPS S3, DESIGN-https-anywhere-fable.md §3, D3): under Manage, the sentence
 * the claim screen's last step says too (utils/address-follow.ts numberNudge). Rendered for real at the floor's window
 * (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components as plain tags carrying their styles.
 * The node's role answer and the profile copy are stubbed; numberOnlyAddress and the words are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null,
        Modal: ({ children, visible }: any) => visible ? children : null, ScrollView: el('div'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({
    router: { push: vi.fn() },
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'marty' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: look.theme, colors: look.theme === 'dark' ? darkColors : lightColors }) };
});
const phone = vi.hoisted(() => ({ anchor: 'https://203.0.113.5' as string | null, role: 'owner' as string | null, addresses: ['203.0.113.5'] as string[] | undefined }));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => phone.anchor) }));
vi.mock('../node-admin', async () => {
    const role = await import('../node-role');
    return {
        ...role,
        fetchMyNodeRole: vi.fn(async () => ({ role: phone.role, communityName: 'Beans Town' })),
        rememberNodeRole: vi.fn(),
    };
});
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ busy: false, start: vi.fn(), dialog: null }) }));
vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => ({ profile: 'local', features: {}, checkedAt: new Date().toISOString(), ...(phone.addresses ? { addresses: phone.addresses } : {}) }),
}));
vi.mock('../names-list', () => ({ offersNamesList: () => false }));
vi.mock('../break-glass', () => ({ issueBreakGlassCodeOnce: vi.fn(), forgetBreakGlassCode: vi.fn() }));
vi.mock('../sign-out-everywhere', () => ({ signOutEverywhereOnce: vi.fn(), signOutEverywhereWarning: vi.fn(() => ''), signOutEverywhereDone: vi.fn(() => '') }));
vi.mock('../LocalAuth', () => ({ turnAppLockOnForRole: vi.fn(async () => 'already-on'), APP_LOCK_ON_FOR_ROLE: () => '' }));

import { NodeAdminEntry } from '../../components/NodeAdminEntry';
import { lightColors, darkColors } from '../../constants/colors';

const NUDGE = "Members reach this community by its server's number, 203.0.113.5. If the server or its number changes, each member will have to type the new one. A name follows the community: Settings → Public Address.";
const menu = { sectionHeader: {}, menuGroup: {}, menuBtn: {}, menuBtnLast: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

async function render(): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(NodeAdminEntry, { styles: menu }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}
const nudge = (host: HTMLElement) => host.querySelector('[data-testid="owner-number-nudge"]') as HTMLElement | null;

beforeEach(() => {
    document.body.innerHTML = '';
    phone.anchor = 'https://203.0.113.5';
    phone.role = 'owner';
    phone.addresses = ['203.0.113.5'];
    look.theme = 'light';
});

describe('the owner\'s nudge under Manage, at the server\'s number', () => {
    it('says a name follows the community, under Manage, wrapping at 320 dp and 1.3x', async () => {
        const host = await render();
        expect(nudge(host)?.textContent).toBe(NUDGE);
        // Right after the Manage row, inside the same card.
        const manage = host.querySelector('[aria-label="Manage Beans Town"]') as HTMLElement;
        expect(manage).not.toBeNull();
        expect(manage.nextElementSibling).toBe(nudge(host));
        for (const node of [nudge(host)!, ...Array.from(nudge(host)!.querySelectorAll('*'))]) {
            const s = JSON.parse(node.getAttribute('data-style') ?? '{}');
            expect(s.width).toBeUndefined();
            expect(s.height).toBeUndefined();
            expect(node.getAttribute('data-lines')).toBeNull();
        }
    });

    it('with body ink on the card in both themes', async () => {
        for (const [theme, colors] of [['light', lightColors], ['dark', darkColors]] as const) {
            look.theme = theme;
            document.body.innerHTML = '';
            const host = await render();
            expect(JSON.parse(nudge(host)!.querySelector('span')!.getAttribute('data-style')!).color).toBe(colors.text.body);
        }
    });

    it('the same with no addresses known yet (an older node, or a copy not read yet)', async () => {
        phone.addresses = undefined;
        expect(nudge(await render())?.textContent).toBe(NUDGE);
    });

    it('nothing once the community has a name, at a name, or for an admin or moderator', async () => {
        phone.addresses = ['203.0.113.5', 'beans.example.org'];
        expect(nudge(await render())).toBeNull();
        phone.addresses = ['beans.example.org'];
        phone.anchor = 'https://beans.example.org';
        expect(nudge(await render())).toBeNull();
        phone.anchor = 'https://203.0.113.5';
        phone.addresses = ['203.0.113.5'];
        for (const role of ['admin', 'moderator']) {
            phone.role = role;
            const host = await render();
            expect(host.textContent).toContain('Beans Town');
            expect(nudge(host), role).toBeNull();
        }
    });
});
