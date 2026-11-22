/**
 * Delivered, held for a line the member-here mark let in (Marty, 22 Nov 2026, from the PR #3347 max review finding 1: "HOLD
 * DELIVERED"; scratch/fable-design/DESIGN-no-switch-messaging-fable.md, DECIDED 22 Nov): core's one rule, both halves.
 *
 *   A  outsideReceiptWhen: who wrote (let in by the mark straight in or as a request, a stranger through an open door or
 *      at a closed one, let in, a chat already open with or without the mark, a request already waiting, blocked) -> now,
 *      held or none, through the real gate (gateOutsideItem) for the same input. A held chat's later lines wait by its
 *      mark in each app's store (the apps' held-receipts tests, section 3).
 *   B  outsideHeldReceipts: the member's step (none, open, accept, answer, decline, block) x the chat's state x blocked now x
 *      not sure no block bars them -> send, hold or forget.
 *
 * Each rule is shown to matter: a copy of the rule with that clause taken out gets rows of the table wrong.
 */
import { describe, expect, it } from 'vitest';
import {
    gateOutsideItem, outsideHeldReceipts, outsideReceiptWhen, type OutsideChatState, type OutsideGateVerdict, type OutsideReceiptAction, type OutsideReceiptWhen,
} from '../outside-chat.js';

// ─── A  when a line is receipted ────────────────────────────────────────────────────────────

const WHO = [
    'mark, straight in (requests off)',
    'mark, as a request (requests on)',
    'stranger, door open',
    'stranger, door closed',
    'let in once',
    'chat already open',
    'chat already open, sender marked',
    'request already waiting (their second line)',
    'blocked, with the mark',
] as const;
type Who = typeof WHO[number];

type GateInput = Parameters<typeof gateOutsideItem>[0];
const INPUT: Record<Who, GateInput> = {
    'mark, straight in (requests off)': { kind: 'dm-line', chat: null, doorOpen: false, blocked: false, memberHere: true, requestsHere: false },
    'mark, as a request (requests on)': { kind: 'dm-line', chat: null, doorOpen: true, blocked: false, memberHere: true, requestsHere: true },
    'stranger, door open': { kind: 'dm-line', chat: null, doorOpen: true, blocked: false },
    'stranger, door closed': { kind: 'dm-line', chat: null, doorOpen: false, blocked: false },
    'let in once': { kind: 'dm-line', chat: null, doorOpen: false, blocked: false, letIn: true, memberHere: true, requestsHere: true },
    'chat already open': { kind: 'dm-line', chat: { state: 'open', theirLines: 3 }, doorOpen: false, blocked: false, memberHere: false },
    // The phone asks the mark only with no chat here; the web passes the server's mark as it is: the receipt rule must not care.
    'chat already open, sender marked': { kind: 'dm-line', chat: { state: 'open', theirLines: 3 }, doorOpen: false, blocked: false, memberHere: true, requestsHere: true },
    'request already waiting (their second line)': { kind: 'dm-line', chat: { state: 'request', theirLines: 1 }, doorOpen: true, blocked: false },
    'blocked, with the mark': { kind: 'dm-line', chat: null, doorOpen: true, blocked: true, memberHere: true, requestsHere: false },
};

/** What the sender should see, by the decision: a hold only where the mark let the line in; now wherever it played no part. */
function wantWhen(who: Who): OutsideReceiptWhen {
    if (who === 'stranger, door closed' || who === 'request already waiting (their second line)' || who === 'blocked, with the mark') return 'none';
    return who.startsWith('mark') ? 'held' : 'now';
}

type WhenRule = typeof outsideReceiptWhen;
const whenOf = (rule: WhenRule, who: Who): OutsideReceiptWhen => {
    const input = INPUT[who];
    return rule({ verdict: gateOutsideItem(input), chat: input.chat, letIn: input.letIn, memberHere: input.memberHere });
};

describe('A  outsideReceiptWhen: when a line of theirs is receipted', () => {
    it.each(WHO.map((who) => ({ who })))('$who', ({ who }) => {
        expect(whenOf(outsideReceiptWhen, who)).toBe(wantWhen(who));
    });

    it('the review probe, in core: a member here not blocked is held, a blocked one and a stranger at a closed door get nothing', () => {
        expect({
            memberHereNotBlocked: whenOf(outsideReceiptWhen, 'mark, straight in (requests off)'),
            memberHereBlocked: whenOf(outsideReceiptWhen, 'blocked, with the mark'),
            strangerClosedDoor: whenOf(outsideReceiptWhen, 'stranger, door closed'),
        }).toEqual({ memberHereNotBlocked: 'held', memberHereBlocked: 'none', strangerClosedDoor: 'none' });
    });

    // Each clause taken out gets rows wrong.
    const MUTANTS: Record<string, WhenRule> = {
        'no hold at all (before the decision)': (i) => (i.verdict === 'line' || i.verdict === 'request' ? 'now' : 'none'),
        'let in not before the mark': (i) => {
            if (i.verdict !== 'line' && i.verdict !== 'request') return 'none';
            return i.chat === null && i.memberHere === true ? 'held' : 'now';
        },
        'a chat here not before the mark': (i) => {
            if (i.verdict !== 'line' && i.verdict !== 'request') return 'none';
            return i.letIn !== true && i.memberHere === true ? 'held' : 'now';
        },
        'every line held': (i) => (i.verdict === 'line' || i.verdict === 'request' ? 'held' : 'none'),
        'a drop held too': (i) => (i.chat === null && i.letIn !== true && i.memberHere === true ? 'held' : i.verdict === 'line' || i.verdict === 'request' ? 'now' : 'none'),
    };
    for (const [name, mutant] of Object.entries(MUTANTS)) {
        it(`without the rule: ${name}, gets rows wrong`, () => {
            expect(WHO.filter((who) => whenOf(mutant, who) !== wantWhen(who)).length).toBeGreaterThan(0);
        });
    }
});

// ─── B  what the member's step does to held receipts ───────────────────────────────────────

const ACTIONS: OutsideReceiptAction[] = ['none', 'open', 'accept', 'answer', 'decline', 'block'];
const STATES: OutsideChatState[] = ['open', 'request', 'declined'];
const heldRows = ACTIONS.flatMap((action) => STATES.flatMap((state) => [false, true].flatMap((blocked) => [false, true].map((barred) => ({ action, state, blocked, barred })))));

/**
 * The decision, written out: accept, answer or open (an open chat) sends; a block forgets; a doubt holds an open only (S5
 * part 2: an explicit Accept or answer lets go even after a block since undone, on the phone and the web alike); nothing
 * else moves it.
 */
function wantHeld(r: { action: OutsideReceiptAction; state: OutsideChatState; blocked: boolean; barred: boolean }): 'send' | 'hold' | 'forget' {
    if (r.action === 'block' || r.blocked) return 'forget';
    if (r.action === 'accept' || r.action === 'answer') return 'send';
    if (r.barred) return 'hold';
    if (r.action === 'open' && r.state === 'open') return 'send';
    return 'hold';
}

describe('B  outsideHeldReceipts: the member\'s step', () => {
    it.each(heldRows)('$action on a chat $state, blocked $blocked, barred $barred', (r) => {
        expect(outsideHeldReceipts(r)).toBe(wantHeld(r));
    });

    it('once lined up (S5 part 2): barred holds only an open; an Accept or an answer lets go; blocked now still forgets', () => {
        for (const state of STATES) {
            expect(outsideHeldReceipts({ action: 'accept', state, blocked: false, barred: true })).toBe('send');
            expect(outsideHeldReceipts({ action: 'answer', state, blocked: false, barred: true })).toBe('send');
            expect(outsideHeldReceipts({ action: 'open', state, blocked: false, barred: true })).toBe('hold');
            expect(outsideHeldReceipts({ action: 'answer', state, blocked: true, barred: true })).toBe('forget');
        }
    });

    it('a request opened is still held (its screen says they will not know unless you accept); an open chat opened is sent', () => {
        expect(outsideHeldReceipts({ action: 'open', state: 'request', blocked: false, barred: false })).toBe('hold');
        expect(outsideHeldReceipts({ action: 'open', state: 'open', blocked: false, barred: false })).toBe('send');
    });

    type HeldRule = typeof outsideHeldReceipts;
    const MUTANTS: Record<string, HeldRule> = {
        // The rule as #3347 built it: a doubt about blocks held Accept and answer too (the phone's `once` never let go).
        'barred holds an Accept and an answer too (before S5 part 2)': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.barred ? 'hold' : i.action === 'accept' || i.action === 'answer' || (i.action === 'open' && i.state === 'open') ? 'send' : 'hold'),
        'a block not forgotten': (i) => (i.blocked ? 'hold' : i.action === 'accept' || i.action === 'answer' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
        'blocked now ignored (only the Block step forgets)': (i) => (i.action === 'block' ? 'forget' : i.action === 'accept' || i.action === 'answer' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
        'a doubt about blocks not held': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'accept' || i.action === 'answer' || (i.action === 'open' && i.state === 'open') ? 'send' : 'hold'),
        'a request opened sends': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'accept' || i.action === 'answer' ? 'send' : i.barred ? 'hold' : i.action === 'open' ? 'send' : 'hold'),
        'an answer holds': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'accept' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
        'accept holds': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'answer' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
        'open never sends': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'accept' || i.action === 'answer' ? 'send' : 'hold'),
        'decline sends': (i) => (i.action === 'block' || i.blocked ? 'forget' : i.action === 'accept' || i.action === 'answer' || i.action === 'decline' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
        'decline forgets': (i) => (i.action === 'block' || i.blocked || i.action === 'decline' ? 'forget' : i.action === 'accept' || i.action === 'answer' ? 'send' : i.barred ? 'hold' : i.action === 'open' && i.state === 'open' ? 'send' : 'hold'),
    };
    for (const [name, mutant] of Object.entries(MUTANTS)) {
        it(`without the rule: ${name}, gets rows wrong`, () => {
            expect(heldRows.filter((r) => mutant(r) !== wantHeld(r)).length).toBeGreaterThan(0);
        });
    }
});

/** The gate's verdicts this file relies on, so a change to the gate shows here too. */
describe('the gate, for the rows above', () => {
    it('gives each row the verdict its receipt rule assumes', () => {
        const verdicts = Object.fromEntries(WHO.map((who) => [who, gateOutsideItem(INPUT[who])])) as Record<Who, OutsideGateVerdict>;
        expect(verdicts).toEqual({
            'mark, straight in (requests off)': 'line',
            'mark, as a request (requests on)': 'request',
            'stranger, door open': 'request',
            'stranger, door closed': 'drop',
            'let in once': 'line',
            'chat already open': 'line',
            'chat already open, sender marked': 'line',
            'request already waiting (their second line)': 'drop',
            'blocked, with the mark': 'drop',
        });
    });
});
