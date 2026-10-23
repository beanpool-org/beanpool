// @vitest-environment jsdom
/**
 * The `beanpool claim` QR scanned on a phone with no BeanPool account yet (Dax, 23 Oct 2026: "The QR code took me to the
 * front page of the app… a noob might give up"). Before: the root guard sent the claim screen to welcome, so the claim was
 * lost and nothing said where to go. Now:
 *   1. the claim screen stays with no account (utils/auth-return.ts setupRedirect) and offers "Make my account", which
 *      keeps the claim on the phone (utils/onboarding-state.ts PendingClaim) and opens the first screen;
 *   2. the first screen says, under its doors (whose hint names the door that needs no invite), that the claim waits
 *      (components/ClaimWaitingNote.tsx);
 *   3. once an account is made, whichever door made it and after any restart, the root guard's landing from welcome is the
 *      claim screen with the server, the code's id and the code (utils/member-landing.ts landOnClaim);
 *   4. the waiting claim goes after the claim, when the member leaves it, on a wipe, and once its day is out.
 * The screen's own taps are claim-screen-render.test.ts's; the chain here runs the real modules the root layout runs,
 * with AsyncStorage as a map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The component doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => disk.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { disk.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { disk.delete(k); }),
    },
}));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, accessibilityLiveRegion } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});

import {
    PENDING_CLAIM_TTL_MS, clearPendingClaim, getPendingClaim, pendingClaimLanding, setPendingClaim, subscribePendingOnboarding,
} from '../onboarding-state';
import { landOnClaim, memberRedirect } from '../member-landing';
import { setupRedirect } from '../auth-return';
import { claimRouteFromSystemPath, parseClaimLink } from '../claim-link';
import { ClaimWaitingNote } from '../../components/ClaimWaitingNote';

const KEY = 'beanpool_pending_claim';
const NODE = 'https://beans.example.org';
const ID = '0a1b2c3d';
// Shaped like a claim code; not one any server made.
const CODE = 'claim-a1b2-c3d4-e5f6-7890';
const QR = `beanpool://claim?node=${encodeURIComponent(NODE)}&id=${ID}&code=${CODE}`;
const T0 = Date.UTC(2026, 9, 23, 6, 0, 0);

/** app/_layout.tsx's refresh: what the phone keeps, handed to the landing before the guard runs. */
async function layoutRefresh(now: number = T0): Promise<void> {
    landOnClaim(pendingClaimLanding(await getPendingClaim(now)));
}

/** The params a route hands its screen (expo-router reads the query the same way). */
function paramsOf(route: string): Record<string, string> {
    const q = route.split('?')[1] ?? '';
    return Object.fromEntries(q.split('&').filter(Boolean).map(p => p.split('=').map(decodeURIComponent) as [string, string]));
}

beforeEach(() => { disk.clear(); landOnClaim(null); });

describe('the waiting claim on the phone', () => {
    it('keeps the server, the id and the code, checked as the link\'s are, with when it was kept', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        expect(await getPendingClaim(T0 + 1000)).toEqual({ node: NODE, codeId: ID, code: CODE, savedAt: T0 });
    });

    it('a QR with no address keeps the code, and the claim screen asks for the address', async () => {
        await setPendingClaim({ node: null, codeId: ID, code: CODE }, T0);
        expect(await getPendingClaim(T0)).toEqual({ node: null, codeId: ID, code: CODE, savedAt: T0 });
    });

    it('drops a field that fails its check, on the way in and on the way out', async () => {
        await setPendingClaim({ node: 'http://8.8.8.8', codeId: 'nothex!!', code: 'claim-zzzz' }, T0);
        expect(await getPendingClaim(T0)).toEqual({ node: null, codeId: null, code: null, savedAt: T0 });
        // Written by something else: read back like any input.
        disk.set(KEY, JSON.stringify({ node: 'javascript:alert(1)', codeId: ID, code: `${CODE}\nmore`, savedAt: T0 }));
        expect(await getPendingClaim(T0)).toEqual({ node: null, codeId: ID, code: null, savedAt: T0 });
    });

    it('is gone once its day is out, and the read takes it off the phone', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        expect(await getPendingClaim(T0 + PENDING_CLAIM_TTL_MS - 1)).not.toBeNull();
        expect(await getPendingClaim(T0 + PENDING_CLAIM_TTL_MS)).toBeNull();
        expect(disk.has(KEY)).toBe(false);
    });

    it('one kept in the future (a clock set back), or not a claim at all, is taken off', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0 + 60_000);
        expect(await getPendingClaim(T0)).toBeNull();
        expect(disk.has(KEY)).toBe(false);
        disk.set(KEY, 'not json');
        expect(await getPendingClaim(T0)).toBeNull();
        expect(disk.has(KEY)).toBe(false);
    });

    it('cleared, it is gone; and the root layout hears every change', async () => {
        const heard = vi.fn();
        const off = subscribePendingOnboarding(heard);
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        await clearPendingClaim();
        off();
        expect(heard).toHaveBeenCalledTimes(2);
        expect(await getPendingClaim(T0)).toBeNull();
    });

    it('is its own key beside the join wizard\'s record, which the guard reads as a join half done', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        expect([...disk.keys()]).toEqual([KEY]);
    });
});

describe('the QR on a phone with no account, to the claim screen with the code once the account is made', () => {
    it('cold start: the claim screen opens and stays; Make my account; an account; the guard lands back on the claim', async () => {
        // The camera hands the app the QR's link: the claim screen, with the checked fields.
        const opened = claimRouteFromSystemPath(QR)!;
        expect(opened).toBe(`/claim-community?node=${encodeURIComponent(NODE)}&id=${ID}&code=${CODE}`);
        // No account: the guard leaves the claim screen where it is (before, it sent it to welcome).
        expect(setupRedirect(['claim-community'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();

        // "Make my account" (app/claim-community.tsx makeAccount): the claim is kept, and the first screen opens.
        const p = paramsOf(opened);
        await setPendingClaim({ node: p.node, codeId: p.id, code: p.code }, T0);
        await layoutRefresh(T0);
        // Still no account: welcome is where the guard keeps the phone; nothing lands yet.
        expect(setupRedirect(['welcome'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();

        // The account is made (the global door's or an invite's wizard), and the app restarted part-way: the record is read
        // again, and the landing from welcome, or from the bare root, is the claim screen with what the QR carried.
        landOnClaim(null);
        await layoutRefresh(T0 + 10 * 60_000);
        const landing = memberRedirect(['welcome'], 'ab'.repeat(32), T0 + 10 * 60_000)!;
        expect(landing).toBe(opened);
        expect(paramsOf(landing)).toEqual({ node: NODE, id: ID, code: CODE });
        expect(parseClaimLink(`beanpool://claim?${landing.split('?')[1]}`)).toEqual({ node: NODE, nodeRefused: false, codeId: ID, code: CODE });
        expect(memberRedirect([], 'ab'.repeat(32), T0 + 10 * 60_000)).toBe(opened);
        // On the claim screen itself the guard leaves it be.
        expect(memberRedirect(['claim-community'], 'ab'.repeat(32), T0 + 10 * 60_000)).toBeNull();
    });

    it('after the claim (or Back, or a wipe) the claim is off the phone, and the landing is the tabs again', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        await layoutRefresh(T0);
        expect(memberRedirect(['welcome'], null, T0)).toBe(`/claim-community?node=${encodeURIComponent(NODE)}&id=${ID}&code=${CODE}`);
        await clearPendingClaim();
        await layoutRefresh(T0);
        expect(memberRedirect(['welcome'], null, T0)).toBe('/(tabs)');
    });

    it('a day on, the claim has run out: the tabs, and it is off the phone', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE }, T0);
        await layoutRefresh(T0);
        // Kept in memory past its day (the app left running): not used.
        expect(memberRedirect(['welcome'], null, T0 + PENDING_CLAIM_TTL_MS)).toBe('/(tabs)');
        // Read again after it ran out: taken off.
        await layoutRefresh(T0 + PENDING_CLAIM_TTL_MS);
        expect(disk.has(KEY)).toBe(false);
        expect(memberRedirect(['welcome'], null, T0 + PENDING_CLAIM_TTL_MS)).toBe('/(tabs)');
    });

    it('a wipe takes it off with the join wizard\'s record', () => {
        const identity = fs.readFileSync(path.resolve(__dirname, '../identity.ts'), 'utf8');
        const wipe = identity.slice(identity.indexOf('export async function wipeIdentity('));
        expect(wipe.slice(0, wipe.indexOf('wipeIdentityScopedStorage('))).toMatch(/await clearPendingOnboarding\(\);\s*await clearPendingClaim\(\);/);
    });
});

describe('the first screen while a claim waits', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const draw = async () => {
        await act(async () => { root.render(createElement(ClaimWaitingNote, { style: {} }) as any); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    const note = () => host.querySelector('[data-testid="claim-waiting-note"]')?.textContent ?? null;

    it('says the claim waits for the account and names the server, never the code', async () => {
        await setPendingClaim({ node: NODE, codeId: ID, code: CODE });
        await draw();
        expect(note()).toBe('Make your account first, then BeanPool takes you back to claim beans.example.org.');
        // Never the code.
        expect(host.textContent).not.toContain(CODE.slice(6));
    });

    it('with no address in the QR, still says so', async () => {
        await setPendingClaim({ node: null, codeId: ID, code: CODE });
        await draw();
        expect(note()).toBe('Make your account first, then BeanPool takes you back to your claim.');
    });

    it('nothing while no claim waits, and it goes when the claim does', async () => {
        await draw();
        expect(note()).toBeNull();
        await act(async () => { await setPendingClaim({ node: NODE, codeId: ID, code: CODE }); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(note()).not.toBeNull();
        await act(async () => { await clearPendingClaim(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(note()).toBeNull();
    });
});

describe('the model is the app', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it("app/_layout.tsx reads the waiting claim with the wizard's record and hands it to the landing before the guard's flag", () => {
        const layout = read('../../app/_layout.tsx');
        const at = layout.indexOf('const [pendingOnboarding, setPendingOnboardingFlag] = useState<boolean | null>(null);');
        const effect = layout.slice(at, layout.indexOf('}, []);', at));
        expect(effect).toMatch(/Promise\.all\(\[getPendingOnboarding\(\), getPendingClaim\(\)\]\)\.then\(\(\[p, claim\]\) => \{\s*if \(!mounted\) return;\s*landOnClaim\(pendingClaimLanding\(claim\)\);\s*setPendingOnboardingFlag\(!!p\);/);
        expect(effect).toContain('subscribePendingOnboarding(refresh)');
    });

    it('app/welcome.tsx draws the line right under the doors (which stay above the fold), before the sentence about BeanPool', () => {
        const welcome = read('../../app/welcome.tsx');
        const doors = welcome.indexOf('<WelcomeDoors door={globalDoor}');
        const line = welcome.indexOf('<ClaimWaitingNote style={styles.claimWaitingNote} />');
        const about = welcome.indexOf('<Text style={styles.homeAbout}>');
        expect(doors).toBeGreaterThan(0);
        expect(line).toBeGreaterThan(doors);
        expect(about).toBeGreaterThan(line);
        // Nothing but a comment between the doors and the line.
        expect(welcome.slice(welcome.indexOf('/>', doors) + 2, line).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim()).toBe('');
    });
});
