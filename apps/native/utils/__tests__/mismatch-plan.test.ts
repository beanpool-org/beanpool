/**
 * The not-recognised screen's page (utils/mismatch-plan.ts, DESIGN-global-entry-fable.md §C.1, §C.3): open / invite /
 * preview / closed, each with the community reachable just now and not (drawn from the phone's copy); and Reconnect's
 * ask-before-switch (utils/reconnect.ts, decision 4): the phone moves only for an answer that lets the key in.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn() }));

import { mismatchPlan, type MismatchInput } from '../mismatch-plan';
import { askBeforeSwitch, type ReconnectDeps } from '../reconnect';
import type { NodeProfile, NodeFeatures } from '../node-profile';

const profile = (p: 'global' | 'local', features: NodeFeatures): NodeProfile => ({ profile: p, features, checkedAt: '2026-10-17T00:00:00.000Z' });
const OPEN = profile('global', { openJoin: true, wordsDoor: true, door: 'open', invites: false });
const SHUT_GLOBAL = profile('global', { openJoin: false, invites: false });
const PREVIEW = profile('global', { openJoin: true, privatePreview: true });
const LOCAL = profile('local', { invites: true, door: 'members' });
const LOCAL_PREVIEW = profile('local', { invites: true, privatePreview: true });

const plan = (p: Partial<MismatchInput>) => mismatchPlan({ recognition: 'stranger', profile: null, reachable: true, doorScreenTakes: true, ...p });

describe('mismatchPlan: open / invite / preview / closed × reachable', () => {
    for (const reachable of [true, false]) {
        const copy = reachable ? 'just asked' : "the phone's copy (not reachable now)";

        it(`open: an open-door global-profile community, ${copy}`, () => {
            expect(plan({ profile: OPEN, reachable })).toEqual({ page: 'open', fromCopy: !reachable });
        });

        it(`invite: a local community, ${copy}; a global one with its door shut`, () => {
            expect(plan({ profile: LOCAL, reachable })).toEqual({ page: 'invite', fromCopy: !reachable });
            expect(plan({ profile: SHUT_GLOBAL, reachable }).page).toBe('invite');
        });

        it(`preview: a community in a private preview, whatever its profile, ${copy}`, () => {
            expect(plan({ profile: PREVIEW, reachable })).toEqual({ page: 'preview', fromCopy: !reachable });
            expect(plan({ profile: LOCAL_PREVIEW, reachable }).page).toBe('preview');
        });

        it(`closed: the community closed this key's account, whatever it is, ${copy}`, () => {
            for (const p of [OPEN, LOCAL, PREVIEW, null]) {
                expect(plan({ recognition: 'closed', profile: p, reachable }).page).toBe('closed');
            }
        });
    }

    it('invite: a community never heard from (no profile at all), reachable or not; nothing claimed from a copy', () => {
        expect(plan({ profile: null, reachable: false })).toEqual({ page: 'invite', fromCopy: false });
        expect(plan({ profile: null, reachable: true })).toEqual({ page: 'invite', fromCopy: false });
    });

    it("an open-door community the phone's door screen can't take yet (a self-hoster's, before P5) gets the invite page, never another community's door", () => {
        expect(plan({ profile: OPEN, doorScreenTakes: false }).page).toBe('invite');
    });
});

const KEY = { publicKey: 'pk-damo', privateKey: 'sk-damo' };
const GLOBAL = 'https://global.beanpool.org';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function deps(over: Partial<ReconnectDeps>): ReconnectDeps & { switched: string[] } {
    const switched: string[] = [];
    return {
        switched,
        probe: async () => json(200, { isMember: false }),
        isGuestNode: async () => false,
        fetchProfile: async () => OPEN,
        cachedProfile: async () => null,
        switchTo: async (url: string) => { switched.push(url); },
        ...over,
    };
}

describe('askBeforeSwitch: ask first, move only for an answer that lets the key in', () => {
    it("Damo's case: a stranger at the global community → nothing moves; its page is open, from its fresh profile", async () => {
        const d = deps({});
        const r = await askBeforeSwitch(GLOBAL, KEY, d);
        expect(r).toEqual({ kind: 'stranger', profile: OPEN, reachable: true });
        expect(d.switched).toEqual([]);
        if (r.kind !== 'stranger') throw new Error('expected stranger');
        expect(mismatchPlan({ recognition: 'stranger', profile: r.profile, reachable: r.reachable, doorScreenTakes: true }).page).toBe('open');
    });

    it('a member → the phone switches', async () => {
        const d = deps({ probe: async () => json(200, { isMember: true }) });
        expect(await askBeforeSwitch(GLOBAL, KEY, d)).toEqual({ kind: 'member' });
        expect(d.switched).toEqual([GLOBAL]);
    });

    it('a stranger the phone chose to visit as a guest → switches, as before (the guest flag\'s one job)', async () => {
        const d = deps({ isGuestNode: async (url) => url === GLOBAL });
        expect(await askBeforeSwitch(GLOBAL, KEY, d)).toEqual({ kind: 'guest' });
        expect(d.switched).toEqual([GLOBAL]);
    });

    it('a closed account → nothing moves, the closed page; even where the phone marked it a guest visit', async () => {
        const d = deps({ probe: async () => json(403, { code: 'account_closed' }), isGuestNode: async () => true, fetchProfile: async () => LOCAL });
        expect(await askBeforeSwitch('https://riverside.example', KEY, d)).toEqual({ kind: 'closed', profile: LOCAL, reachable: true });
        expect(d.switched).toEqual([]);
    });

    it('no answer (offline, 5xx, not_your_key) → nothing moves, unreachable', async () => {
        for (const probe of [
            async () => { throw new TypeError('Network request failed'); },
            async () => json(502, {}),
            async () => json(403, { code: 'not_your_key' }),
        ]) {
            const d = deps({ probe });
            expect(await askBeforeSwitch(GLOBAL, KEY, d)).toEqual({ kind: 'unreachable' });
            expect(d.switched).toEqual([]);
        }
    });

    it("the profile can't be asked: the phone's copy, marked not reachable", async () => {
        const d = deps({ fetchProfile: async () => null, cachedProfile: async () => LOCAL });
        expect(await askBeforeSwitch('https://riverside.example', KEY, d)).toEqual({ kind: 'stranger', profile: LOCAL, reachable: false });
    });

    it('an address that is not plain host[:port] is refused before anything is asked', async () => {
        const probe = vi.fn(async () => json(200, { isMember: true }));
        const d = deps({ probe });
        await expect(askBeforeSwitch('https://evil.example@good.example', KEY, d)).rejects.toThrow();
        expect(probe).not.toHaveBeenCalled();
        expect(d.switched).toEqual([]);
    });
});
