/**
 * A bill with an invite on the web, the whole class at once (PR #3206 round 2; DESIGN-getting-paid-fable.md §4.5, slice B3), as
 * on the phone (apps/native utils/__tests__/invite-bill-send-render.test.ts): the invite page against a fake node that answers
 * as the server does (engine/bills.ts checkInviteBill: the same id for the same bill on an unused invite answers that invite;
 * the same id for another bill is 409 `bill_id_reused`).
 *
 * Two rules, one table over (fold open / closed) x (bill: none / complete / half-typed) x (answer: ok / lost then retry the
 * same / lost then edit then retry / 409), saying what each tap sends, the id it uses and the words shown:
 *   1. An invite carries a bill only when the fold is open and the member can see the bill: closed, no bill goes and no bill
 *      refusal is shown for words they can't see.
 *   2. The bill's id belongs to one exact bill: the same bill again is the same id (so a retry after a lost answer gets back
 *      the invite already made), an edit is a new id, and a lost answer is never "Nothing was made".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { billLines, inviteBillLines } from '@beanpool/core';

type Answer = 'ok' | 'lost' | 'conflict';
type Sent = { intendedFor?: string; vouch?: number; bill?: { id: string; whatFor: string; amount_c: number } | null };

/** The fake node: each tap takes the next answer. `lost` makes the invite and the answer never arrives; `conflict` is a 409. */
const node = vi.hoisted(() => ({
    sent: [] as Sent[],
    answers: [] as Answer[],
    made: 0,
    tickets: 0,
    bills: new Map<string, { key: string; invite: Record<string, unknown> }>(),
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    const { billLines: lines } = await import('@beanpool/core');
    const spent = () => Object.assign(new Error(lines.idReused()), { status: 409, code: 'bill_id_reused' });
    return {
        ...actual,
        generateInvite: vi.fn(async (pk: string, intendedFor?: string, vouch?: number, bill?: Sent['bill']) => {
            node.sent.push({ intendedFor, vouch, bill });
            const answer = node.answers.shift() ?? 'ok';
            if (answer === 'conflict' && bill) throw spent();
            const make = () => ({
                code: `INV-TEST-000${++node.made}`, createdBy: pk, createdAt: new Date().toISOString(), usedBy: null, usedAt: null,
                intendedFor, ...(bill ? { bill } : {}),
            });
            let invite: Record<string, unknown>;
            if (bill) {
                const key = `${bill.amount_c} ${bill.whatFor}`;
                const prior = node.bills.get(bill.id);
                if (prior && prior.key !== key) throw spent();
                invite = prior ? prior.invite : make();
                if (!prior) node.bills.set(bill.id, { key, invite });
            } else {
                invite = make();
            }
            if (answer === 'lost') throw new TypeError('Failed to fetch');
            return { success: true, invite };
        }),
        buildOfflineInviteCode: vi.fn(async () => { node.tickets++; return `BP-offline-ticket-${node.tickets}`; }),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: false, presets: [], vouchMax: 0, budgetMax: 0, vouchedBy: [] })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => ({ name: 'Riverside' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, beans: true, bills: true } })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Rob', createdAt: '2026-10-01T00:00:00.000Z' };

const generate = async () => {
    // Once an invite is made the form folds; a next one is a deliberate tap on "Make another invite".
    const another = screen.queryByTestId('invite-make-another');
    if (another) fireEvent.click(another);
    const before = node.sent.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Generate/ })); });
    // Settled: the button is back (not "Generating...") and any call has been answered.
    await waitFor(() => expect(screen.queryByText(/Generating/)).not.toBeInTheDocument());
    return node.sent.length - before;
};
const notice = () => screen.queryByRole('alert')?.textContent ?? null;

type Fold = 'open' | 'closed';
type Bill = 'none' | 'complete' | 'half';
type Script = 'ok' | 'lost-then-same' | 'lost-then-edit' | 'conflict';
const SCRIPTS: Record<Script, Answer[]> = { ok: ['ok'], 'lost-then-same': ['lost', 'ok'], 'lost-then-edit': ['lost', 'ok'], conflict: ['conflict', 'ok'] };

/** What a row expects: each tap's bill id as a letter (null: no bill went), amounts, the words after each tap, tickets, the card. */
interface Expect { ids: Array<string | null>; amounts?: number[]; notices: Array<string | null>; tickets: number; carries?: string }

const lost = inviteBillLines.answerLost();
const half = billLines.badWhatFor();
const NO_BILL: Record<Script, Expect> = {
    ok: { ids: [null], notices: [null], tickets: 0 },
    // No bill went: a dropped answer makes the offline ticket, as it always did, and never says a word about a bill.
    'lost-then-same': { ids: [null, null], notices: [null, null], tickets: 1 },
    'lost-then-edit': { ids: [null, null], notices: [null, null], tickets: 1 },
    conflict: { ids: [null, null], notices: [null, null], tickets: 0 },
};
const TABLE: Array<[Fold, Bill, Script, Expect]> = [];
for (const bill of ['none', 'complete', 'half'] as Bill[]) for (const script of Object.keys(SCRIPTS) as Script[]) TABLE.push(['closed', bill, script, NO_BILL[script]]);
for (const script of Object.keys(SCRIPTS) as Script[]) TABLE.push(['open', 'none', script, NO_BILL[script]]);
// Half-typed in an open fold: the fold's own refusal at every tap, and nothing goes.
TABLE.push(['open', 'half', 'ok', { ids: [], notices: [half], tickets: 0 }]);
TABLE.push(['open', 'half', 'lost-then-same', { ids: [], notices: [half, half], tickets: 0 }]);
TABLE.push(['open', 'half', 'lost-then-edit', { ids: [], notices: [half, half], tickets: 0 }]);
TABLE.push(['open', 'half', 'conflict', { ids: [], notices: [half, half], tickets: 0 }]);
// A whole bill in an open fold.
TABLE.push(['open', 'complete', 'ok', { ids: ['A'], amounts: [1200], notices: [null], tickets: 0, carries: 'bill 12 Beans' }]);
// The same bill again after a lost answer: the same id, and the node's answer is the invite it made the first time.
TABLE.push(['open', 'complete', 'lost-then-same', { ids: ['A', 'A'], amounts: [1200, 1200], notices: [lost, null], tickets: 0, carries: 'bill 12 Beans' }]);
// Edited after a lost answer: a new bill, a new id, never 409.
TABLE.push(['open', 'complete', 'lost-then-edit', { ids: ['A', 'B'], amounts: [1200, 1500], notices: [lost, null], tickets: 0, carries: 'bill 15 Beans' }]);
// The node says the id is spent: its words; the next tap goes with a new id and is not refused again.
TABLE.push(['open', 'complete', 'conflict', { ids: ['A', 'B'], amounts: [1200, 1200], notices: [billLines.idReused(), null], tickets: 0, carries: 'bill 12 Beans' }]);

describe('InvitePage: a bill goes only from an open fold, with an id that belongs to one exact bill (the whole table)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        node.sent = [];
        node.answers = [];
        node.made = 0;
        node.tickets = 0;
        node.bills.clear();
    });

    it('the table covers every (fold, bill, answer) once', () => {
        expect(TABLE).toHaveLength(2 * 3 * 4);
        expect(new Set(TABLE.map(([f, b, s]) => `${f}/${b}/${s}`)).size).toBe(24);
    });

    it.each(TABLE)('fold %s, bill %s, answer %s', async (fold, bill, script, want) => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-bill-toggle')).toBeInTheDocument());
        if (fold === 'open' || bill !== 'none') {
            fireEvent.click(screen.getByTestId('invite-bill-toggle'));
            if (bill === 'complete') {
                fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Bread' } });
                fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '12' } });
            }
            if (bill === 'half') fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '5' } });
            // Closed again: the boxes still hold what was typed, out of sight.
            if (fold === 'closed') fireEvent.click(screen.getByTestId('invite-bill-toggle'));
        }
        expect(!!screen.queryByTestId('invite-bill-what-for')).toBe(fold === 'open');
        node.answers = [...SCRIPTS[script]];
        const notices: Array<string | null> = [];
        await generate();
        notices.push(notice());
        if (SCRIPTS[script].length > 1) {
            if (script === 'lost-then-edit' && fold === 'open' && bill !== 'none') {
                fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '15' } });
            }
            await generate();
            notices.push(notice());
        }

        const letters = new Map<string, string>();
        const ids = node.sent.map((s) => {
            if (!s.bill) return null;
            if (!letters.has(s.bill.id)) letters.set(s.bill.id, String.fromCharCode(65 + letters.size));
            return letters.get(s.bill.id)!;
        });
        expect(ids, 'the bill id each tap sent').toEqual(want.ids);
        if (want.amounts) expect(node.sent.map((s) => s.bill?.amount_c)).toEqual(want.amounts);
        expect(notices, 'the words shown after each tap').toEqual(want.notices);
        for (const n of notices) expect(n ?? '').not.toMatch(/Nothing was made/);
        expect(node.tickets, 'offline tickets').toBe(want.tickets);
        if (want.carries) expect(screen.getByTestId('invite-made-carries')).toHaveTextContent(want.carries);
    });
});

describe('a retry of the same bill shows the invite the node already made, not what the page holds now', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        node.sent = [];
        node.answers = [];
        node.made = 0;
        node.tickets = 0;
        node.bills.clear();
    });

    it('lost answer, the note changed, the same bill again: the card is the first invite, with its note', async () => {
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByTestId('invite-bill-toggle')).toBeInTheDocument());
        const note = () => screen.getByPlaceholderText("A note for you, kept on your community's server");
        fireEvent.change(note(), { target: { value: 'Kim from the market' } });
        fireEvent.click(screen.getByTestId('invite-bill-toggle'));
        fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: 'Bread' } });
        fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: '12' } });
        node.answers = ['lost', 'ok'];
        await generate();
        expect(notice()).toBe(inviteBillLines.answerLost());
        fireEvent.change(note(), { target: { value: 'Someone else' } });
        await generate();
        expect(node.made).toBe(1);
        expect(node.sent.map((s) => s.bill?.id)).toEqual([node.sent[0].bill!.id, node.sent[0].bill!.id]);
        expect(screen.getByTestId('invite-made-card')).toHaveTextContent('Kim from the market');
        expect(screen.getByTestId('invite-made-card')).not.toHaveTextContent('Someone else');
    });
});
