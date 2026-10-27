// @vitest-environment jsdom
/**
 * Home's "Find your community" card on the phone (components/home/FindCommunityBody.tsx) says "Not answering lately"
 * under a community whose last push to the directory is more than 36 h ago, as the web's Home card does
 * (apps/pwa/src/pages/HomePage.find.test.tsx) and the phone's find screen does (find-community-words-render.test.ts):
 * under the nearest, which the card's sentence names, and under each row after it (front doors S13; deciding pass on
 * #2541, finding 3: phone and web the same).
 *
 * Rendered for real, as find-community-words-render.test.ts does: react-dom in jsdom, React Native's host components as
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const community = (key: string, distanceKm: number, lastSeenAt: string | null): DirectoryCommunity => ({
    key, name: `Lismore ${key}`, url: `https://${key}.example.org`, lat: null, lng: null, radiusKm: null, memberCount: 12,
    contactEmail: null, contactPhone: null, distanceKm, lastSeenAt,
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
const quiet = (host: HTMLElement, key: string) => host.querySelector(`[data-testid="home-find-not-answering-${key}"]`)?.textContent ?? null;

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => setLanguage('en'));

describe('Home\'s find card says a community has gone quiet, as the web\'s does (front doors S13)', () => {
    it('under the nearest the sentence names, past 36 h since its last push', async () => {
        const host = await render(homeOf([community('a', 12, hoursAgo(40))]));
        expect(host.textContent).toContain('Lismore a');
        expect(quiet(host, 'a')).toBe(FIND_COMMUNITY_WORDS.notAnswering);
    });

    it('under each row after it, and only those past 36 h', async () => {
        const host = await render(homeOf([
            community('a', 12, hoursAgo(2)),
            community('b', 20, hoursAgo(40)),
            community('c', 30, hoursAgo(35)),
        ]));
        expect(quiet(host, 'a')).toBeNull();
        expect(quiet(host, 'b')).toBe('Not answering lately');
        expect(quiet(host, 'c')).toBeNull();
    });

    it('when far, under the nearest listed the sentence names', async () => {
        const host = await render(homeOf([community('far', 12_489, hoursAgo(72))]));
        expect(host.textContent).toContain('Lismore far');
        expect(quiet(host, 'far')).toBe('Not answering lately');
    });

    it('an older global node that sends no lastSeenAt: no such line', async () => {
        const host = await render(homeOf([community('a', 12, null), community('b', 20, null)]));
        expect(host.textContent).not.toContain('Not answering lately');
    });

    it('in the member\'s language', async () => {
        setLanguage('fr', [{ [FIND_COMMUNITY_WORDS.notAnswering]: 'Ne répond pas ces derniers temps' }]);
        const host = await render(homeOf([community('a', 12, hoursAgo(40)), community('b', 20, hoursAgo(40))]));
        expect(quiet(host, 'a')).toBe('Ne répond pas ces derniers temps');
        expect(quiet(host, 'b')).toBe('Ne répond pas ces derniers temps');
    });
});
