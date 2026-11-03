// @vitest-environment jsdom
/**
 * Find a community's lines about nothing near (app/find-community.tsx), in the member's language: core's
 * FIND_COMMUNITY_WORDS are word() keys the screen shows through t(), and the far line is core's farLine, which
 * translates both halves, so it is one language, never "No community near you yet." in English before a French lead
 * (deciding review of #2152, inline comment on find-community.ts:84). The web's findBody is held to the same in
 * apps/pwa/src/lib/home-cards.test.ts.
 *
 * Rendered for real, as set-up-server-entry-render.test.ts does: react-dom in jsdom, React Native's host components as
 * plain tags, the screen's network and storage stubbed at their modules. Core's language is set as the provider sets it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn(async () => undefined) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: true })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
// The member's community is the global one: since slice S3 an account with no community in use is waiting to be let in,
// and the screen signs nothing to the global community for it (app/find-community.tsx `inCommunity`).
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://global.beanpool.org' : null)), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'marty' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
// What the node lists from the member's typed town: set per case.
const listing = vi.hoisted(() => ({ communities: [] as Record<string, unknown>[], fetchedAt: '2026-10-14T08:00:00.000Z' as string | null }));
vi.mock('../community-directory', async () => {
    const core = await import('@beanpool/core');
    return {
        fetchCommunities: vi.fn(async () => ({ ok: true, value: { communities: listing.communities, total: listing.communities.length, fetchedAt: listing.fetchedAt } })),
        fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
        watchPlace: vi.fn(), unwatchPlace: vi.fn(),
        communityLabel: (c: { name: string }) => c.name, communityFacts: () => '',
        // As utils/community-directory.ts has it (tested there): core's rule, in the member's language.
        notAnsweringLine: (c: { lastSeenAt?: string | null }) => (core.notAnsweringLately(c.lastSeenAt) ? core.t(core.FIND_COMMUNITY_WORDS.notAnswering) : null),
        // And the listing promise's lines (mothership A3), core's rule joined as the card joins them.
        promiseLine: (c: object) => { const lines = core.communityPromiseLines(c); return lines.length ? lines.join(' · ') : null; },
    };
});
vi.mock('../knock', () => ({
    sendKnock: vi.fn(), readKnockStatus: vi.fn(), rememberedKnocks: vi.fn(async () => []), rememberKnock: vi.fn(), forgetKnock: vi.fn(),
    cancelKnock: vi.fn(), cancelledKnocks: vi.fn(async () => ({})), KNOCK_MESSAGES: {},
    knockCardState: vi.fn(() => ({ kind: 'ask' })), knockFormProblem: vi.fn(() => null), KNOCK_MESSAGE_CHARS: 280, KNOCK_CALLSIGN_CHARS: 20,
}));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
// A town the member typed, so the list is nearest first from a place.
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => ({ lat: -28.65, lng: 153.6, name: 'Mullumbimby' })), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import { FIND_COMMUNITY_WORDS, pluralKey, setLanguage } from '@beanpool/core';
import FindCommunityScreen from '../../app/find-community';

const FAR_ONE = 'The nearest listed is far from here:';
const FAR_MANY = 'The nearest listed are far from here:';
// A French catalog that gives every one of these keys a value (the drafting pass will write the real ones).
const FR = {
    [FIND_COMMUNITY_WORDS.noneNear]: 'Aucune communauté près de chez vous pour l’instant.',
    [FIND_COMMUNITY_WORDS.notLoaded]: 'La liste des communautés n’est pas disponible. Réessayez bientôt.',
    [pluralKey(FAR_ONE, FAR_MANY)]: { one: 'La plus proche est loin d’ici :', other: 'Les plus proches sont loin d’ici :' },
    [FIND_COMMUNITY_WORDS.notAnswering]: 'Ne répond pas ces derniers temps',
};
const lismore = (key: string, distanceKm: number) => ({
    key, name: `Lismore ${key}`, url: `https://${key}.example`, lat: null, lng: null, radiusKm: null, memberCount: 12, contactEmail: null, contactPhone: null, distanceKm,
});

async function render(): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(FindCommunityScreen as any) as unknown as Parameters<Root['render']>[0]); });
    // The typed town, then the list read from it.
    await act(async () => {});
    await act(async () => {});
    return host;
}
const line = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
    document.body.innerHTML = '';
    listing.communities = [];
    listing.fetchedAt = '2026-10-14T08:00:00.000Z';
});
afterEach(() => setLanguage('en'));

describe('Find a community says "nothing near" in one language', () => {
    it('in English, as it always has', async () => {
        listing.communities = [lismore('a', 12_489)];
        expect(line(await render(), 'find-far')).toBe(`No community near you yet. ${FAR_ONE}`);
    });

    it('the far line is all French when the catalog has both halves', async () => {
        setLanguage('fr', [FR]);
        listing.communities = [lismore('a', 12_489)];
        expect(line(await render(), 'find-far')).toBe('Aucune communauté près de chez vous pour l’instant. La plus proche est loin d’ici :');
        document.body.innerHTML = '';
        listing.communities = [lismore('a', 12_489), lismore('b', 12_530)];
        expect(line(await render(), 'find-far')).toBe('Aucune communauté près de chez vous pour l’instant. Les plus proches sont loin d’ici :');
    });

    it('"none" and "not loaded" are French too', async () => {
        setLanguage('fr', [FR]);
        expect(line(await render(), 'find-empty')).toBe(FR[FIND_COMMUNITY_WORDS.noneNear]);
        document.body.innerHTML = '';
        listing.fetchedAt = null;
        expect(line(await render(), 'find-empty')).toBe(FR[FIND_COMMUNITY_WORDS.notLoaded]);
    });
});

describe('a community gone quiet says so under its name (front doors S13)', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const quiet = (host: HTMLElement, key: string) => line(host, `find-not-answering-${key}`);

    it('"Not answering lately" past 36 h since its last push, and not before; Ask to join stays', async () => {
        listing.communities = [
            { ...lismore('a', 12), lastSeenAt: hoursAgo(40) },
            { ...lismore('b', 20), lastSeenAt: hoursAgo(35) },
            { ...lismore('c', 30), lastSeenAt: hoursAgo(2) },
            { ...lismore('d', 40), lastSeenAt: null },
        ];
        const host = await render();
        expect(quiet(host, 'a')).toBe(FIND_COMMUNITY_WORDS.notAnswering);
        expect(quiet(host, 'b')).toBeNull();
        expect(quiet(host, 'c')).toBeNull();
        expect(quiet(host, 'd')).toBeNull();
        expect(host.querySelector('[aria-label="Ask to join Lismore a"]')).not.toBeNull();
    });

    it('in the member\'s language', async () => {
        setLanguage('fr', [FR]);
        listing.communities = [{ ...lismore('a', 12), lastSeenAt: hoursAgo(40) }];
        expect(quiet(await render(), 'a')).toBe('Ne répond pas ces derniers temps');
    });
});

describe('the listing promise under a community\'s name (mothership A3)', () => {
    const promised = (host: HTMLElement, key: string) => line(host, `find-promise-${key}`);
    const PROMISE = { v: 1, owners: 2, backups: true, reports: true, notice: true };
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    it('says "Keeps the listing promise", "Accepting members" and the closing day, as the directory gave them', async () => {
        listing.communities = [{ ...lismore('a', 12), promise: PROMISE, acceptingKnocks: true, closingOn: inDays(20) }];
        const text = promised(await render(), 'a');
        expect(text).toContain('Keeps the listing promise');
        expect(text).toContain('Accepting members');
        expect(text).toContain('Closing on ');
        expect(text).not.toContain('{date}');
    });

    it('"New listing" when the node says it has no promise; nothing at all from an older node', async () => {
        listing.communities = [
            { ...lismore('a', 12), promise: null, acceptingKnocks: false, closingOn: null },
            lismore('b', 20),
        ];
        const host = await render();
        expect(promised(host, 'a')).toBe('New listing');
        expect(promised(host, 'b')).toBeNull();
    });

    it('in the member\'s language', async () => {
        setLanguage('fr', [{
            [FIND_COMMUNITY_WORDS.keepsPromise]: 'Tient sa promesse d’inscription',
            [FIND_COMMUNITY_WORDS.acceptingMembers]: 'Accepte des membres',
        }]);
        listing.communities = [{ ...lismore('a', 12), promise: PROMISE, acceptingKnocks: true }];
        expect(promised(await render(), 'a')).toBe('Tient sa promesse d’inscription · Accepte des membres');
    });
});

/**
 * The rule on Find a community's yes (Marty, board card balance-rule-other-doors, 3 Nov 2026: "Yes, show the sentence"):
 * a community that said yes offers Join, and above it, where that community confirms its members, the one sentence its
 * join screen and rules page say, read from the community itself. Nothing to tick or tap. Before this the yes said
 * nothing of the rule: the "rule on" tests fail there.
 */
describe("the community's rule on Find a community's yes", () => {
    const RULE = { known: true, knownFloor: 100, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null };
    const SENTENCE = "The admins can see a confirmed member's balance if they owe more than half their credit line, or are in debit and haven't made a sale for 60 days. Each look is logged.";
    const ruleAnswer = { body: null as Record<string, unknown> | null, asked: [] as string[] };
    const realFetch = globalThis.fetch;
    beforeEach(async () => {
        ruleAnswer.body = null;
        ruleAnswer.asked = [];
        globalThis.fetch = vi.fn(async (input: unknown) => {
            const u = String(input);
            ruleAnswer.asked.push(u);
            if (u.endsWith('/api/community/known-rule')) {
                return ruleAnswer.body
                    ? new Response(JSON.stringify(ruleAnswer.body), { status: 200 })
                    : new Response('{"error":"Not found"}', { status: 404 });
            }
            throw new TypeError(`Network request failed: ${u}`);
        }) as typeof fetch;
        const knock = await import('../knock');
        vi.mocked(knock.knockCardState).mockReturnValue({ kind: 'invited', note: 'A member invited you. Join now to become a member.', invite: 'BP-LISA-0001' } as any);
    });
    afterEach(async () => {
        globalThis.fetch = realFetch;
        const knock = await import('../knock');
        vi.mocked(knock.knockCardState).mockReturnValue({ kind: 'ask' } as any);
    });
    const yes = async () => {
        listing.communities = [lismore('a', 12)];
        const host = await render();
        for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
        return host;
    };

    it('rule on: the sentence above Join, read from that community, and nothing to tick', async () => {
        ruleAnswer.body = RULE;
        const host = await yes();
        expect(host.querySelector('[aria-label="Join Lismore a"]')).not.toBeNull();
        expect(line(host, 'find-join-rule')).toBe(SENTENCE);
        expect(ruleAnswer.asked).toContain('https://a.example/api/community/known-rule');
        expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it("rule on, in the member's language: the catalog's sentence, its numbers filled", async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const coreDe = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/de.json'), 'utf8'));
        setLanguage('de', [coreDe]);
        ruleAnswer.body = RULE;
        const said = line(await yes(), 'find-join-rule');
        expect(said).not.toBeNull();
        expect(said).not.toBe(SENTENCE);
        expect(said).toContain('60');
        expect(said).not.toMatch(/[{}]/);
    });

    it('rule off: Join, and no sentence', async () => {
        ruleAnswer.body = { known: false };
        const host = await yes();
        expect(host.querySelector('[aria-label="Join Lismore a"]')).not.toBeNull();
        expect(line(host, 'find-join-rule')).toBeNull();
    });

    it('an older node (404): no sentence', async () => {
        ruleAnswer.body = null;
        const host = await yes();
        expect(host.querySelector('[aria-label="Join Lismore a"]')).not.toBeNull();
        expect(line(host, 'find-join-rule')).toBeNull();
    });

    it('a community not yet asked: Ask to join, and nothing read for the rule', async () => {
        const knock = await import('../knock');
        vi.mocked(knock.knockCardState).mockReturnValue({ kind: 'ask' } as any);
        ruleAnswer.body = RULE;
        const host = await yes();
        expect(host.querySelector('[aria-label="Ask to join Lismore a"]')).not.toBeNull();
        expect(line(host, 'find-join-rule')).toBeNull();
        expect(ruleAnswer.asked.filter((u) => u.endsWith('/known-rule'))).toEqual([]);
    });
});
