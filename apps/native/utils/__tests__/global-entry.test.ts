/**
 * The one rule for the global community (utils/global-entry.ts, DESIGN-global-entry-fable.md §B.2): every state, the
 * saved list never deciding it, and the probe's answer kept per key for a day (account_closed until global answers the key
 * otherwise; any other failure leaves the kept answer as it was).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

import {
    GLOBAL_STANDING_STORE_KEY, GLOBAL_STANDING_TTL_MS, askGlobalStanding, doorStateFromCheck, freshStanding, globalEntryState,
    readGlobalStanding, type GlobalDoorState, type GlobalEntryInput, type GlobalStanding,
} from '../global-entry';
import { readMembershipAnswer } from '../membership-answer';

const base: GlobalEntryInput = { account: true, standing: 'stranger', door: 'open', closedHere: false, saved: false };
const state = (p: Partial<GlobalEntryInput>) => globalEntryState({ ...base, ...p });

describe('globalEntryState: every state', () => {
    it('noAccount: a phone with no key, whatever else is known', () => {
        expect(state({ account: false })).toBe('noAccount');
        expect(state({ account: false, standing: 'member', closedHere: true, saved: true })).toBe('noAccount');
    });

    it('closedAccount: global closed this key, even over a member answer or an open door', () => {
        expect(state({ closedHere: true })).toBe('closedAccount');
        expect(state({ closedHere: true, standing: 'member' })).toBe('closedAccount');
        expect(state({ closedHere: true, door: 'unreachable' })).toBe('closedAccount');
    });

    it('member: the probe said member, whatever the door says (no door for a member)', () => {
        for (const door of ['open', 'closed', 'preview', 'unreachable', 'unknown'] as GlobalDoorState[]) {
            expect(state({ standing: 'member', door })).toBe('member');
        }
    });

    it('join: the door is open and the probe said stranger', () => {
        expect(state({ standing: 'stranger', door: 'open' })).toBe('join');
    });

    it('join: the probe could not say (and is no longer asking): the door\'s own check decides', () => {
        expect(state({ standing: 'unknown', door: 'open', asking: false })).toBe('join');
    });

    it('checking: standing unknown while a probe is out, so a member never sees the door flash up', () => {
        expect(state({ standing: 'unknown', door: 'open', asking: true })).toBe('checking');
    });

    it('checking: the door not asked yet', () => {
        expect(state({ standing: 'stranger', door: 'unknown' })).toBe('checking');
    });

    it('a stranger answer already in hand is not held back by a new ask', () => {
        expect(state({ standing: 'stranger', door: 'open', asking: true })).toBe('join');
    });

    it('unreachable, closed, preview: the door\'s own state, for a key that is not a member', () => {
        expect(state({ door: 'unreachable' })).toBe('unreachable');
        expect(state({ door: 'closed' })).toBe('closed');
        expect(state({ door: 'preview' })).toBe('preview');
        expect(state({ standing: 'unknown', door: 'preview' })).toBe('preview');
    });

    it('the saved list never decides: the same answer with global in the list or not', () => {
        const standings: GlobalStanding[] = ['member', 'stranger', 'unknown'];
        const doors: GlobalDoorState[] = ['open', 'closed', 'preview', 'unreachable', 'unknown'];
        for (const standing of standings) for (const door of doors) for (const asking of [false, true]) {
            expect(state({ standing, door, asking, saved: true })).toBe(state({ standing, door, asking, saved: false }));
        }
    });

    it("Damo's case: global in the list (unmarked, as an old Reconnect left it), the probe says stranger → join", () => {
        expect(state({ saved: true, standing: 'stranger', door: 'open' })).toBe('join');
    });
});

describe('doorStateFromCheck', () => {
    it('reads each answer of checkGlobalDoor', () => {
        expect(doorStateFromCheck(null)).toBe('unknown');
        expect(doorStateFromCheck({ ok: true, profile: { profile: 'global', features: { openJoin: true }, checkedAt: '' } })).toBe('open');
        expect(doorStateFromCheck({ ok: false, reason: 'unreachable' })).toBe('unreachable');
        expect(doorStateFromCheck({ ok: false, reason: 'private_preview' })).toBe('preview');
        expect(doorStateFromCheck({ ok: false, reason: 'door_closed' })).toBe('closed');
        expect(doorStateFromCheck({ ok: false, reason: 'not_global' })).toBe('closed');
    });
});

describe('readMembershipAnswer', () => {
    it('member, stranger (and recovering), closed; the refusals that mean "not a member"; everything else is no answer', () => {
        expect(readMembershipAnswer(200, { isMember: true })).toEqual({ kind: 'member' });
        expect(readMembershipAnswer(200, { isMember: false })).toEqual({ kind: 'stranger', recovering: false });
        expect(readMembershipAnswer(200, { isMember: false, isRecovering: true })).toEqual({ kind: 'stranger', recovering: true });
        expect(readMembershipAnswer(403, { code: 'account_closed' })).toEqual({ kind: 'closed' });
        expect(readMembershipAnswer(403, { code: 'members_only' })).toEqual({ kind: 'stranger', recovering: false });
        expect(readMembershipAnswer(403, { code: 'private_preview' })).toEqual({ kind: 'stranger', recovering: false });
        expect(readMembershipAnswer(403, { code: 'not_your_key' })).toBeNull();
        expect(readMembershipAnswer(401, { code: 'signature_required' })).toBeNull();
        expect(readMembershipAnswer(500, { isMember: false })).toBeNull();
        expect(readMembershipAnswer(200, null)).toBeNull();
        expect(readMembershipAnswer(200, { hello: 1 })).toBeNull();
        expect(readMembershipAnswer(403, null)).toBeNull();
    });
});

const KEY = { publicKey: 'pk-damo', privateKey: 'sk-damo' };
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const forgetClosed = async () => {};

describe('the kept answer: per key, a day', () => {
    beforeEach(() => store.map.clear());

    it('unknown until asked; unknown again after a day; a stale or odd entry is unknown', async () => {
        expect(await readGlobalStanding(KEY.publicKey, T0)).toBe('unknown');
        expect(freshStanding({ standing: 'member', at: T0 }, T0 + GLOBAL_STANDING_TTL_MS - 1)).toBe('member');
        expect(freshStanding({ standing: 'member', at: T0 }, T0 + GLOBAL_STANDING_TTL_MS)).toBe('unknown');
        expect(freshStanding({ standing: 'member', at: T0 + 5 }, T0)).toBe('unknown');
        expect(freshStanding({ standing: 'guest', at: T0 }, T0)).toBe('unknown');
        expect(freshStanding({ standing: 'stranger' }, T0)).toBe('unknown');
        expect(freshStanding(null, T0)).toBe('unknown');
        expect(await readGlobalStanding(null, T0)).toBe('unknown');
    });

    it('a member or stranger answer is kept for this key only', async () => {
        const rememberClosed = vi.fn(async () => {});
        const probe = vi.fn(async () => json(200, { isMember: false }));
        expect(await askGlobalStanding(KEY, { probe, rememberClosed, forgetClosed, now: () => T0 })).toEqual({ standing: 'stranger', closed: false, answered: true });
        expect(probe).toHaveBeenCalledWith('https://global.beanpool.org', KEY, expect.anything());
        expect(await readGlobalStanding(KEY.publicKey, T0 + 1000)).toBe('stranger');
        expect(await readGlobalStanding('another-key', T0 + 1000)).toBe('unknown');

        await askGlobalStanding(KEY, { probe: async () => json(200, { isMember: true }), rememberClosed, forgetClosed, now: () => T0 + 2000 });
        expect(await readGlobalStanding(KEY.publicKey, T0 + 3000)).toBe('member');
        expect(rememberClosed).not.toHaveBeenCalled();
    });

    it('account_closed is remembered through the door\'s closed list, and drops a member answer kept before it', async () => {
        await askGlobalStanding(KEY, { probe: async () => json(200, { isMember: true }), rememberClosed: async () => {}, forgetClosed, now: () => T0 });
        expect(await readGlobalStanding(KEY.publicKey, T0 + 1)).toBe('member');
        const rememberClosed = vi.fn(async () => {});
        const r = await askGlobalStanding(KEY, { probe: async () => json(403, { code: 'account_closed' }), rememberClosed, forgetClosed, now: () => T0 + 2 });
        expect(r).toEqual({ standing: 'unknown', closed: true, answered: true });
        expect(rememberClosed).toHaveBeenCalledWith(KEY.publicKey);
        // No member answer outlives it: the rule says closedAccount whatever was kept, not member.
        expect(await readGlobalStanding(KEY.publicKey, T0 + 3)).toBe('unknown');
    });

    // PR #2098 review 4302678601: a vote can bring a removed member back (server reinstate_member), after which the key
    // signs again. The closed mark used to beat that member answer for good.
    it('a removed member brought back: the next member answer forgets the closed mark, and the rule says member', async () => {
        const closed = new Set<string>();
        const marks = {
            rememberClosed: async (k: string) => { closed.add(k); },
            forgetClosed: async (k: string) => { closed.delete(k); },
        };
        const asked = async (body: unknown, status: number, at: number) => {
            const r = await askGlobalStanding(KEY, { probe: async () => json(status, body), ...marks, now: () => at });
            return globalEntryState({ account: true, standing: r.standing, door: 'open', closedHere: closed.has(KEY.publicKey), saved: false });
        };
        expect(await asked({ code: 'account_closed' }, 403, T0)).toBe('closedAccount');
        expect(closed.has(KEY.publicKey)).toBe(true);
        // A failure in between leaves the mark: only a definite answer changes it.
        await askGlobalStanding(KEY, { probe: async () => { throw new TypeError('Network request failed'); }, ...marks, now: () => T0 + 1 });
        expect(closed.has(KEY.publicKey)).toBe(true);
        expect(await asked({ isMember: true }, 200, T0 + 2)).toBe('member');
        expect(closed.has(KEY.publicKey)).toBe(false);
        // And a stranger answer forgets it too: the community no longer says the account is closed.
        expect(await asked({ code: 'account_closed' }, 403, T0 + 3)).toBe('closedAccount');
        expect(await asked({ isMember: false }, 200, T0 + 4)).toBe('join');
        expect(closed.has(KEY.publicKey)).toBe(false);
    });

    it('members_only / private_preview refusals are a stranger answer', async () => {
        const rememberClosed = vi.fn(async () => {});
        expect((await askGlobalStanding(KEY, { probe: async () => json(403, { code: 'private_preview' }), rememberClosed, forgetClosed, now: () => T0 })).standing).toBe('stranger');
    });

    it('any other failure leaves the kept answer as it was', async () => {
        const rememberClosed = vi.fn(async () => {});
        await askGlobalStanding(KEY, { probe: async () => json(200, { isMember: true }), rememberClosed, forgetClosed, now: () => T0 });
        const offline = await askGlobalStanding(KEY, { probe: async () => { throw new TypeError('Network request failed'); }, rememberClosed, forgetClosed, now: () => T0 + 1 });
        expect(offline).toEqual({ standing: 'member', closed: false, answered: false });
        const refused = await askGlobalStanding(KEY, { probe: async () => json(403, { code: 'not_your_key' }), rememberClosed, forgetClosed, now: () => T0 + 2 });
        expect(refused).toEqual({ standing: 'member', closed: false, answered: false });
        const broken = await askGlobalStanding(KEY, { probe: async () => new Response('<html>', { status: 502 }), rememberClosed, forgetClosed, now: () => T0 + 3 });
        expect(broken.standing).toBe('member');
        expect(JSON.parse(store.map.get(GLOBAL_STANDING_STORE_KEY)!)[KEY.publicKey]).toEqual({ standing: 'member', at: T0 });
    });

    it('a failure with nothing kept is unknown, never stranger', async () => {
        const r = await askGlobalStanding(KEY, { probe: async () => { throw new Error('offline'); }, rememberClosed: async () => {}, forgetClosed, now: () => T0 });
        expect(r).toEqual({ standing: 'unknown', closed: false, answered: false });
    });
});
