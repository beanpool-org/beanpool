/**
 * A new member always sees their 12 words, even when their first join's answer was lost (#1205 confirmation 3c).
 *
 * The invite wizard's Next (welcome.tsx handleCreate) redeems the invite with the key it just made. That redeem can land
 * on the node and its answer never reach the phone: offline for a moment, a 5xx after the member was written, no answer
 * in time, the app stopped while it waited. The member also comes back to Next after it worked (← Back on the photo step,
 * Go Back on Safety Backup). The next Next then finds the invite spent, asks the node, hears the key is a member, and went
 * straight into the app: no photo step, no Safety Backup, never shown the 12 words, which were then only behind Settings'
 * lock. Recovery is those words or a sign-in, and a member who was never shown the words usually has neither.
 *
 * - A key this join made that the node has already: on through the wizard as the redeem would have gone, its words shown
 *   with no lock, the invite marked redeemed, nothing redeemed again.
 * - A key the phone already had (an established account) that the node has already: into the app, as before. No words.
 * - A refused redeem that says the code is spent carries on only when the node says the key is in: never a false join.
 * - While Next is out, the step's ways off are closed, and they open again however Next ends.
 *
 * The screen cannot be rendered here (see vitest.config.ts): its order is simulated with the real functions and pinned
 * against its source below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The phone's app storage, where the wizard's record lives. */
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { storage.delete(k); }),
    },
}));

import {
    keyMadeForThisJoin, resumePlan, getPendingOnboarding, setPendingOnboarding, updatePendingOnboarding, clearPendingOnboarding,
    recordJoinKeyMade, type PendingOnboarding,
} from '../onboarding-state';
import {
    nodeSaysMember, afterSpentInvite, redeemRefusalMeansIn, runNext, leaveUnlessNextIsOut, MEMBERSHIP_PROBE_TIMEOUT_MS,
    NEXT_REQUEST_TIMEOUT_MS,
} from '../invite-next';
import type { BeanPoolIdentity } from '../identity';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NODE = 'https://node.example';
const MADE: BeanPoolIdentity = { publicKey: 'ef'.repeat(32), privateKey: '09'.repeat(32), callsign: 'Kim', createdAt: '' };
const HAD: BeanPoolIdentity = { publicKey: 'ab'.repeat(32), privateKey: '07'.repeat(32), callsign: 'Kim', createdAt: '' };
const JOIN = { inviteCode: 'INV-ABC', anchorUrl: NODE, callsign: 'Kim' };
const USED_BY_ANOTHER = 'This invite has already been used';
/** engine/invites.ts redeemOfflineTicket's refusal of a spent ticket. */
const TICKET_SPENT = 'This exact mathematical offline ticket has already been redeemed';

/**
 * The community node, as far as Next sees it. `members` are the keys it has; the invite is single-use (engine/invites.ts:
 * a key it has already is answered `alreadyMember`, before the spent check). `probe` is how its membership probe answers.
 */
function communityNode() {
    const node = {
        members: new Set<string>(),
        usedBy: null as string | null,
        probe: 'answers' as 'answers' | 'fails' | 'hangs',
        redeems: [] as string[],
        /** GET /api/invite/check (utils/db.ts checkInvite). */
        check(): { valid: boolean; reason?: string } | null {
            return node.usedBy ? { valid: false, reason: 'used' } : { valid: true };
        },
        /** POST /api/invite/redeem (utils/db.ts redeemInvite). `lost`: it lands, and its answer never reaches the phone. */
        async redeem(publicKey: string, answer: 'answered' | 'lost' = 'answered'): Promise<void> {
            node.redeems.push(publicKey);
            if (node.members.has(publicKey)) return;
            if (node.usedBy) throw new Error(USED_BY_ANOTHER);
            node.members.add(publicKey);
            node.usedBy = publicKey;
            if (answer === 'lost') throw new Error('Relay Node Offline: The selected community node is currently unreachable (HTTP 502).');
        },
    };
    return node;
}
type Node = ReturnType<typeof communityNode>;
let node: Node;

/** GET /api/community/membership/<key>, answered by `node`. */
const fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    const m = /\/api\/community\/membership\/([0-9a-f]+)$/.exec(url);
    if (!m) throw new Error(`unexpected request: ${url}`);
    if (node.probe === 'fails') throw new Error('Network request failed');
    if (node.probe === 'hangs') return new Promise<never>(() => { /* no answer, and deaf to the signal */ void init; });
    return { ok: true, status: 200, json: async () => ({ isMember: node.members.has(m[1]) }) };
});

beforeEach(() => {
    storage.clear();
    node = communityNode();
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
});
afterEach(() => { vi.useRealTimers(); });

type Outcome =
    | { went: 'profileSetup'; identity: BeanPoolIdentity; pendingNewKey: string | null }
    | { went: 'app'; identity: BeanPoolIdentity }
    | { went: 'told'; reason: string };

/**
 * Next on "Your Name" (welcome.tsx handleCreate): its key, record and node steps, in its order, with the real functions;
 * the order is pinned against the screen's source below. `phone.key` is the key stored on the phone. The name check and
 * adoptJoinKey are left out: neither decides where the member goes, and adoptJoinKey touches only a global door's record.
 *
 * `pendingNewKey` is what the screen sets for Safety Backup: its words are the member's own new ones, drawn with no lock,
 * exactly when it is the key's own (welcome.tsx `pendingWordsAreNew`, pinned in join-words-behind-lock.test.ts).
 */
async function next(phone: { key: BeanPoolIdentity | null }, answer: 'answered' | 'lost' = 'answered'): Promise<Outcome> {
    const storedIdentity = phone.key;
    const joinRecord = storedIdentity ? await getPendingOnboarding() : null;
    const check = node.check();
    let inAlready = false;
    if (check && !check.valid) {
        const spent = check.reason === 'used' ? await afterSpentInvite(NODE, storedIdentity, joinRecord) : 'spent';
        if (spent === 'enterApp' && storedIdentity) {
            await AsyncStorage.setItem('beanpool_anchor_url', NODE);
            await clearPendingOnboarding();
            return { went: 'app', identity: storedIdentity };
        }
        if (spent !== 'carryOn') return { went: 'told', reason: check.reason ?? '' };
        inAlready = true;
    }
    // createIdentity: the key is on the phone first.
    const identity = storedIdentity ? { ...storedIdentity, callsign: JOIN.callsign } : (phone.key = MADE);
    if (!storedIdentity) await recordJoinKeyMade(JOIN, identity.publicKey);
    const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey);
    const pendingNewKey = keyIsNew ? identity.publicKey : null;
    if (!inAlready) {
        try {
            await node.redeem(identity.publicKey, answer);
        } catch (redeemErr: any) {
            if (!(await redeemRefusalMeansIn(redeemErr?.message, NODE, identity.publicKey))) throw redeemErr;
        }
    }
    await setPendingOnboarding({ step: 'profileSetup', ...JOIN, redeemed: true, ...(keyIsNew ? { newKey: identity.publicKey } : {}) });
    return { went: 'profileSetup', identity, pendingNewKey };
}

/** Safety Backup draws a key's words with no lock only when the screen was handed it as this join's own. */
const wordsWithNoLock = (o: Outcome) => o.went === 'profileSetup' && o.pendingNewKey === o.identity.publicKey;

describe("a first redeem that landed with its answer lost, then Next again: the member's own words, with no lock", () => {
    it('on to the photo step and Safety Backup, the new key\'s words ungated, the invite redeemed, no second redeem', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, 'lost')).rejects.toThrow('Relay Node Offline');
        // It landed: the node has the member, and the invite is spent.
        expect(node.members.has(MADE.publicKey)).toBe(true);
        expect(node.check()).toEqual({ valid: false, reason: 'used' });

        const again = await next(phone);
        expect(again.went).toBe('profileSetup');
        expect(again).toMatchObject({ identity: { publicKey: MADE.publicKey }, pendingNewKey: MADE.publicKey });
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toEqual({ step: 'profileSetup', ...JOIN, redeemed: true, newKey: MADE.publicKey });
        // The one redeem that landed; the retry asked the node instead.
        expect(node.redeems).toEqual([MADE.publicKey]);
        expect(fetchMock).toHaveBeenCalledWith(`${NODE}/api/community/membership/${MADE.publicKey}`, expect.anything());
        // And a restart from here resumes at the photo step, redeemed, the words still the member's own.
        expect(resumePlan(await getPendingOnboarding(), MADE)).toMatchObject({
            action: 'resume', mode: 'profileSetup', redeemed: true, identity: MADE, newKey: true,
        });
    });

    it('the app stopped after the redeem landed, before its answer; started again, Next: the same', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        // The redeem lands; the app is stopped before anything after it runs.
        await expect(next(phone, 'lost')).rejects.toThrow();
        // What the next start finds: the key on the phone, the record Next wrote before the redeem.
        expect(await getPendingOnboarding()).toEqual({ step: 'create', ...JOIN, redeemed: false, newKey: MADE.publicKey });
        const plan = resumePlan(await getPendingOnboarding(), MADE);
        expect(plan).toMatchObject({ action: 'resume', mode: 'create', redeemed: false, identity: null, newKey: true });

        const again = await next(phone);
        expect(again.went).toBe('profileSetup');
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'profileSetup', redeemed: true, newKey: MADE.publicKey });
        expect(node.redeems).toEqual([MADE.publicKey]);
    });

    it('← Back from the photo step (or Go Back on Safety Backup), then Next again: the same, never into the app', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        expect((await next(phone)).went).toBe('profileSetup');
        // welcome.tsx's ← Back: the record goes back to Next, not redeemed; the key stays on the phone.
        await updatePendingOnboarding({ step: 'create', avatar: null, redeemed: false });

        const again = await next(phone);
        expect(again.went).toBe('profileSetup');
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'profileSetup', redeemed: true, newKey: MADE.publicKey });
        expect(node.redeems).toEqual([MADE.publicKey]);
    });

    it('an invite someone else spent, with this join\'s own key: the member is told, and nothing else happens', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, 'lost')).rejects.toThrow();
        const record = await getPendingOnboarding();
        // Not this key after all: the node doesn't have it.
        node.members.clear();
        node.usedBy = 'someone else';
        expect(await next(phone)).toEqual({ went: 'told', reason: 'used' });
        expect(await getPendingOnboarding()).toEqual(record);
        expect(phone.key).toBe(MADE);
    });

    it('a membership probe that fails or never answers: told the invite is spent, never into the app, never on as joined', async () => {
        vi.useFakeTimers();
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, 'lost')).rejects.toThrow();
        const record = await getPendingOnboarding();

        node.probe = 'fails';
        expect(await next(phone)).toEqual({ went: 'told', reason: 'used' });

        node.probe = 'hangs';
        const pending = next(phone);
        await vi.advanceTimersByTimeAsync(MEMBERSHIP_PROBE_TIMEOUT_MS);
        expect(await pending).toEqual({ went: 'told', reason: 'used' });
        expect(await getPendingOnboarding()).toEqual(record);

        // Once it answers again, Next carries on.
        node.probe = 'answers';
        expect(wordsWithNoLock(await next(phone))).toBe(true);
    });
});

describe('an established account, already in that community, in the same branch: into the app, as before', () => {
    it('the key the phone already had: the app, the record gone, no words drawn', async () => {
        const phone = { key: HAD as BeanPoolIdentity | null };
        node.members.add(HAD.publicKey);
        node.usedBy = HAD.publicKey;
        await setPendingOnboarding({ ...JOIN, step: 'create', redeemed: false });

        expect(await next(phone)).toEqual({ went: 'app', identity: HAD });
        expect(await getPendingOnboarding()).toBeNull();
        expect(node.redeems).toEqual([]);
    });

    it('with no record at all: the same', async () => {
        node.members.add(HAD.publicKey);
        node.usedBy = HAD.publicKey;
        expect(await next({ key: HAD })).toEqual({ went: 'app', identity: HAD });
    });

    /**
     * The app's node is the stored anchor: its database file, its sync, and the recheck before the app opens all read it.
     * _layout.tsx's "Wipe & Join Fresh" removes it before sending the member here with the invite, and the phone may hold
     * another community's. Into the app on this community is into the app with this community as the anchor (PR #1218,
     * 4112785851).
     */
    it('the anchor is the community that said the key is in, before the app opens: none on the phone, or another one', async () => {
        node.members.add(HAD.publicKey);
        node.usedBy = HAD.publicKey;
        expect(storage.get('beanpool_anchor_url')).toBeUndefined();
        expect((await next({ key: HAD })).went).toBe('app');
        expect(storage.get('beanpool_anchor_url')).toBe(NODE);

        storage.set('beanpool_anchor_url', 'https://another.example');
        expect((await next({ key: HAD })).went).toBe('app');
        expect(storage.get('beanpool_anchor_url')).toBe(NODE);
    });

    it('a record that names another key, or a door\'s mark the invite join has taken away, does not make it new', async () => {
        node.members.add(HAD.publicKey);
        node.usedBy = HAD.publicKey;
        await setPendingOnboarding({ ...JOIN, step: 'create', redeemed: false, newKey: MADE.publicKey });
        expect((await next({ key: HAD })).went).toBe('app');
        await setPendingOnboarding({ ...JOIN, step: 'create', redeemed: false, freshKey: HAD.publicKey });
        expect((await next({ key: HAD })).went).toBe('app');
    });
});

describe("afterSpentInvite: what Next does with an invite the node says is spent", () => {
    const madeHere: PendingOnboarding = { ...JOIN, step: 'create', redeemed: false, newKey: MADE.publicKey };

    it("no key on the phone: nothing here spent it, and the node isn't asked", async () => {
        expect(await afterSpentInvite(NODE, null, madeHere)).toBe('spent');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a key the node does not have: spent', async () => {
        expect(await afterSpentInvite(NODE, MADE, madeHere)).toBe('spent');
    });

    it("this join's key, in already: carry on, whichever way this join made it", async () => {
        node.members.add(MADE.publicKey);
        expect(await afterSpentInvite(NODE, MADE, madeHere)).toBe('carryOn');
        // The global door's own key, and an invite join the door holds.
        const door: PendingOnboarding = { ...JOIN, flow: 'global', step: 'globalJoin', inviteCode: '', redeemed: false, freshKey: MADE.publicKey };
        expect(await afterSpentInvite(NODE, MADE, door)).toBe('carryOn');
        expect(await afterSpentInvite(NODE, MADE, { ...door, freshKey: undefined, before: madeHere })).toBe('carryOn');
    });

    it('a key the phone already had, in already: into the app', async () => {
        node.members.add(HAD.publicKey);
        expect(await afterSpentInvite(NODE, HAD, null)).toBe('enterApp');
        expect(await afterSpentInvite(NODE, HAD, madeHere)).toBe('enterApp');
    });
});

describe('nodeSaysMember: the node\'s membership probe, bounded', () => {
    it('yes only when the node says so', async () => {
        node.members.add(MADE.publicKey);
        expect(await nodeSaysMember(NODE, MADE.publicKey)).toBe(true);
        expect(await nodeSaysMember(NODE, HAD.publicKey)).toBe(false);
    });

    it('no for an error, an unclear answer, or none', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ isMember: true }) } as any);
        expect(await nodeSaysMember(NODE, MADE.publicKey)).toBe(false);
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('not JSON'); } } as any);
        expect(await nodeSaysMember(NODE, MADE.publicKey)).toBe(false);
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ isMember: 'yes' }) } as any);
        expect(await nodeSaysMember(NODE, MADE.publicKey)).toBe(false);
        node.probe = 'fails';
        expect(await nodeSaysMember(NODE, MADE.publicKey)).toBe(false);
    });

    it('a probe that never answers is no by its time, and is asked to stop', async () => {
        vi.useFakeTimers();
        node.probe = 'hangs';
        let answered: boolean | null = null;
        const asked = nodeSaysMember(NODE, MADE.publicKey).then(a => { answered = a; });
        await vi.advanceTimersByTimeAsync(MEMBERSHIP_PROBE_TIMEOUT_MS - 1);
        expect(answered).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        await asked;
        expect(answered).toBe(false);
        const init = fetchMock.mock.calls[0][1] as { signal: AbortSignal };
        expect(init.signal.aborted).toBe(true);
    });
});

describe('redeemRefusalMeansIn: a refused redeem that means the key is in all the same', () => {
    it("the node's own 'already a member'", async () => {
        expect(await redeemRefusalMeansIn('You are already a member of this community', NODE, MADE.publicKey)).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("'already been used' only when the node says the key is in: never a join the node didn't take", async () => {
        expect(await redeemRefusalMeansIn(USED_BY_ANOTHER, NODE, MADE.publicKey)).toBe(false);
        node.members.add(MADE.publicKey);
        expect(await redeemRefusalMeansIn(USED_BY_ANOTHER, NODE, MADE.publicKey)).toBe(true);
        node.probe = 'fails';
        expect(await redeemRefusalMeansIn(USED_BY_ANOTHER, NODE, MADE.publicKey)).toBe(false);
    });

    /**
     * An offline ticket's refusal says the same thing in its own words (engine/invites.ts redeemOfflineTicket), and a node
     * from before 2026-07-24 (78adfa86) gave it to the ticket's own member, as it gave `already been used` to a code's
     * (PR #1218, 4112785991).
     */
    it("an offline ticket's 'already been redeemed' the same: only when the node says the key is in", async () => {
        expect(await redeemRefusalMeansIn(TICKET_SPENT, NODE, MADE.publicKey)).toBe(false);
        node.members.add(MADE.publicKey);
        expect(await redeemRefusalMeansIn(TICKET_SPENT, NODE, MADE.publicKey)).toBe(true);
        node.probe = 'fails';
        expect(await redeemRefusalMeansIn(TICKET_SPENT, NODE, MADE.publicKey)).toBe(false);
    });

    it('a ticket whose first redeem landed, on a node that refuses its own member by the ticket: on, with the new words', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, 'lost')).rejects.toThrow('Relay Node Offline');
        const quietCheck = vi.spyOn(node, 'check').mockReturnValue(null);
        const oldNode = vi.spyOn(node, 'redeem').mockRejectedValue(new Error(TICKET_SPENT));

        const again = await next(phone);
        expect(again).toMatchObject({ went: 'profileSetup', identity: { publicKey: MADE.publicKey }, pendingNewKey: MADE.publicKey });
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toEqual({ step: 'profileSetup', ...JOIN, redeemed: true, newKey: MADE.publicKey });
        quietCheck.mockRestore();
        oldNode.mockRestore();
    });

    it('a ticket someone else spent: told, never on as joined', async () => {
        const quietCheck = vi.spyOn(node, 'check').mockReturnValue(null);
        const spentTicket = vi.spyOn(node, 'redeem').mockRejectedValue(new Error(TICKET_SPENT));
        await expect(next({ key: null })).rejects.toThrow(TICKET_SPENT);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'create', redeemed: false });
        quietCheck.mockRestore();
        spentTicket.mockRestore();
    });

    it('anything else is not', async () => {
        expect(await redeemRefusalMeansIn('Relay Node Offline', NODE, MADE.publicKey)).toBe(false);
        expect(await redeemRefusalMeansIn(undefined, NODE, MADE.publicKey)).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * checkInvite had no answer (it returns null then, and Next goes on), and the redeem found the code spent. Before, Next
     * carried on to the photo step and the app as if joined, while the node had never taken the member.
     */
    it('Next whose check had no answer, on a code someone else spent: told, never on as joined', async () => {
        node.usedBy = 'someone else';
        const quietCheck = vi.spyOn(node, 'check').mockReturnValue(null);
        await expect(next({ key: null })).rejects.toThrow(USED_BY_ANOTHER);
        expect(await getPendingOnboarding()).toMatchObject({ step: 'create', redeemed: false });
        quietCheck.mockRestore();
    });
});

describe("runNext: the name step's ways off are closed while Next is out, and open again however it ends", () => {
    function screen() {
        const out = { current: false };
        const busy: boolean[] = [];
        const left: string[] = [];
        return {
            out, busy, left,
            run: (next: () => Promise<void>) => runNext(out, (b) => busy.push(b), next),
            backToHome: () => leaveUnlessNextIsOut(out, () => left.push('home')),
            /** `disabled={loading}`: the last value the screen drew. */
            drawnDisabled: () => busy[busy.length - 1] === true,
        };
    }

    it('closed from the tap, in the same frame, until Next is answered; open after it goes on', async () => {
        const s = screen();
        let answer!: () => void;
        const running = s.run(() => new Promise<void>((r) => { answer = r; }));
        expect(s.out.current).toBe(true);
        expect(s.drawnDisabled()).toBe(true);
        s.backToHome();
        expect(s.left).toEqual([]);
        answer();
        await running;
        expect(s.drawnDisabled()).toBe(false);
        s.backToHome();
        expect(s.left).toEqual(['home']);
    });

    it('open again after a failure it showed (a spent invite, a taken name)', async () => {
        const s = screen();
        await s.run(async () => { /* setError(...); return; */ });
        expect(s.busy).toEqual([true, false]);
        s.backToHome();
        expect(s.left).toEqual(['home']);
    });

    it('open again after a throw', async () => {
        const s = screen();
        await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(s.out.current).toBe(false);
        expect(s.busy).toEqual([true, false]);
        s.backToHome();
        expect(s.left).toEqual(['home']);
    });

    it('a second tap on Next while it is out starts nothing', async () => {
        const s = screen();
        let answer!: () => void;
        const calls: number[] = [];
        const first = s.run(() => { calls.push(1); return new Promise<void>((r) => { answer = r; }); });
        await s.run(async () => { calls.push(2); });
        expect(calls).toEqual([1]);
        answer();
        await first;
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const welcome = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
/** Each needle, in this order, in `s`. */
function inOrder(s: string, needles: string[]) {
    let at = -1;
    for (const n of needles) {
        const i = s.indexOf(n, at + 1);
        expect(i, `missing, or out of order: ${n}`).toBeGreaterThan(at);
        at = i;
    }
}
const handleCreate = () => slice(welcome(), 'async function handleCreate() {', '\n    }\n');

describe('welcome.tsx: Next on "Your Name" does what the simulation above does', () => {
    it('in this order: the record, the check, the spent answer, the key, the redeem only if not in already, the record', () => {
        inOrder(handleCreate(), [
            'const joinRecord = storedIdentity ? await getPendingOnboarding() : null;',
            'const check = await checkInvite(parsedCode, nodeUrl);',
            'let inAlready = false;',
            "const spent = check.reason === 'used' ? await afterSpentInvite(nodeUrl, storedIdentity, joinRecord) : 'spent';",
            ": await createIdentity(callsign.trim());",
            'if (!storedIdentity) await recordJoinKeyMade(',
            'const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey);',
            'if (storedIdentity) await adoptJoinKey(storedIdentity.publicKey);',
            'if (!inAlready) {',
            'await redeemInvite(parsedCode, identity.callsign, identity, { timeoutMs: NEXT_REQUEST_TIMEOUT_MS });',
            'if (!(await redeemRefusalMeansIn(redeemErr?.message, nodeUrl, identity.publicKey))) {',
            'throw redeemErr;',
            'setInviteRedeemed(true);',
            "step: 'profileSetup',",
            'redeemed: true,',
            '...(keyIsNew ? { newKey: identity.publicKey } : {}),',
            "setMode('profileSetup');",
        ]);
    });

    it("a spent invite: the app only for the phone's established key, on only for this join's, told otherwise", () => {
        const spent = slice(handleCreate(), 'if (check && !check.valid) {', 'setInviterName(');
        inOrder(spent, [
            "if (spent === 'enterApp' && storedIdentity) {",
            'await clearPendingOnboarding();',
            'setIdentity(storedIdentity);',
            'return;',
            "if (spent !== 'carryOn') {",
            'setError(inviteProblemMessage(check.reason));',
            'return;',
            'inAlready = true;',
        ]);
        // Nothing else in that branch decides: no probe of its own, no way into the app but the one above.
        expect(spent).not.toContain('fetch(');
        expect(spent.match(/setIdentity\(/g)).toHaveLength(1);
        // And nowhere else on the screen goes into the app with the phone's key as it stood at Next.
        expect(welcome().match(/setIdentity\(storedIdentity\)/g)).toHaveLength(1);
    });

    it('into the app with the anchor on the community that said the key is in, before its recheck', () => {
        const enterApp = slice(handleCreate(), "if (spent === 'enterApp' && storedIdentity) {", 'return;');
        inOrder(enterApp, [
            "await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);",
            'await recheckNodeStatus()',
            'setIdentity(storedIdentity);',
        ]);
    });

    it("the redeem's only carry-on after a refusal is the node's say-so: no bare 'already been used'", () => {
        const s = handleCreate();
        expect(s).not.toContain("includes('already been used')");
        expect(s).not.toContain("includes('already a member')");
    });

    it("the global door's equivalent: a key the node has already (`already_member`) goes through the wizard, never into the app", () => {
        const s = welcome();
        const door = slice(s, 'async function handleGlobalSignIn(', 'async function handleShowOutgoingSeed(');
        // Every `joined` answer, `already_member` included, finishes through finishGlobalJoin, which goes to the photo step.
        expect(slice(door, 'async function afterDoorAnswer(', 'const next = nextStepFor(answer);'))
            .toContain('await finishGlobalJoin(await joinedUnderNodeName(GLOBAL_NODE_URL, answer, identity), answer.enrolment, key);');
        expect(slice(door, 'async function finishGlobalJoin(', '\n    }\n').trimEnd().endsWith("setMode('profileSetup');")).toBe(true);
        // The door takes a key off (setIdentity(null)) but never enters the app with one.
        expect(door.match(/setIdentity\((?!null\))/g)).toBeNull();
    });

    it("a name the phone's own key holds there is its own; the name check and its suggestions are bounded", () => {
        const s = handleCreate();
        inOrder(s, [
            'const nameCheckTimer = setTimeout(() => nameCheck.abort(), NEXT_REQUEST_TIMEOUT_MS);',
            'await checkCallsignAvailable(callsign.trim(), storedIdentity?.publicKey, nodeUrl, { signal: nameCheck.signal });',
            'await suggestCallsigns(callsign.trim(), storedIdentity?.publicKey, 3, nodeUrl, 32, { signal: nameCheck.signal });',
            'clearTimeout(nameCheckTimer);',
        ]);
    });
});

describe('welcome.tsx: "Your Name" is not left while Next is out', () => {
    const createStep = () => slice(welcome(), "if (mode === 'create') {", "if (mode === 'globalJoin') {");

    it("Next's work all runs inside runNext, which alone sets the step busy and free", () => {
        const s = handleCreate();
        // The guard, then the checks that draw nothing busy, then everything else inside runNext.
        inOrder(s, ['if (nextOutRef.current) return;', 'await runNext(nextOutRef, setLoading, async () => {', 'const parsedCode']);
        expect(s.slice(s.indexOf('await runNext(')).trimEnd().endsWith('});')).toBe(true);
        expect(s).not.toContain('setLoading(');
        expect(welcome()).toContain('const nextOutRef = useRef(false);');
    });

    it('Back to Home, Restore Existing Identity and the Recover link are disabled while it is out, and do nothing if tapped', () => {
        const s = createStep();
        expect(s).toMatch(/onPress=\{\(\) => leaveUnlessNextIsOut\(nextOutRef, goBack\)\}\s*disabled=\{loading\}\s*accessibilityRole="button"\s*accessibilityLabel="Back to Home"/);
        expect(s).toMatch(/onPress=\{\(\) => leaveUnlessNextIsOut\(nextOutRef, \(\) => \{ setMode\('member'\); setError\(null\); \}\)\}\s*disabled=\{loading\}/);
        expect(s).toMatch(/onPress=\{\(\) => leaveUnlessNextIsOut\(nextOutRef, \(\) => \{\s*setError\(null\);\s*setMode\('recover'\);\s*\}\)\}\s*disabled=\{loading\}/);
        // No other way off the step: every change of step on it goes through that gate.
        expect(s).not.toContain('onPress={goBack}');
        expect(s.match(/setMode\(/g)).toHaveLength(2);
        expect(s.match(/leaveUnlessNextIsOut\(nextOutRef, /g)).toHaveLength(3);
        // Drawn faded as well as disabled.
        expect(s.match(/loading && styles\.closedWhileNextIsOut/g)).toHaveLength(2);
    });

    it('the redeem is bounded, so the step can always be left again', () => {
        expect(NEXT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
        expect(MEMBERSHIP_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    });
});
