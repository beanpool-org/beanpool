// @vitest-environment jsdom
/**
 * A switch lands on the community's Home, never on the newcomers' front door (director, 27 Nov, release 1.4.8 on Android 16:
 * Sam, a member of one community visiting another as a guest, tapped their own community on the BeanPool sheet and was shown
 * "I have an invite / No invite? Look around / I've used BeanPool before" until the app was stopped and opened again).
 *
 * Why it happened: every switch bounces through Welcome (use-communities.ts switchCommunity), where the root guard
 * (app/_layout.tsx) lands an account on the tabs. It decides by the root layout's recognition (app/NodeStatusContext.tsx), which
 * nothing asked again on the sheet's tap: it still said "stranger", the answer of the community left. A stranger on Welcome is
 * held there (mismatch-plan.ts notRecognisedStays), landed only if the community in use is marked a guest visit, and Sam's own
 * community isn't. A cold start asks afresh, so it landed.
 *
 * Every switch case x the answer held or in, and the app cold-started on each. Real: the app's own ask (NodeStatusContext.tsx),
 * the one switch (use-communities.ts), what the guard calls (member-landing.ts, mismatch-plan.ts). The guard's account branches
 * are copied below in app/_layout.tsx's order, and a pin at the end holds that order. In memory: the phone's storage, the switch's
 * database move, the router, and each community's answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const who = vi.hoisted(() => ({ publicKey: 'e5'.repeat(32), privateKey: 'f0'.repeat(32), callsign: 'Sam' }));
const RIVERSIDE = 'https://riverside.example';
const HILLSIDE = 'https://hillside.example';
const LAKESIDE = 'https://lakeside.example';
const ANCHOR = 'beanpool_anchor_url';

const phone = vi.hoisted(() => ({
    store: new Map<string, string>(),
    guests: new Set<string>(),
    /** Where the router is: the first segment of each screen it was sent to, in order. */
    routes: [] as string[],
    go: null as null | ((to: string) => void),
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: { alert: vi.fn() },
    DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
    AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => phone.store.get(k) ?? null,
        setItem: async (k: string, v: string) => { phone.store.set(k, v); },
        removeItem: async (k: string) => { phone.store.delete(k); },
    },
}));
vi.mock('expo-router', () => ({
    router: { canDismiss: () => true, dismissAll() {}, replace: (to: string) => phone.go!(to), push: (to: string) => phone.go!(to) },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who }) }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => null }));
vi.mock('../blocklist', () => ({ blocksAtMember: async () => {}, communityKeepsNoBlocks: async () => {} }));
vi.mock('../nodes', () => ({
    isGuestNode: async (url: string) => phone.guests.has(url),
    clearGuestNode: async (url: string) => { phone.guests.delete(url); },
    getSavedNodes: async () => [], removeSavedNode: async () => {}, addSavedNode: async () => {},
}));
// The switch's own move (reconnect.ts switchPhoneTo: the record, the copy, the address, the update screen told), its one write.
vi.mock('../reconnect', () => ({ switchPhoneTo: async (url: string) => { phone.store.set(ANCHOR, url); } }));

// ── each community's answer ──────────────────────────────────────────────────────────────────────────────────────────
type Stands = 'member' | 'guest' | 'stranger';
let stands: Record<string, Stands>;
/** A community whose next answer is held until it is let go. */
let holdNext: { at: string; until: Promise<void> } | null;
vi.mock('../membership-probe', () => ({
    fetchMembership: async (url: string) => {
        if (holdNext?.at === url) {
            const { until } = holdNext;
            holdNext = null;
            await until;
        }
        const member = stands[url] === 'member';
        return new Response(JSON.stringify(member ? { isMember: true, callsign: 'Sam' } : { isMember: false, isRecovering: false }), { status: 200 });
    },
}));

import { NodeStatusProvider, useNodeStatus } from '../../app/NodeStatusContext';
import { guestRedirect, memberRedirect } from '../member-landing';
import { notRecognisedStays } from '../mismatch-plan';
import { switchCommunity } from '../use-communities';

// ── the app ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const segmentsOf = (to: string): string[] => to.replace(/^\//, '').split('/').filter(Boolean);
let recognition = '';

/**
 * The root guard's branches for an account on a community with no join part-way (app/_layout.tsx, after its wizard and
 * no-community holds), in its order: recovering, closed, stranger (the guest mark read as it reads it), a member back from
 * the not-recognised screen, then the member landing.
 */
function Guard({ segments }: { segments: string[] }) {
    const status = useNodeStatus();
    recognition = status.recognition;
    useEffect(() => {
        const r = status.recognition;
        const root = segments[0];
        if (r === 'recovering') return;
        if (r === 'closed') {
            if (!notRecognisedStays('closed', segments)) phone.go!('/node-mismatch');
            return;
        }
        if (r === 'stranger') {
            const anchor = phone.store.get(ANCHOR) ?? null;
            if (!notRecognisedStays('stranger', segments)) {
                void (async () => { if (anchor && phone.guests.has(anchor)) return; phone.go!('/node-mismatch'); })();
            } else if (root === 'welcome') {
                void (async () => {
                    if (!anchor || !phone.guests.has(anchor)) return;
                    const landing = guestRedirect(segments, who.publicKey);
                    if (landing) phone.go!(landing);
                })();
            }
            return;
        }
        if (r === 'member' && (root === 'node-mismatch' || root === 'recover-identity')) { phone.go!('/(tabs)'); return; }
        const landing = memberRedirect(segments, who.publicKey);
        if (landing) phone.go!(landing);
    }, [status.recognition, segments]);
    return null;
}
function App({ start }: { start: string[] }) {
    const [segments, setSegments] = useState<string[]>(start);
    phone.go = (to) => { const s = segmentsOf(to); phone.routes.push(s[0] ?? ''); setSegments(s); };
    return createElement(NodeStatusProvider, null, createElement(Guard, { segments }));
}

let root: Root;
const settled = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const where = () => phone.routes[phone.routes.length - 1] ?? 'start';

/** The app opened cold in `community`, on the bare root (a start's `[]`). */
async function coldStart(community: string): Promise<void> {
    phone.store.set(ANCHOR, community);
    act(() => root.render(createElement(App, { start: [] }) as any));
    await settled();
}
/** The one switch (the BeanPool sheet's row, Find's, Contacts' Switch), with `to`'s answer held until the returned call. */
async function switchHeld(to: string): Promise<() => Promise<void>> {
    let go = () => {};
    holdNext = { at: to, until: new Promise<void>((r) => { go = r; }) };
    await act(async () => { await switchCommunity(to); });
    await settled();
    return async () => { go(); await settled(); };
}

beforeEach(() => {
    phone.store.clear(); phone.guests.clear(); phone.routes = []; phone.go = null;
    stands = { [RIVERSIDE]: 'member', [HILLSIDE]: 'member', [LAKESIDE]: 'guest' };
    holdNext = null;
    root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); });

const markGuests = () => { for (const [at, how] of Object.entries(stands)) if (how === 'guest') phone.guests.add(at); };

/**
 * `from` and `to`: where the account stands in the community left and the one switched to. `lands`: where the guard has it once
 * the community switched to has answered; Welcome is never a resting place for an account on a community it has a place in.
 */
const CASES: Array<{ name: string; from: string; to: string; lands: string }> = [
    { name: 'member -> member', from: RIVERSIDE, to: HILLSIDE, lands: '(tabs)' },
    { name: 'guest -> member (27 Nov)', from: LAKESIDE, to: RIVERSIDE, lands: '(tabs)' },
    { name: 'member -> guest', from: RIVERSIDE, to: LAKESIDE, lands: '(tabs)' },
];

describe.each(CASES)('$name', ({ from, to, lands }) => {
    it('the switch lands on Home before the community answers, and stays there once it has', async () => {
        markGuests();
        await coldStart(from);
        expect(where()).toBe('(tabs)');
        expect(recognition).toBe(stands[from] === 'member' ? 'member' : 'stranger');
        phone.routes = [];
        const answer = await switchHeld(to);
        // The bounce went through Welcome, and on, without waiting for the answer: the answer held was the community left's.
        expect(phone.routes[0]).toBe('welcome');
        expect(where()).toBe('(tabs)');
        expect(recognition).toBe('unknown');
        await answer();
        expect(recognition).toBe(stands[to] === 'member' ? 'member' : 'stranger');
        expect(where()).toBe(lands);
        expect(phone.store.get(ANCHOR)).toBe(to);
    });

    it('the same as the app cold-started there', async () => {
        markGuests();
        await coldStart(to);
        expect(where()).toBe(lands);
    });
});

describe('the answer still acts after the switch, as at a start', () => {
    it('a community that does not know the key and was never chosen as a guest visit: the not-recognised screen', async () => {
        stands[HILLSIDE] = 'stranger';
        await coldStart(RIVERSIDE);
        const answer = await switchHeld(HILLSIDE);
        expect(where()).toBe('(tabs)');
        await answer();
        expect(where()).toBe('node-mismatch');
    });

    it('a guest -> guest switch lands on Home too', async () => {
        stands[RIVERSIDE] = 'guest';
        markGuests();
        await coldStart(LAKESIDE);
        const answer = await switchHeld(RIVERSIDE);
        await answer();
        expect(where()).toBe('(tabs)');
    });

    it("an answer from the community left, come after the switch, never stands for the one in use", async () => {
        markGuests();
        // Opened in the guest community; its answer to this start is held (a slow network), and the member switches home meanwhile.
        let goLeft = () => {};
        holdNext = { at: LAKESIDE, until: new Promise<void>((r) => { goLeft = r; }) };
        phone.store.set(ANCHOR, LAKESIDE);
        act(() => root.render(createElement(App, { start: [] }) as any));
        await settled();
        await act(async () => { await switchCommunity(RIVERSIDE); });
        await settled();
        expect(recognition).toBe('member');
        expect(where()).toBe('(tabs)');
        goLeft();
        await settled();
        expect(recognition).toBe('member');
        expect(where()).toBe('(tabs)');
    });
});

describe('the guard copied above is the root layout\'s', () => {
    const NATIVE = path.resolve(__dirname, '../..');
    const layout = fs.readFileSync(path.join(NATIVE, 'app/_layout.tsx'), 'utf8');
    it('its account branches come in this order, and only a guest is landed off Welcome as a stranger', () => {
        const start = layout.indexOf("if (recognition === 'recovering') {");
        const order = [
            "if (recognition === 'recovering') {",
            "if (recognition === 'closed') {",
            "if (recognition === 'stranger') {",
            "if (!(await isGuestNode(anchor))) return;",
            'const landing = guestRedirect(segments as string[], publicKey);',
            "if (recognition === 'member' && (root === 'node-mismatch' || root === 'recover-identity')) {",
            'const landing = memberRedirect(segments as string[], identity.publicKey);',
        ].map((line) => layout.indexOf(line, start));
        expect(start).toBeGreaterThan(0);
        expect(order.every((at) => at > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
    it('the switch asks afresh between the move and the bounce', () => {
        const src = fs.readFileSync(path.join(NATIVE, 'utils/use-communities.ts'), 'utf8');
        const body = src.slice(src.indexOf('export async function switchCommunity('));
        const move = body.indexOf('await switchPhoneTo(url);');
        const ask = body.indexOf('void askRecognitionAfresh(url);');
        const bounce = body.indexOf("router.replace('/welcome');");
        expect(move).toBeGreaterThan(0);
        expect(ask).toBeGreaterThan(move);
        expect(bounce).toBeGreaterThan(ask);
    });
});
