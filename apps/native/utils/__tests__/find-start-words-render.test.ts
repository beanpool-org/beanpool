// @vitest-environment jsdom
/**
 * Finding and starting a community in the member's language (words slice S3, sweep B11): Find a community
 * (app/find-community.tsx, with the lower layers' sentences it shows through components/find-community-lines.ts), Start a
 * community (app/start-community.tsx) and the Manage press (components/useManageNode.tsx), drawn for real inside the real
 * LanguageProvider. React Native's host components are plain tags (profile-events-words-harness.ts); the worldwide node,
 * the communities asked, the phone's location and the sign-in to Settings are stubbed at their modules.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). What members, communities and servers wrote is shown
 * as written: a community's name and its own refusal, a server's name, a typed town.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => (await import('./profile-events-words-harness')).nativeMock(alerts));
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => h('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const pass = ({ children }: { children?: unknown }) => h('div', null, children as any);
    return { KeyboardAwareScrollView: pass, KeyboardAvoidingView: pass };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, navigate: () => {} },
    useLocalSearchParams: () => nav.params,
    ErrorBoundary: () => null,
}));
vi.mock('@expo/vector-icons', async () => {
    const { createElement: h } = await import('react');
    return { MaterialCommunityIcons: ({ name }: { name: string }) => h('i', { 'data-icon': name }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => ({})) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.70' } } }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: false })),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'uuid' };
});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async () => {}),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const who = vi.hoisted(() => ({ value: { identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));

/** The worldwide node's directory and watches, and the communities asked: set per case. */
const world = vi.hoisted(() => ({
    list: { ok: true, value: { communities: [] as any[], total: 0, fetchedAt: '2026-10-19T00:00:00.000Z' as string | null } } as any,
    watches: [] as any[],
    watchAnswer: { ok: true, value: { id: 'w1', lat: -28.6, lng: 153.6, radiusKm: 10 } } as any,
    knocks: [] as any[],
    statuses: {} as Record<string, any>,
    send: { kind: 'waiting', message: '' } as any,
    join: null as null | Error,
    typed: null as null | { lat: number; lng: number; name: string | null },
    claim: { kind: 'claimed' } as any,
}));
vi.mock('../community-directory', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchCommunities: vi.fn(async () => world.list),
    fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: world.watches } })),
    watchPlace: vi.fn(async () => world.watchAnswer),
    unwatchPlace: vi.fn(async () => ({ ok: true, value: true })),
}));
vi.mock('../knock', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    sendKnock: vi.fn(async () => world.send),
    readKnockStatus: vi.fn(async (url: string) => world.statuses[url] ?? { ok: true, value: { status: 'pending' } }),
    rememberedKnocks: vi.fn(async () => world.knocks),
    rememberKnock: vi.fn(async () => {}),
    forgetKnock: vi.fn(async () => {}),
}));
vi.mock('../join-another-community', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    joinAnotherCommunity: vi.fn(async () => { if (world.join) throw world.join; return { name: 'Lismore Commons', alreadyMember: false }; }),
}));
vi.mock('../typed-place', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readTypedPlace: vi.fn(async () => world.typed),
    saveTypedPlace: vi.fn(async () => null),
    forgetTypedPlace: vi.fn(async () => {}),
}));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => world.claim) }));
/** The Manage press's steps (utils/node-admin.ts), and where the phone is. */
const manage = vi.hoisted(() => ({ outcome: { kind: 'opened' } as any, anchor: 'https://mullum.example' as string | null }));
vi.mock('../node-admin', async (importOriginal) => ({ ...(await importOriginal<object>()), manageNode: vi.fn(async () => manage.outcome) }));
vi.mock('../node-post', async (importOriginal) => ({ ...(await importOriginal<object>()), anchorUrl: vi.fn(async () => manage.anchor) }));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import FindCommunityScreen from '../../app/find-community';
import StartCommunityScreen from '../../app/start-community';
import { useManageNode } from '../../components/useManageNode';
import { KNOCK_MESSAGES } from '../knock';
import { NO_DEVICE_LOCK_MESSAGE } from '../node-admin';
import { UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import { bypassing, bracketed, unfit } from './profile-events-words-harness';

const LISMORE = 'https://lismore.example';
const BYRON = 'https://byron.example';
const community = (key: string, name: string, url: string, distanceKm: number) => ({
    key, name, url, lat: null, lng: null, radiusKm: null, memberCount: 12, contactEmail: null, contactPhone: null, distanceKm,
});
/** What communities and servers wrote: names, a town, a refusal in a community's own words, an address. */
const WRITTEN = ['Lismore Commons', 'Byron Seed Library', 'Mullum Commons', 'Mullumbimby', 'We only take members from the valley.', 'Valley Server',
    'https://valley.example', 'valley.example', 'lismore.example', 'Wren'];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    nav.params = {};
    nav.pushed.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://global.example');
    world.list = { ok: true, value: { communities: [community('a', 'Lismore Commons', LISMORE, 12), community('b', 'Byron Seed Library', BYRON, 30)], total: 2, fetchedAt: '2026-10-19T00:00:00.000Z' } };
    world.watches = [];
    world.knocks = [];
    world.statuses = {};
    world.send = { kind: 'waiting', message: KNOCK_MESSAGES.waiting };
    world.join = null;
    world.typed = { lat: -28.65, lng: 153.6, name: 'Mullumbimby' };
    world.claim = { kind: 'claimed' };
    manage.outcome = { kind: 'opened' };
    manage.anchor = 'https://mullum.example';
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, element: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, element as any) as any); });
    await settle();
}
const xx = (s: string) => pseudoLocalise(s);
const byLabel = (shown: string) => host.querySelector(`[aria-label="${shown.replace(/"/g, '\\"')}"]`);
const buttonReading = (shown: string) => Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(shown)) ?? null;
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el as HTMLInputElement, text);
        (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};

describe('Find a community in the pseudo-locale: every word came through t() (words S3l)', () => {
    it('a typed town: the header, the lead, the list and its cards, Ask to join, nothing near, Start, Tell me', async () => {
        await renderIn('xx', createElement(FindCommunityScreen));
        expect(host.textContent).toContain(xx('FIND A COMMUNITY'));
        expect(host.textContent).toContain(xx('NEAREST FIRST'));
        expect(host.textContent).toContain(xx('Near {name}').replace('{name}', 'Mullumbimby'));
        expect(host.textContent).toContain(xx('Ask to join'));
        expect(byLabel(xx('Ask to join {name}').replace('{name}', 'Lismore Commons'))).not.toBeNull();
        expect(host.textContent).toContain(xx('NOTHING NEAR YOU?'));
        expect(host.textContent).toContain(xx('Start a community'));
        expect(host.textContent).toContain(xx('Only the area (about 10 km) is kept, never where you are exactly.'));
        expect(host.querySelector(`[placeholder="${xx('Community name')}"]`)).not.toBeNull();
        expect(bracketed(host)).toBeGreaterThan(15);
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it('the ask form: its labels, a problem with the form, a refusal in the community\'s own words, Cancel', async () => {
        await renderIn('xx', createElement(FindCommunityScreen));
        await click(byLabel(xx('Ask to join {name}').replace('{name}', 'Lismore Commons')), 'Ask to join');
        expect(host.textContent).toContain(xx('A few words about yourself'));
        expect(host.querySelector(`[placeholder="${xx("Where you live, what you'd like to share or learn")}"]`)).not.toBeNull();
        await click(buttonReading(xx('Send')), 'Send');
        expect(host.textContent).toContain(xx('Please say a few words about yourself.'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        const box = byLabel(xx('A few words about yourself'));
        await type(box, 'I grow tomatoes.');
        world.send = { kind: 'refused', status: 403, code: null, message: 'We only take members from the valley.' };
        await click(buttonReading(xx('Send')), 'Send');
        expect(host.textContent).toContain('We only take members from the valley.');
        expect(bypassing(host, [...WRITTEN, 'I grow tomatoes.'], alerts.said)).toEqual([]);
    });

    it('the requests asked: waiting, a yes with Join, unreachable with Check again; joining and its nudge; a join that failed', async () => {
        world.knocks = [
            { url: LISMORE, name: 'Lismore Commons', key: 'a', sentAt: '2026-10-18T00:00:00.000Z' },
            { url: BYRON, name: 'Byron Seed Library', key: 'b', sentAt: '2026-10-18T00:00:00.000Z' },
            { url: 'https://valley.example', name: null, key: null, sentAt: '2026-10-18T00:00:00.000Z' },
        ];
        world.statuses = {
            [LISMORE]: { ok: true, value: { status: 'approved', invite: 'ABC123', expiresAt: null } },
            [BYRON]: { ok: true, value: { status: 'pending' } },
            'https://valley.example': { ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable },
        };
        await renderIn('xx', createElement(FindCommunityScreen));
        expect(host.textContent).toContain(xx('YOUR REQUESTS TO JOIN'));
        expect(host.textContent).toContain(xx(KNOCK_MESSAGES.invited));
        expect(host.textContent).toContain(xx(KNOCK_MESSAGES.waiting));
        expect(host.textContent).toContain(xx(KNOCK_MESSAGES.unreachable));
        expect(host.textContent).toContain(xx('Check again'));
        expect(host.textContent).toContain(xx('The others are in the list below.'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await click(byLabel(xx('Join {name}').replace('{name}', 'Lismore Commons')), 'Join');
        expect(alerts.said[0]).toBe(xx("You're in {name}").replace('{name}', 'Lismore Commons'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        alerts.said.length = 0;
        world.join = new Error(UNSAFE_NODE_ADDRESS_MESSAGE);
        await click(byLabel(xx('Join {name}').replace('{name}', 'Lismore Commons')), 'Join');
        expect(alerts.said).toEqual([xx("Couldn't join"), xx(UNSAFE_NODE_ADDRESS_MESSAGE)]);
        // redeemInvite's own sentences (utils/db.ts), rethrown by joinAnotherCommunity; the community's words as given.
        // REDEEM_NO_ANSWER, written again: db.ts isn't loaded here (welcome-lines.test.ts holds the table to the constant).
        const REDEEM_NO_ANSWER = 'No answer from the community node in time. Check your connection and try again.';
        const cases: Array<[string, string]> = [
            ['Relay Node Offline: The selected community node is currently unreachable (HTTP 502).',
                xx('Relay Node Offline: The selected community node is currently unreachable (HTTP {status}).').replace('{status}', '502')],
            ['Failed to redeem invite (HTTP 500)', xx('Failed to redeem invite (HTTP {status})').replace('{status}', '500')],
            [REDEEM_NO_ANSWER, xx(REDEEM_NO_ANSWER)],
            ['This invite has expired.', 'This invite has expired.'],
        ];
        for (const [thrown, body] of cases) {
            world.join = new Error(thrown);
            alerts.said.length = 0;
            await click(byLabel(xx('Join {name}').replace('{name}', 'Lismore Commons')), 'Join');
            expect(alerts.said, thrown).toEqual([xx("Couldn't join"), body]);
        }
    });

    it('no place: Use my location, location off, the town search, its Cancel; the list not loaded; watching a place', async () => {
        world.typed = null;
        world.list = { ok: true, value: { communities: [], total: 0, fetchedAt: null } };
        await renderIn('xx', createElement(FindCommunityScreen));
        expect(host.textContent).toContain(xx('COMMUNITIES'));
        expect(host.textContent).toContain(xx('or type your town'));
        expect(host.textContent).toContain(xx('Use your location or type your town first, so we know where "here" is.'));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await click(buttonReading(xx('Use my location')), 'Use my location');
        expect(host.textContent).toContain(xx('Location is off for BeanPool. Type your town instead, or search by name below.'));
        expect(host.querySelector(`[placeholder="${xx('Your town or suburb')}"]`)).not.toBeNull();
        expect(byLabel(xx('Cancel the town search'))).not.toBeNull();
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });

    it("the list didn't come, a name not listed, a server with no owner yet, and a watch with its line and Stop", async () => {
        world.list = { ok: false, kind: 'unreachable', message: "Couldn't reach the worldwide community. Check your connection and try again." };
        world.watches = [{ id: 'w1', lat: -28.64, lng: 153.61, radiusKm: 10 }];
        await renderIn('xx', createElement(FindCommunityScreen));
        expect(host.textContent).toContain(xx("Couldn't reach the worldwide community. Check your connection and try again."));
        expect(host.textContent).toContain(xx('Try again'));
        expect(host.textContent).toContain(xx('Within {km} km').replace('{km}', '10'));
        expect(byLabel(xx('Stop watching this place'))).not.toBeNull();
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await click(buttonReading(xx('Tell me')), 'Tell me');
        expect(host.textContent).toContain(xx("Done. You'll be told when a community starts near here."));
        world.list = { ok: true, value: { communities: [], total: 0, fetchedAt: '2026-10-19T00:00:00.000Z' } };
        world.claim = { kind: 'unclaimed', communityName: 'Valley Server', codeId: 'c1' };
        await type(byLabel(xx('Search communities by name')), 'valley.example');
        await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
        await settle();
        expect(host.textContent).toContain(xx('No community by that name is listed.'));
        expect(host.textContent).toContain(xx('{name} has no owner yet').replace('{name}', 'Valley Server'));
        expect(host.textContent).toContain(xx('Claim {name}').replace('{name}', 'Valley Server'));
        expect(bypassing(host, [...WRITTEN, 'valley.example'], alerts.said)).toEqual([]);
    });
});

describe('Start a community in the pseudo-locale', () => {
    it('the header in capitals the language\'s way, the three ways, the details, the copy and its note', async () => {
        await renderIn('xx', createElement(StartCommunityScreen));
        const header = host.querySelector('[role="heading"]')!;
        expect(header.textContent).toMatch(/^\[.*\]$/s);
        expect(header.getAttribute('data-transform')).toBeNull();
        expect(host.textContent).toContain(xx('THREE WAYS TO RUN ONE'));
        expect(host.textContent).toContain(xx('A spare computer'));
        expect(host.textContent).toContain(xx('How to run a node, on beanpool.org'));
        expect(byLabel(xx('Community name'))).not.toBeNull();
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
        await type(byLabel(xx('Community name')), 'Mullum Commons');
        await click(buttonReading(xx("Copy my community's details")), 'Copy');
        expect(host.textContent).toContain(xx("Copied. Paste them into your node's settings app."));
        expect(bypassing(host, WRITTEN, alerts.said)).toEqual([]);
    });
});

describe('the Manage press in the pseudo-locale: its alerts', () => {
    function Probe() {
        const m = useManageNode();
        return createElement('div', null, m.dialog, createElement('button', { 'data-testid': 'manage', onClick: () => { void m.start('Mullum Commons'); } }));
    }
    const press = async () => { await click(host.querySelector('[data-testid="manage"]'), 'Manage'); };

    it('no screen lock, a refusal with no words, the node\'s own words, not connected', async () => {
        await renderIn('xx', createElement(Probe));
        manage.outcome = { kind: 'no-device-lock' };
        await press();
        expect(alerts.said).toEqual([xx('Set a screen lock first'), xx(NO_DEVICE_LOCK_MESSAGE)]);
        alerts.said.length = 0;
        manage.outcome = { kind: 'refused', message: 'You do not hold an owner, admin or moderator role on this node.' };
        await press();
        expect(alerts.said).toEqual([xx("Can't open {name}'s settings").replace('{name}', 'Mullum Commons'), xx('You do not hold an owner, admin or moderator role on this node.')]);
        alerts.said.length = 0;
        manage.outcome = { kind: 'error', message: 'The node did not answer (502).' };
        await press();
        expect(alerts.said[1]).toBe(xx('The node did not answer ({status}).').replace('{status}', '502'));
        alerts.said.length = 0;
        manage.outcome = { kind: 'refused', message: 'Settings are closed for maintenance.' };
        await press();
        expect(alerts.said[1]).toBe('Settings are closed for maintenance.');
        alerts.said.length = 0;
        manage.anchor = null;
        await press();
        expect(alerts.said).toEqual([xx('Not connected'), xx('Connect to your community first.')]);
    });
});

describe('in English nothing is bracketed, and the words are as they were', () => {
    it('Find a community and Start a community', async () => {
        await renderIn('en', createElement(FindCommunityScreen));
        expect(bracketed(host)).toBe(0);
        for (const english of ['FIND A COMMUNITY', 'Communities are where neighbours trade and help each other. Ask to join one near you: any member there can let you in.',
            'NEAREST FIRST', 'Near Mullumbimby', 'change', 'Ask to join', 'Start a community', 'What it takes, and how to begin', 'Tell me when one starts here', 'Tell me']) {
            expect(host.textContent, english).toContain(english);
        }
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('en', createElement(StartCommunityScreen));
        expect(bracketed(host)).toBe(0);
        for (const english of ['START A COMMUNITY', 'THREE WAYS TO RUN ONE', 'A small rented server', "YOUR COMMUNITY'S DETAILS", 'What will it be called?', "Copy my community's details"]) {
            expect(host.textContent, english).toContain(english);
        }
    });
});

describe('the two screens at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('no word wider than the page (320 - 2 × 16), nothing stuck in a row; the headers shrink to one line', async () => {
        world.knocks = [{ url: LISMORE, name: 'Lismore Commons', key: 'a', sentAt: '2026-10-18T00:00:00.000Z' }];
        world.statuses = { [LISMORE]: { ok: true, value: { status: 'approved', invite: 'ABC123', expiresAt: null } } };
        world.watches = [{ id: 'w1', lat: -28.64, lng: 153.61, radiusKm: 10 }];
        await renderIn('xx', createElement(FindCommunityScreen));
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
        expect(host.querySelector('[role="heading"]')?.getAttribute('data-shrinks')).toBe('true');
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('xx', createElement(StartCommunityScreen));
        expect(unfit(host, 320 - 32, WRITTEN)).toEqual([]);
        expect(host.querySelector('[role="heading"]')?.getAttribute('data-shrinks')).toBe('true');
    });
});

describe('Find a community follows a language picked while it is open', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws it in French from the real catalog', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(FindCommunityScreen)),
                createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(byLabel('Back')).not.toBeNull();
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        for (const key of ['Back', 'Ask to join']) {
            expect(typeof fr[key], key).toBe('string');
        }
        expect(byLabel(fr.Back as string)).not.toBeNull();
        expect(host.textContent).toContain(fr['Ask to join'] as string);
        expect(byLabel('Back')).toBeNull();
    });
});
