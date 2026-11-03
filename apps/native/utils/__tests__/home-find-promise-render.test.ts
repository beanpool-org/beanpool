// @vitest-environment jsdom
/**
 * Home's "Find your community" card on the phone (components/home/FindCommunityBody.tsx) says what a community's directory
 * push promised (Mothership A3): "Keeps the listing promise" or "New listing", "Accepting members", "Closing on <date>",
 * under the nearest the sentence names and under each row after it, as the web's Home card does
 * (apps/pwa/src/pages/HomePage.find.test.tsx) and the phone's find screen does (find-community-words-render.test.ts).
 *
 * Rendered for real, as home-find-not-answering-render.test.ts does: react-dom in jsdom, React Native's host components as
 * plain tags, the knock reads stubbed at their module. The card's own lines are utils/community-directory.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
    };
});
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../knock', () => ({ readKnockStatus: vi.fn(async () => null), cardKnockLines: () => [] }));

import { FIND_COMMUNITY_WORDS, setLanguage } from '@beanpool/core';
import { lightColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import type { DirectoryCommunity, GlobalHome } from '../community-directory';

const PROMISE = { v: 1, owners: 2, backups: true, reports: true, notice: true };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const community = (key: string, distanceKm: number, extra: Partial<DirectoryCommunity> = {}): DirectoryCommunity => ({
    key, name: `Lismore ${key}`, url: `https://${key}.example.org`, lat: null, lng: null, radiusKm: null, memberCount: 12,
    contactEmail: null, contactPhone: null, distanceKm, lastSeenAt: null, ...extra,
});
const homeOf = (communities: DirectoryCommunity[]): GlobalHome => ({
    point: 'request', communities, communityCount: communities.length, nearbyPosts: null, watches: [], directoryFetchedAt: '2026-10-28T08:00:00.000Z',
});

async function render(home: GlobalHome): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const card = createElement(FindCommunityBody, { home, knocks: [], identity: null, nodeUrl: null, point: { lat: -28.65, lng: 153.6 }, colors: lightColors });
    await act(async () => { createRoot(host).render(card as unknown as Parameters<Root['render']>[0]); });
    return host;
}
const promised = (host: HTMLElement, key: string) => host.querySelector(`[data-testid="home-find-promise-${key}"]`)?.textContent ?? null;

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => setLanguage('en'));

describe('Home\'s find card says what a community promised, as the web\'s does (Mothership A3)', () => {
    it('under the nearest the sentence names: the promise, requests taken, and the closing day', async () => {
        const host = await render(homeOf([community('a', 12, { promise: PROMISE, acceptingKnocks: true, closingOn: inDays(30) })]));
        const text = promised(host, 'a') ?? '';
        expect(text).toContain(FIND_COMMUNITY_WORDS.keepsPromise);
        expect(text).toContain(FIND_COMMUNITY_WORDS.acceptingMembers);
        expect(text).toMatch(/^Keeps the listing promise · Accepting members · Closing on .+\d{4}$/);
    });

    it('under each row after it; "New listing" for one the node says has no promise; nothing for an older node', async () => {
        const host = await render(homeOf([
            community('a', 12, { promise: PROMISE }),
            community('b', 20, { promise: null, acceptingKnocks: true }),
            community('c', 30),
        ]));
        expect(promised(host, 'a')).toBe('Keeps the listing promise');
        expect(promised(host, 'b')).toBe('New listing · Accepting members');
        expect(promised(host, 'c')).toBeNull();
    });

    it('nothing negative: a community that takes no requests and has no day says only its promise', async () => {
        const host = await render(homeOf([community('a', 12, { promise: PROMISE, acceptingKnocks: false, closingOn: null })]));
        expect(promised(host, 'a')).toBe('Keeps the listing promise');
    });

    it('in the member\'s language', async () => {
        setLanguage('fr', [{ [FIND_COMMUNITY_WORDS.keepsPromise]: 'Tient sa promesse d’inscription', [FIND_COMMUNITY_WORDS.newListing]: 'Nouvelle inscription' }]);
        const host = await render(homeOf([community('a', 12, { promise: PROMISE }), community('b', 20, { promise: null })]));
        expect(promised(host, 'a')).toBe('Tient sa promesse d’inscription');
        expect(promised(host, 'b')).toBe('Nouvelle inscription');
    });
});
