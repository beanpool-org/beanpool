// @vitest-environment jsdom
/**
 * "Roughly where are you?" (design DESIGN-global-sync-by-area §3.1-3.2, slice S4): the real profile-setup wizard
 * (app/profile-setup.tsx) and its area step (components/AreaPicker.tsx, utils/member-area.ts), rendered at the floor's
 * window (320 x 569 dp, text at 1.3x) with react-dom in jsdom and React Native's host components as plain tags. The
 * community, the location reading and the town search are stubbed at the boundary; every request is recorded.
 *
 * Nothing here draws a frame (vitest.config.ts): what is checked is the wizard's steps, its words, the controls' sizes
 * as styled, and the requests it makes. The step is there only on a community that says `nearbyListings`; Skip joins
 * nothing and writes nothing; a position is rounded to 0.1° before any request is built.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, value, onChangeText, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (tag === 'button') attrs['data-style'] = JSON.stringify(Object.assign({}, ...[style].flat(3).filter(Boolean)));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity: vi.fn() }) }));
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/OnboardingGuide', () => ({ OnboardingGuide: () => createElement('div', { 'data-testid': 'guide' }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
const prof = vi.hoisted(() => ({ value: null as any }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => prof.value }));
vi.mock('../identity', () => ({ updateCallsign: vi.fn(async () => null) }));
vi.mock('../db', () => ({ getMemberProfile: vi.fn(async () => ({ avatar_url: '/api/avatar/aaa?size=thumb' })), updateMemberProfile: vi.fn(async () => undefined) }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../callsign-suggest', () => ({ checkCallsignAvailable: vi.fn(async () => 'available'), suggestCallsigns: vi.fn(async () => []) }));
// The signature is the request-binding suite's business: here it records what was signed, so a test can see that the
// precise position was never in it.
const signed = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string; body: string }> }));
vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string) => {
        signed.calls.push({ method, url, body });
        return { 'Content-Type': 'application/json', 'X-Public-Key': 'a'.repeat(64) };
    }),
}));
const BYRON = { displayName: 'Byron Bay, New South Wales, Australia', shortName: 'Byron Bay', lat: -28.647412, lng: 153.612031, type: 'town' };
vi.mock('../../components/AddressSearch', () => ({
    AddressSearch: ({ onPick }: { onPick: (r: typeof BYRON) => void }) => createElement('button', { 'data-testid': 'pick-byron', onClick: () => onPick(BYRON) }, 'Byron Bay'),
}));
const loc = vi.hoisted(() => ({ status: 'granted', canAsk: true, asked: 0, coords: { latitude: -28.647412, longitude: 153.612031 } }));
vi.mock('expo-location', () => ({
    Accuracy: { Low: 2 },
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: loc.status === 'ask' ? 'undetermined' : loc.status })),
    requestForegroundPermissionsAsync: vi.fn(async () => { loc.asked += 1; return { status: loc.status === 'ask' ? 'denied' : loc.status }; }),
    getCurrentPositionAsync: vi.fn(async () => ({ coords: loc.coords })),
}));

import ProfileSetupScreen from '../../app/profile-setup';
import YourAreaScreen from '../../app/your-area';
import { profileSteps, areaOf, describeArea, AREA_WORDS, writeMemberArea } from '../member-area';
import { readNodeProfile } from '../node-profile';
import { roundToArea } from '@beanpool/core';

const NODE = 'https://global.example.test';
const GLOBAL_FEATURES = { openJoin: true, beans: false, nearbyListings: { radiusKm: 250, max: 500 } };
const LOCAL_FEATURES = { beans: true, invites: true };

let host: HTMLElement | null = null;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: string | undefined }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE);
    nav.params = { name: 'Sally', redirect: '/(tabs)' };
    signed.calls = [];
    requests = [];
    loc.status = 'granted';
    loc.asked = 0;
    answer = { status: 200, body: { success: true, area: { lat: -28.6, lng: 153.6, updatedAt: '2026-10-11T00:00:00.000Z' } } };
    (globalThis as any).fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    });
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function render(features: unknown, screen: () => unknown = ProfileSetupScreen as () => unknown) {
    prof.value = features ? { profile: 'global', features, checkedAt: new Date().toISOString() } : null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(screen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const text = () => document.body.textContent ?? '';
async function press(selector: string) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`nothing matches ${selector}`);
    await act(async () => { el.click(); });
    await settle();
}
const nextButton = () => Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Next →') as HTMLElement;
async function toAreaStep() {
    await act(async () => { nextButton().click(); });
    await settle();
}

describe('profile setup: the area step (S4)', () => {
    it('is the third of four steps on a community that syncs by area, after the photo', async () => {
        await render(GLOBAL_FEATURES);
        expect(text()).toContain('Step 2 of 4');
        await toAreaStep();
        expect(text()).toContain('Step 3 of 4');
        expect(document.querySelector('[role="heading"]')?.textContent).toBe('Roughly where are you?');
    });

    it("is not there on a local community: the photo's Next goes to the guide, three steps as before", async () => {
        await render(LOCAL_FEATURES);
        expect(text()).toContain('Step 2 of 3');
        await toAreaStep();
        expect(text()).toContain('Step 3 of 3');
        expect(text()).not.toContain(AREA_WORDS.title);
        expect(document.querySelector('[data-testid="guide"]')).not.toBeNull();
        // Nor on a node whose profile this phone hasn't heard yet.
        expect(profileSteps(null)).toEqual(['name', 'avatar', 'guide']);
        expect(profileSteps({ nearbyListings: undefined })).toEqual(['name', 'avatar', 'guide']);
    });

    it('says the words of §3.2, with the numbers the node gives, and no currency', async () => {
        await render({ ...GLOBAL_FEATURES, nearbyListings: { radiusKm: 250, max: 500 } });
        await toAreaStep();
        const t = text();
        expect(t).toContain("The worldwide community shows you what's on offer near you: the nearest 500 listings within 250 km.");
        expect(t).toContain('We keep your area to about 10 km, never your exact spot. Other members see only a distance in km.');
        for (const w of [AREA_WORDS.useLocation, AREA_WORDS.typeTown, AREA_WORDS.skip, AREA_WORDS.later]) expect(t).toContain(w);
        expect(t).not.toMatch(/Ʀ|Beans/);
    });

    it('Skip joins nothing and writes nothing, and goes on to the guide', async () => {
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        const storeBefore = JSON.stringify([...mem.store.entries()]);
        await press('[data-testid="area-skip"]');
        expect(requests).toEqual([]);
        expect(signed.calls).toEqual([]);
        expect(loc.asked).toBe(0);
        expect(JSON.stringify([...mem.store.entries()])).toBe(storeBefore);
        expect(text()).toContain('Step 4 of 4');
        expect(document.querySelector('[data-testid="guide"]')).not.toBeNull();
    });

    it('Use my location rounds to 0.1° before the request is built: the precise position is never signed or sent', async () => {
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        await press('[data-testid="area-use-location"]');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toEqual({ url: `${NODE}/api/community/me/area`, method: 'POST', body: JSON.stringify({ lat: -28.6, lng: 153.6 }) });
        expect(signed.calls).toEqual([{ method: 'POST', url: `${NODE}/api/community/me/area`, body: '{"lat":-28.6,"lng":153.6}' }]);
        const everything = JSON.stringify({ requests, signed: signed.calls });
        expect(everything).not.toContain('647412');
        expect(everything).not.toContain('612031');
        expect(text()).toContain('Step 4 of 4');
    });

    it('a town typed is rounded the same way, and its name is kept on this phone only', async () => {
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        await press('[data-testid="area-type-town"]');
        await press('[data-testid="pick-byron"]');
        expect(requests.map(r => r.body)).toEqual(['{"lat":-28.6,"lng":153.6}']);
        expect(JSON.stringify(requests)).not.toContain('Byron');
        expect(mem.store.get(`beanpool_area_place:${NODE}`)).toBe('Byron Bay');
        expect(text()).toContain('Step 4 of 4');
    });

    it('location refused: one line, no request, still on the step, and Skip still goes on', async () => {
        loc.status = 'ask';
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        await press('[data-testid="area-use-location"]');
        expect(loc.asked).toBe(1);
        expect(requests).toEqual([]);
        expect(text()).toContain('Location is off for BeanPool. Type a town instead, or skip for now.');
        await press('[data-testid="area-skip"]');
        expect(text()).toContain('Step 4 of 4');
    });

    it('a refused save says so and never pretends: the step stays, Skip still goes on', async () => {
        answer = { status: 403, body: { error: 'Only a member of this community can set an area here' } };
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        await press('[data-testid="area-use-location"]');
        expect(text()).toContain('Only a member of this community can set an area here');
        expect(text()).toContain('Step 3 of 4');
        await press('[data-testid="area-skip"]');
        expect(text()).toContain('Step 4 of 4');
    });

    it('at 320 dp, 1.3x: every control on the step is at least 44 dp tall, full width, stacked', async () => {
        await render(GLOBAL_FEATURES);
        await toAreaStep();
        for (const id of ['area-use-location', 'area-type-town', 'area-skip']) {
            const style = JSON.parse((document.querySelector(`[data-testid="${id}"]`) as HTMLElement).dataset.style ?? '{}');
            expect(style.minHeight, id).toBeGreaterThanOrEqual(44);
            expect(style.width ?? 'auto', id).not.toMatch(/^\d/); // no fixed width that could overflow 320 dp
            expect(style.position, id).toBeUndefined();
        }
    });
});

describe('Settings → Your area (§3.5)', () => {
    it("shows the node's value with the town typed on this phone, and Clear writes both null and forgets the town", async () => {
        mem.store.set(`beanpool_area_place:${NODE}`, 'Byron Bay');
        answer = { status: 200, body: { publicKey: IDENTITY.publicKey, area: { lat: -28.6, lng: 153.6, updatedAt: '2026-10-11T00:00:00.000Z' } } };
        await render(GLOBAL_FEATURES, YourAreaScreen as () => unknown);
        expect(requests[0]).toMatchObject({ url: `${NODE}/api/community/me`, method: 'GET' });
        expect(document.querySelector('[data-testid="your-area-current"]')?.textContent).toBe('About 10 km around Byron Bay');
        answer = { status: 200, body: { success: true, area: null } };
        await press('[data-testid="your-area-clear"]');
        expect(requests[1]).toEqual({ url: `${NODE}/api/community/me/area`, method: 'POST', body: '{"lat":null,"lng":null}' });
        expect(document.querySelector('[data-testid="your-area-current"]')?.textContent).toBe('Not set');
        expect(mem.store.has(`beanpool_area_place:${NODE}`)).toBe(false);
        expect(document.querySelector('[data-testid="your-area-clear"]')).toBeNull();
    });

    it('Not set: no Clear; Change is the same step, its Cancel writes nothing and goes back', async () => {
        answer = { status: 200, body: { publicKey: IDENTITY.publicKey, area: null } };
        await render(GLOBAL_FEATURES, YourAreaScreen as () => unknown);
        expect(document.querySelector('[data-testid="your-area-current"]')?.textContent).toBe('Not set');
        expect(document.querySelector('[data-testid="your-area-clear"]')).toBeNull();
        expect(text()).toContain(AREA_WORDS.title);
        const before = requests.length;
        nav.router.back.mockClear();
        await press('[data-testid="area-skip"]');
        expect(document.querySelector('[data-testid="area-skip"]')?.textContent).toBe('Cancel');
        expect(requests.length).toBe(before);
        expect(nav.router.back).toHaveBeenCalledTimes(1);
    });

    it("a node that can't be asked: says so, never 'Not set'", async () => {
        answer = { status: 503, body: {} };
        await render(GLOBAL_FEATURES, YourAreaScreen as () => unknown);
        expect(document.querySelector('[data-testid="your-area-current"]')?.textContent).toBe("Couldn't check right now.");
    });
});

describe('member-area helpers', () => {
    it("areaOf is core's roundToArea on both axes (the engine's rule)", () => {
        expect(areaOf(-28.647412, 153.612031)).toEqual({ lat: -28.6, lng: 153.6 });
        expect(areaOf(-0.04, 179.97)).toEqual({ lat: roundToArea(-0.04), lng: 180 });
        expect(Object.is(areaOf(-0.04, 0).lat, -0)).toBe(false);
    });

    it('describeArea: a town, else two numbers, else Not set', () => {
        expect(describeArea(null)).toBe('Not set');
        expect(describeArea({ lat: -28.6, lng: 153.6 }, 'Byron Bay')).toBe('About 10 km around Byron Bay');
        expect(describeArea({ lat: -28.6, lng: 153.6 })).toBe('About 10 km around -28.6, 153.6');
    });

    it('writeMemberArea(null) clears with both null; a non-finite point sends nothing', async () => {
        answer = { status: 200, body: { success: true, area: null } };
        expect(await writeMemberArea(NODE, IDENTITY, null)).toEqual({ ok: true, area: null });
        expect(requests[0].body).toBe('{"lat":null,"lng":null}');
        requests = [];
        expect((await writeMemberArea(NODE, IDENTITY, { lat: Number.NaN, lng: 1 })).ok).toBe(false);
        expect(requests).toEqual([]);
    });

    it("the node's info: nearbyListings is kept only as two positive numbers", () => {
        expect(readNodeProfile({ profile: 'global', features: { nearbyListings: { radiusKm: 250, max: 500 } } })?.features.nearbyListings).toEqual({ radiusKm: 250, max: 500 });
        expect(readNodeProfile({ profile: 'global', features: { nearbyListings: true } })?.features.nearbyListings).toBeUndefined();
        expect(readNodeProfile({ profile: 'global', features: { nearbyListings: { radiusKm: '250', max: 500 } } })?.features.nearbyListings).toBeUndefined();
        expect(readNodeProfile({ profile: 'local', features: {} })?.features.nearbyListings).toBeUndefined();
    });
});
