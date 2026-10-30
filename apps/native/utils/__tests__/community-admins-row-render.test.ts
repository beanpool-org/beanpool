// @vitest-environment jsdom
/**
 * Account Protection's "Your community's admins" row (components/CommunityAdminsRow.tsx, vault rethink VR3) across a
 * community switch. Settings stays mounted when the phone moves to another community, so the row's state must be the
 * community now in use's alone: never the community left's "On … since …", its "no longer offers" note, or a Remove that
 * would ask the new community to delete a copy it never held (review 4423011598). Rendered for real; the community's
 * rule and its answers come from the scene below, and nothing is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, accessibilityRole } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityRole === 'button') attrs.role = 'button';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: () => {} },
    };
});
/** Account Protection coming into view again: every focus effect mounted runs once more. */
const focus = vi.hoisted(() => ({ effects: new Set<() => void>() }));
vi.mock('expo-router', async () => {
    const React = await import('react');
    return {
        useFocusEffect: (cb: () => void) => {
            React.useEffect(() => {
                focus.effects.add(cb);
                cb();
                return () => { focus.effects.delete(cb); };
            }, [cb]);
        },
    };
});
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
        removeItem: async (k: string) => { store.delete(k); },
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Sally' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async () => true }));
vi.mock('../../components/key-lines', () => ({ keyLineWords: (s: string) => s }));

/** The scene: the phone's community, each community's rule, and what each answers about the copy. */
const fx = vi.hoisted(() => ({
    anchor: null as string | null,
    rules: {} as Record<string, string>,
    answers: {} as Record<string, unknown>,
    asked: [] as string[],
    removed: [] as string[],
}));
vi.mock('../node-post', () => ({
    anchorUrl: async () => fx.anchor,
    signedPost: async () => { throw new Error('no node in this test'); },
    signedDelete: async () => { throw new Error('no node in this test'); },
}));
vi.mock('../copies-rule', () => ({ copiesRuleForScreen: async (url: string | null) => (url ? fx.rules[url] ?? null : null) }));
vi.mock('../identity', () => ({ getMnemonic: async () => null }));
vi.mock('../crypto', () => ({ hexToBytes: () => new Uint8Array(32) }));
vi.mock('../community-copy', async (importOriginal) => {
    const real = await importOriginal<typeof import('../community-copy')>();
    return {
        ...real,
        communityCopyStatus: async (url: string) => {
            fx.asked.push(url);
            const answer = fx.answers[url];
            return typeof answer === 'function' ? (answer as () => unknown)() : answer ?? null;
        },
        removeCommunityCopy: async (url: string) => { fx.removed.push(url); },
        turnOnCommunityCopy: async () => ({ since: new Date().toISOString() }),
    };
});

import { setLanguage } from '@beanpool/core';
import { CommunityAdminsRow } from '../../components/CommunityAdminsRow';
import { communitySwitched } from '../community-switch';

const MULLUM = 'https://mullum.beanpool.org';
const BELL = 'https://bellingen.beanpool.org';
const KEPT = { kept: true, since: '2026-10-05T00:00:00.000Z', offered: true };

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.clear();
    focus.effects.clear();
    fx.anchor = MULLUM;
    fx.rules = { [MULLUM]: 'server', [BELL]: 'vault' };
    fx.answers = { [MULLUM]: KEPT };
    fx.asked.length = 0;
    fx.removed.length = 0;
    setLanguage('en');
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(CommunityAdminsRow, {}) as any); });
    await settle();
}
async function refocus(): Promise<void> {
    await act(async () => { for (const cb of [...focus.effects]) cb(); });
    await settle();
}
const byTestId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('CommunityAdminsRow: only the community in use speaks', () => {
    it('kept at one community, then Settings comes into view in another that neither offers it nor had it turned on here: nothing of the first stays', async () => {
        await mount();
        expect(byTestId('community-admins-on')?.textContent).toContain('mullum.beanpool.org');
        expect(byTestId('community-admins-remove')).toBeTruthy();

        fx.anchor = BELL;
        await refocus();
        expect(byTestId('community-admins-row'), 'the row is gone: Bellingen keeps no copy and offers none').toBeNull();
        expect(byTestId('community-admins-on')).toBeNull();
        expect(byTestId('community-admins-remove')).toBeNull();
        expect(fx.asked, 'Bellingen is never asked: it neither offers the path nor had it turned on from this phone').toEqual([MULLUM]);
        expect(fx.removed).toEqual([]);
    });

    it('a switch made while Settings shows: the row reads the community now in use at once, and says nothing of the one left', async () => {
        fx.rules[BELL] = 'server';
        fx.answers[BELL] = { kept: false, since: null, offered: true };
        await mount();
        expect(byTestId('community-admins-on')).toBeTruthy();

        fx.anchor = BELL;
        await act(async () => { communitySwitched(); });
        await settle();
        expect(byTestId('community-admins-on'), 'no "On" carried over from Mullumbimby').toBeNull();
        expect(byTestId('community-admins-turn-on'), 'Bellingen offers it and keeps none: Turn on').toBeTruthy();
        expect(fx.asked).toEqual([MULLUM, BELL]);
    });

    it('an answer from the community left never lands after the switch', async () => {
        let answerMullum: (v: unknown) => void = () => {};
        fx.answers[MULLUM] = () => new Promise((resolve) => { answerMullum = resolve; });
        await mount();
        expect(fx.asked).toEqual([MULLUM]);

        fx.anchor = BELL;
        await refocus();
        await act(async () => { answerMullum(KEPT); });
        await settle();
        expect(byTestId('community-admins-row'), 'Mullumbimby answered late: its "On" is not Bellingen\'s').toBeNull();
        expect(byTestId('community-admins-on')).toBeNull();
    });

    it('the same community seen again keeps its "On" while it is asked again', async () => {
        await mount();
        let answerAgain: (v: unknown) => void = () => {};
        fx.answers[MULLUM] = () => new Promise((resolve) => { answerAgain = resolve; });
        await refocus();
        expect(byTestId('community-admins-on'), 'no flicker to Turn on while the same community is asked again').toBeTruthy();
        await act(async () => { answerAgain(KEPT); });
        await settle();
        expect(byTestId('community-admins-on')?.textContent).toContain('mullum.beanpool.org');
    });
});
