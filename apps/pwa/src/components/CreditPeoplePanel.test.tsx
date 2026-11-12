/**
 * People → Community with Show credit, the web's half (DESIGN-credit-list-fable.md §8 tests 6, 10, 11, 12, 14 (the words), 15,
 * 18, 19, 21 and 23, with amendments 1 and 2). Each check names the change that turns it red. The node's answers are fixtures
 * in the shapes apps/server/src/routes/credit-sight.ts sends; the real routes are test-credit-sight / -give / -budgets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const NODE = vi.hoisted(() => ({
    role: 'voucher' as 'voucher' | 'owner' | 'admin' | 'member',
    vouching: null as null | Record<string, unknown>,
    people: [] as unknown[],
    cards: {} as Record<string, unknown>,
    chip: null as null | unknown[],
    calls: [] as { method: string; path: string; body?: unknown }[],
    floor: 100000 as number | null,
    listError: false,
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        request: vi.fn(async (method: string, path: string, body?: unknown) => {
            NODE.calls.push({ method, path, body });
            if (path === '/api/node-admin/me') {
                if (NODE.role === 'owner' || NODE.role === 'admin') return { role: NODE.role };
                throw Object.assign(new Error('Not an admin.'), { status: 403 });
            }
            if (path === '/api/credit/people?filter=vouchers') {
                if (NODE.chip) return { sight: NODE.role, filter: 'vouchers', vouchers: NODE.chip, next: null };
                throw Object.assign(new Error('Only an owner or an admin on the credit committee makes vouchers and sets their budgets.'), { status: 403, code: 'committee_only' });
            }
            if (path.startsWith('/api/credit/people?') && NODE.listError) throw Object.assign(new Error('Only the owners, admins and vouchers here can see credit.'), { status: 403, code: 'not_a_giver' });
            if (path.startsWith('/api/credit/people?')) return { sight: NODE.role === 'voucher' ? 'voucher' : NODE.role, told: 'x', people: NODE.people, next: null };
            if (path.startsWith('/api/credit/people/')) return { sight: NODE.role === 'voucher' ? 'voucher' : NODE.role, told: 'x', person: NODE.cards[path.split('/').pop()!] };
            if (path === '/api/credit/known-floor') return { memberPubkey: (body as { memberPubkey: string }).memberPubkey, was_c: 100000, knownFloor_c: (body as { raiseTo_c: number }).raiseTo_c };
            throw new Error(`unexpected request ${method} ${path}`);
        }),
        getMyVouching: vi.fn(async () => NODE.vouching),
        vouchForMember: vi.fn(async () => ({ id: 'v', memberPubkey: 'x', amount: 10000, total: 10000, budget: {} })),
        setVoucherBudget: vi.fn(async () => ({ level: 100000, left: 100000, changed: true })),
    };
});
vi.mock('../lib/known-rule', () => ({ fetchKnownRule: vi.fn(async () => (NODE.floor === null ? null : { knownFloor: NODE.floor, debtLineFrom: null, quietDaysFrom: null })) }));

import * as api from '../lib/api';
import { CreditPeoplePanel } from './CreditPeoplePanel';

const K = (c: string) => c.repeat(64);
const ROB = K('1'), JANE = K('2'), SAM = K('3'), VAL = K('4');
const NOT_KNOWN = { level: 'not_known', more: false, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] };
const LOW = { level: 'low', more: false, reasons: [{ code: 'confirmed', level: 'low', mark: 'admins', values: {} }] };

function person(over: Record<string, unknown> = {}) {
    return {
        memberPubkey: ROB, callsign: 'Rob', status: 'active', own: false, line_c: 0, usable_c: 0, liveOffers: 4,
        balance_c: 0, owed_c: 0, over_c: 0, paused: false, canGive: true, risk: NOT_KNOWN, youVouched_c: 0, ...over,
    };
}
const jane = () => person({
    memberPubkey: JANE, callsign: 'Jane', line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, owed_c: 42000, risk: LOW,
});
const VOUCHER = { voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { left: 15000, held: 0, heldInvites: 0, vouched: 85000, peopleVouched: 9, level: 100000 }, ask: { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null } };
const OWNER_VOUCHING = { voucher: true, noLimit: true, presets: [2500, 5000, 7500, 10000, 20000, 50000], vouchMax: 50000, budgetMax: 200000, vouchedBy: [], budget: { left: 0, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 0 }, ask: null };

beforeEach(() => {
    NODE.role = 'voucher'; NODE.vouching = VOUCHER; NODE.people = [person(), jane()]; NODE.cards = {}; NODE.chip = null; NODE.calls = []; NODE.floor = 100000; NODE.listError = false;
    localStorage.clear(); sessionStorage.clear();
    vi.mocked(api.vouchForMember).mockClear();
    vi.mocked(api.setVoucherBudget).mockClear();
});
afterEach(() => cleanup());

/** Every key and value held in the browser's storage, by `key(i)` and `getItem`, whatever the storage is made of. */
const dumpStorage = () => [localStorage, sessionStorage]
    .map((s) => Array.from({ length: s.length }, (_, i) => { const k = s.key(i) ?? ''; return `${k}=${s.getItem(k)}`; }).join('\n'))
    .join('\n');

const credit = () => NODE.calls.filter((c) => c.path.startsWith('/api/credit') || c.path.startsWith('/api/vouchers/ask'));

async function draw(props: Partial<React.ComponentProps<typeof CreditPeoplePanel>> = {}) {
    const out = render(<CreditPeoplePanel query="" blocked={new Set()} {...props} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return out;
}
async function turnOn() {
    fireEvent.click(await screen.findByTestId('credit-switch'));
    await screen.findByTestId('credit-list');
}

describe('who gets the switch (tests 3 and 10: the node decides, never a local guess)', () => {
    it('a plain member: no switch, none of the giver words, and not one request to a credit route', async () => {
        NODE.role = 'member'; NODE.vouching = { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [] };
        const { container } = await draw();
        expect(screen.queryByTestId('credit-switch')).toBeNull();
        expect(container.textContent ?? '').not.toMatch(/Credit line|Credit risk|Balance|Show credit/);
        expect(credit()).toEqual([]);
        // Red when the switch is drawn from a guess instead of the node's own answers.
    });

    it('a voucher: the switch is off at every visit, and nothing is asked of the credit routes until it is turned on', async () => {
        await draw();
        const sw = await screen.findByTestId('credit-switch');
        expect((sw as HTMLInputElement).checked).toBe(false);
        expect(credit()).toEqual([]);
        expect(screen.queryByTestId('credit-list')).toBeNull();
        // Red when credit is read before the switch is on (a look is logged), or when the switch is remembered.
    });

    it('an owner or admin who is no voucher gets the switch too (the node says the role)', async () => {
        NODE.role = 'admin'; NODE.vouching = { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], ask: null };
        await draw();
        expect(await screen.findByTestId('credit-switch')).toBeInTheDocument();
    });

    it('the node ending the sight (403 not_a_giver on the list read) takes the switch away at once', async () => {
        NODE.listError = true;
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        await waitFor(() => expect(screen.queryByTestId('credit-switch')).toBeNull());
        // Red when a stopped budget keeps its switch because the app remembers a role.
    });
});

describe('the rows (test 6 and amendment §3.2)', () => {
    it('Rob reads "No credit yet · 4 live Offers", Balance 0 and the not-known word; Jane her line, balance and low word', async () => {
        await draw();
        await turnOn();
        const rows = screen.getAllByTestId('credit-row');
        const rob = within(rows[0]!);
        expect(rob.getByTestId('credit-sentence').textContent).toBe('No credit yet · 4 live Offers');
        expect(rob.getByTestId('credit-balance').textContent).toContain('Balance 0');
        expect(rob.getByTestId('credit-risk-word').textContent).toContain('Credit risk: not known yet');
        const j = within(rows[1]!);
        expect(j.getByTestId('credit-sentence').textContent).toBe('Credit line 1,300 · can use all of it now');
        expect(j.getByTestId('credit-balance').textContent).toContain('Balance −420 · using 420 of 1,300');
        expect(j.getByTestId('credit-risk-word').textContent).toContain('Credit risk: low');
        // Red when the sentence reads the usable line as the limit, or the sign is dropped.
    });

    it('the risk is a word with a shape, never colour alone, and no credit sentence is cut with "…"', async () => {
        await draw();
        await turnOn();
        const words = screen.getAllByTestId('credit-risk-word');
        expect(words[0]!.textContent).toMatch(/^○/);
        expect(words[1]!.textContent).toMatch(/^✓/);
        for (const s of screen.getAllByTestId('credit-sentence')) expect(s.textContent).not.toMatch(/…/);
        expect(screen.getByTestId('credit-panel').innerHTML).not.toMatch(/truncate|line-clamp|text-ellipsis/);
        // Red when a fixed height or a one-line cap returns.
    });

    it('the balance is read aloud with its sign, and the visible text is hidden from a screen reader', async () => {
        await draw();
        await turnOn();
        const bal = within(screen.getAllByTestId('credit-balance')[1]!);
        expect(bal.getByText(/Balance minus 420 Beans, using 420 of 1,300/)).toHaveClass('sr-only');
    });

    it('a screen reader hears the row: the button is named by the callsign and DESCRIBED by the lines, with the balance read with its sign', async () => {
        await draw();
        await turnOn();
        const button = screen.getByRole('button', { name: "View Jane's profile" });
        const description = document.getElementById(button.getAttribute('aria-describedby') ?? 'none');
        expect(description).not.toBeNull();
        const spoken = description!.textContent ?? '';
        expect(spoken).toContain('Balance minus 420 Beans, using 420 of 1,300');
        expect(spoken).toContain('Credit risk: low');
        // Red when the row's aria-label alone stands for it (then the balance and the risk are never read out).
    });

    it("Sam after the gift: Balance 0 beside a high word and the two-sentence reason, wrapped, and 'An owner or admin can say more.'", async () => {
        NODE.people = [person({
            memberPubkey: SAM, callsign: 'Sam', line_c: 100000, usable_c: 100000, liveOffers: 0, balance_c: 0,
            risk: { level: 'high', more: true, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } }] },
        })];
        await draw();
        await turnOn();
        const row = within(screen.getByTestId('credit-row'));
        expect(row.getByTestId('credit-balance').textContent).toContain('Balance 0');
        expect(row.getByTestId('credit-risk-word').textContent).toContain('Credit risk: high');
        const reasons = row.getByTestId('credit-risk-reasons').textContent ?? '';
        expect(reasons).toContain('By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.');
        expect(reasons).toContain('An owner or admin can say more.');
        expect(reasons).not.toMatch(/They owe 900/);
        // Red when an app composes the reason itself, or draws the first form beside Balance 0.
    });

    it('a paused member is listed greyed with no button; the viewer’s own row has none either', async () => {
        NODE.people = [person({ status: 'paused', canGive: false }), person({ memberPubkey: VAL, callsign: 'Val', own: true, canGive: false })];
        await draw();
        await turnOn();
        expect(screen.queryAllByTestId('credit-give')).toHaveLength(0);
        expect(screen.getAllByTestId('credit-row')[0]).toHaveClass('opacity-60');
    });

    it('the Give credit button is 48 px tall and the whole row opens the profile', async () => {
        const open = vi.fn();
        await draw({ onOpenProfile: open });
        await turnOn();
        const give = screen.getAllByTestId('credit-give')[0]!;
        expect(give.className).toMatch(/min-h-\[48px\]/);
        fireEvent.click(within(screen.getAllByTestId('credit-row')[0]!).getByRole('button', { name: /View Rob's profile/ }));
        expect(open).toHaveBeenCalledWith(ROB);
    });

    it('offline: "Connect to your community to see credit lines."', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        expect(await screen.findByTestId('credit-offline')).toHaveTextContent('Connect to your community to see credit lines.');
        online.mockRestore();
    });
});

describe('the give flow (tests 11 and 12)', () => {
    it('Give, pick 100: the POST is exactly { memberPubkey, vouchAmount: 10000 }, the person is read again from the node, and the result is said', async () => {
        NODE.cards[ROB] = person({ line_c: 10000, usable_c: 10000 });
        await draw();
        await turnOn();
        fireEvent.click(screen.getAllByTestId('credit-give')[0]!);
        const sheet = await screen.findByTestId('give-credit-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-vouch-100'));
        fireEvent.click(within(sheet).getByTestId('give-vouch-submit'));
        await waitFor(() => expect(api.vouchForMember).toHaveBeenCalledWith(ROB, { vouchAmount: 10000 }));
        expect(await within(sheet).findByTestId('give-done')).toHaveTextContent('Vouched 100 Beans for @Rob.');
        expect(within(sheet).getByTestId('give-line')).toHaveTextContent('Their credit line is now 100.');
        expect(NODE.calls.some((c) => c.method === 'GET' && c.path === `/api/credit/people/${ROB}`)).toBe(true);
        // The row follows the node's fresh answer, not a local sum.
        expect(within(screen.getAllByTestId('credit-row')[0]!).getByTestId('credit-sentence').textContent).toBe('Credit line 100 · can use all of it now');
        // Red when the body grows, or the row is updated before the node answers.
    });

    it('raising a vouch says "Raised vouch for @Rob to 200 Beans." from the total the node recorded', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING;
        NODE.people = [person({ youVouched_c: 10000, line_c: 10000, usable_c: 10000 })];
        NODE.cards[ROB] = person({ youVouched_c: 20000, line_c: 20000, usable_c: 20000 });
        vi.mocked(api.vouchForMember).mockResolvedValueOnce({ id: 'v', memberPubkey: ROB, amount: 10000, total: 20000, budget: {} });
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-give'));
        const sheet = await screen.findByTestId('give-credit-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-vouch-200'));
        fireEvent.click(within(sheet).getByTestId('give-vouch-submit'));
        await waitFor(() => expect(api.vouchForMember).toHaveBeenCalledWith(ROB, { raiseTo: 20000 }));
        expect(await within(sheet).findByTestId('give-done')).toHaveTextContent('Raised vouch for @Rob to 200 Beans.');
        expect(within(sheet).getByTestId('give-line')).toHaveTextContent('Their credit line is now 200.');
        // Red when a raise says "Vouched 200 Beans" (it is not a second vouch), or the total is the app's own sum.
    });

    it('a give that gets no answer says "Connect to your community to give credit.", never the browser’s own words', async () => {
        vi.mocked(api.vouchForMember).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await draw();
        await turnOn();
        fireEvent.click(screen.getAllByTestId('credit-give')[0]!);
        const sheet = await screen.findByTestId('give-credit-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-vouch-100'));
        fireEvent.click(within(sheet).getByTestId('give-vouch-submit'));
        const said = await within(sheet).findByTestId('give-refusal');
        expect(said).toHaveTextContent('Connect to your community to give credit.');
        expect(said.textContent).not.toContain('Failed to fetch');
        // Red when the thrown message is shown as it came.
    });

    it('a refusal shows the node’s sentence, changes nothing, and (not enough budget) offers Ask for more under it', async () => {
        vi.mocked(api.vouchForMember).mockRejectedValueOnce(Object.assign(new Error('You have 50 Beans of budget left, so you can’t vouch 100. Pick a smaller vouch, or ask an owner for more.'), { status: 409, code: 'not_enough' }));
        await draw();
        await turnOn();
        fireEvent.click(screen.getAllByTestId('credit-give')[0]!);
        const sheet = await screen.findByTestId('give-credit-sheet');
        fireEvent.click(within(sheet).getByTestId('invite-vouch-100'));
        fireEvent.click(within(sheet).getByTestId('give-vouch-submit'));
        expect(await within(sheet).findByTestId('give-refusal')).toHaveTextContent('You have 50 Beans of budget left');
        expect(within(screen.getAllByTestId('credit-row')[0]!).getByTestId('credit-sentence').textContent).toBe('No credit yet · 4 live Offers');
        expect(within(sheet).getByTestId('ask-for-more')).toBeInTheDocument();
        expect(NODE.calls.some((c) => c.path === `/api/credit/people/${ROB}`)).toBe(false);
    });

    it('someone below zero: the presets are greyed and inert under the node’s sentence, and no request can be sent', async () => {
        NODE.people = [person({ balance_c: -43713, owed_c: 43713, line_c: 100000, usable_c: 100000 })];
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-give'));
        const sheet = await screen.findByTestId('give-credit-sheet');
        expect(within(sheet).getByTestId('give-blocked')).toHaveTextContent('@Rob is below zero: a credit-line gift or a Decision can help.');
        // Greyed, not taken away (design §3.3): the presets are in view inside an inert box, and the button cannot send.
        expect(within(sheet).getByTestId('invite-vouch-100')).toBeInTheDocument();
        expect(within(sheet).getByTestId('give-presets')).toHaveAttribute('inert');
        expect(within(sheet).getByTestId('give-vouch-submit')).toBeDisabled();
        fireEvent.click(within(sheet).getByTestId('give-vouch-submit'));
        expect(api.vouchForMember).not.toHaveBeenCalled();
        // Red when the presets are live below zero, or leave the page altogether (the phone greys them).
    });

    it('a frozen or paused line: the sheet says so under the gift’s own sentence and greys the presets', async () => {
        const { GiveCreditSheet } = await import('./GiveCreditSheet');
        render(<GiveCreditSheet person={person({ canGive: false }) as never} myVouching={VOUCHER as never} knownFloor_c={100000} full={false} onClose={() => {}} onChanged={() => {}} />);
        expect(screen.getByTestId('give-blocked')).toHaveTextContent('@Rob can’t be given part of a credit line right now.');
        expect(screen.getByTestId('give-presets')).toHaveAttribute('inert');
        expect(screen.getByTestId('give-vouch-submit')).toBeDisabled();
    });

    it('Next opens the next person who can be given credit', async () => {
        NODE.people = [person(), person({ memberPubkey: SAM, callsign: 'Sam' })];
        await draw();
        await turnOn();
        fireEvent.click(screen.getAllByTestId('credit-give')[0]!);
        const sheet = await screen.findByTestId('give-credit-sheet');
        fireEvent.click(within(sheet).getByTestId('give-next'));
        expect(await screen.findByRole('dialog', { name: 'Give @Sam credit' })).toBeInTheDocument();
        expect(screen.queryByTestId('give-next')).toBeNull();
    });

    it('Confirm (owner): the web says it is done in the app and imports no names-list key code; a voucher is offered neither known line', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING;
        NODE.people = [{ ...person(), parts: { known_c: 0, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: null, vouchedBy: [] }, frozen: { credit: false, known: false } }];
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-give'));
        const sheet = await screen.findByTestId('give-credit-sheet');
        expect(within(sheet).getByTestId('give-confirm-button')).toHaveTextContent('Adds the known floor: 1,000 Beans ›');
        fireEvent.click(within(sheet).getByTestId('give-confirm-button'));
        expect(within(sheet).getByTestId('give-confirm-note')).toHaveTextContent('is done in the BeanPool app on your phone');
        expect(NODE.calls.some((c) => /names/.test(c.path))).toBe(false);
        cleanup();
        // A voucher sees neither known line.
        NODE.role = 'voucher'; NODE.vouching = VOUCHER; NODE.people = [person()];
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-give'));
        const vsheet = await screen.findByTestId('give-credit-sheet');
        expect(within(vsheet).queryByTestId('give-confirm')).toBeNull();
        expect(within(vsheet).queryByTestId('give-raise')).toBeNull();
        // Red when the web gains a confirm path.
    });

    it('a community that confirms no one (the dial off) shows neither known line', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING; NODE.floor = null;
        const confirmed = { ...person({ memberPubkey: JANE, callsign: 'Jane', line_c: 0, risk: LOW }), parts: { known_c: 100000, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: { memberPubkey: K('9'), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [] }, frozen: { credit: false, known: false } };
        const unconfirmed = { ...person(), parts: { known_c: 0, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: null, vouchedBy: [] }, frozen: { credit: false, known: false } };
        NODE.people = [confirmed, unconfirmed];
        await draw();
        await turnOn();
        for (const give of screen.getAllByTestId('credit-give')) {
            fireEvent.click(give);
            const sheet = await screen.findByTestId('give-credit-sheet');
            expect(within(sheet).queryByTestId('give-raise')).toBeNull();
            expect(within(sheet).queryByTestId('give-confirm')).toBeNull();
            fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
        }
    });

    it('Raise their known floor: exactly { memberPubkey, raiseTo_c }, in 100s from what they hold, then the person is read again', async () => {
        NODE.role = 'admin'; NODE.vouching = { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], ask: null };
        const confirmed = { ...person({ memberPubkey: JANE, callsign: 'Jane', line_c: 100000, usable_c: 100000, risk: LOW }), parts: { known_c: 100000, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 }, standsBehind: { confirmedBy: { memberPubkey: K('9'), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [] }, frozen: { credit: false, known: false } };
        NODE.people = [confirmed];
        NODE.cards[JANE] = { ...confirmed, line_c: 150000, usable_c: 150000, parts: { ...confirmed.parts, known_c: 150000 } };
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-give'));
        const sheet = await screen.findByTestId('give-credit-sheet');
        expect(within(sheet).getByTestId('give-raise-amount')).toHaveTextContent('1,100');
        for (let i = 0; i < 4; i++) fireEvent.click(within(sheet).getByRole('button', { name: 'Raise the amount' }));
        expect(within(sheet).getByTestId('give-raise-amount')).toHaveTextContent('1,500');
        fireEvent.click(within(sheet).getByTestId('give-raise-submit'));
        await waitFor(() => expect(NODE.calls.some((c) => c.path === '/api/credit/known-floor')).toBe(true));
        const post = NODE.calls.find((c) => c.path === '/api/credit/known-floor')!;
        expect(post.method).toBe('POST');
        expect(post.body).toEqual({ memberPubkey: JANE, raiseTo_c: 150000 });
        expect(await within(sheet).findByTestId('give-done')).toHaveTextContent('Their credit line is now 1,500');
        // Red when the body grows, the stepper offers a lower figure, or a writer is added beside the node's.
    });
});

describe("vouchers' budgets (amendment §3.5; tests 18 and 19)", () => {
    const row = (over: Record<string, unknown> = {}) => ({
        memberPubkey: JANE, callsign: 'Jane', left: 15000, held: 5000, heldInvites: 1, vouched: 80000, peopleVouched: 9, level: 100000, belowZero: 2, writtenOff: 0,
        setLevel_c: 100000, runningLow: true, nothingLeft: false, askedAt: '2026-11-12T01:00:00.000Z', topUpTo_c: 100000, topUpBlocked: null, ...over,
    });

    it('the Vouchers chip shows only where the node answers the committee (403 committee_only: no chip)', async () => {
        NODE.role = 'admin'; NODE.vouching = { voucher: false, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], ask: null }; NODE.chip = null;
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        await screen.findByTestId('credit-list');
        expect(screen.queryByTestId('credit-chip-vouchers')).toBeNull();
        expect(screen.getByTestId('credit-chip-no_credit')).toBeInTheDocument();
    });

    it('a committee admin reads each voucher: left of the level, running low, who asked, and Top up to the node’s offer', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING; NODE.chip = [row()];
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        fireEvent.click(await screen.findByTestId('credit-chip-vouchers'));
        const r = within(await screen.findByTestId('voucher-row'));
        expect(r.getByTestId('voucher-left').textContent).toContain('Voucher · 150 of 1,000 left');
        expect(r.getByTestId('voucher-left').textContent).toContain('Running low');
        expect(r.getByTestId('voucher-asked').textContent).toBe('Asked for more on 12 Nov');
        expect(r.getByTestId('voucher-topup')).toHaveTextContent('Top up to 1,000');
        // Order and words come from the node: this draws them as sent.
    });

    it('the vouched line says what is held on invites only when something is held, and counts "1 person", never "1 people"', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING;
        NODE.chip = [row(), row({ memberPubkey: K('5'), callsign: 'Olive', left: 90000, held: 0, vouched: 10000, peopleVouched: 1, belowZero: 0, runningLow: false, askedAt: null })];
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        fireEvent.click(await screen.findByTestId('credit-chip-vouchers'));
        const rows = await screen.findAllByTestId('voucher-row');
        expect(within(rows[0]!).getByTestId('voucher-vouched').textContent).toBe('Vouched 800 to 9 people · 50 held on invites');
        expect(within(rows[1]!).getByTestId('voucher-vouched').textContent).toBe('Vouched 100 to 1 person');
        expect(rows[1]!.textContent).toContain('0 of 1 below zero · written off 0');
        // Red when a voucher with nothing held reads "· 0 held on invites" (the design's Olive reads "Vouched 100 to 1 person").
    });

    it('Top up sends the node’s offer unchanged (setVoucherBudget(pk, topUpTo_c)) and says the result in the node’s figures', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING; NODE.chip = [row()];
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        fireEvent.click(await screen.findByTestId('credit-chip-vouchers'));
        fireEvent.click(await screen.findByTestId('voucher-topup'));
        await waitFor(() => expect(api.setVoucherBudget).toHaveBeenCalledWith(JANE, 100000));
        expect(await screen.findByTestId('topup-note')).toHaveTextContent('Jane’s budget is 1,000 now: 1,000 left to vouch with.');
        // Red when the app works out a level of its own.
    });

    it('a Top up that gets no answer says "Could not top up just now.", never the browser’s own words', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING; NODE.chip = [row()];
        vi.mocked(api.setVoucherBudget).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        fireEvent.click(await screen.findByTestId('credit-chip-vouchers'));
        fireEvent.click(await screen.findByTestId('voucher-topup'));
        const note = await screen.findByTestId('topup-note');
        expect(note).toHaveTextContent('Could not top up just now.');
        expect(note.textContent).not.toContain('Failed to fetch');
    });

    it('at the most a voucher can hold, frozen and paused: no button, the node’s reason in words; an owner reads "Owner · no limit"', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING;
        NODE.chip = [
            row({ memberPubkey: K('5'), callsign: 'Ann', topUpTo_c: null, topUpBlocked: 'at_most', runningLow: false, askedAt: null }),
            row({ memberPubkey: K('6'), callsign: 'Bo', topUpTo_c: null, topUpBlocked: 'frozen', askedAt: null }),
            row({ memberPubkey: K('7'), callsign: 'Cy', topUpTo_c: null, topUpBlocked: 'paused', askedAt: null }),
            row({ memberPubkey: K('8'), callsign: 'Olive', noLimit: true, topUpTo_c: null, topUpBlocked: 'no_limit', runningLow: false, askedAt: null }),
        ];
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        fireEvent.click(await screen.findByTestId('credit-chip-vouchers'));
        const rows = await screen.findAllByTestId('voucher-row');
        expect(screen.queryAllByTestId('voucher-topup')).toHaveLength(0);
        expect(within(rows[0]!).getByTestId('topup-blocked')).toHaveTextContent('At the most a voucher can hold.');
        expect(within(rows[1]!).getByTestId('topup-blocked')).toHaveTextContent('Their credit line is frozen, so their budget can’t be raised.');
        expect(within(rows[2]!).getByTestId('topup-blocked')).toHaveTextContent('Their account is paused, so their budget can’t be raised.');
        expect(rows[3]!).toHaveTextContent('Owner · no limit');
        expect(within(rows[3]!).queryByTestId('voucher-card')).toBeNull();
    });

    it('the bell’s ask lands on People → Community with Show credit on, the Vouchers chip and that voucher’s row (test 21)', async () => {
        NODE.role = 'owner'; NODE.vouching = OWNER_VOUCHING; NODE.chip = [row()];
        await draw({ start: { chip: 'vouchers', by: JANE, nonce: 1 } });
        const r = await screen.findByTestId('voucher-row');
        expect((screen.getByTestId('credit-switch') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByTestId('credit-chip-vouchers')).toHaveAttribute('aria-pressed', 'true');
        expect(r.id).toBe(`voucher-row-${JANE}`);
        expect(r.className).toMatch(/ring-2/);
        // Red when the row opens nothing, or needs the names list's key.
        expect(NODE.calls.some((c) => /names/.test(c.path))).toBe(false);
    });

    it('a voucher’s own budget sits above the chips with Ask for more; an ask in the week reads the node’s date', async () => {
        await draw();
        fireEvent.click(await screen.findByTestId('credit-switch'));
        const box = await screen.findByTestId('credit-my-budget');
        expect(box).toHaveTextContent('Your budget: 150 of 1,000 left');
        expect(within(box).getByTestId('ask-for-more')).toBeInTheDocument();
    });
});

describe('memory only (test 23, amendment §5.1) and the words (test 15)', () => {
    it('after the credit view with a member at −437.13, browser storage and every cache hold no "43713"', async () => {
        NODE.people = [person({ balance_c: -43713, owed_c: 43713, line_c: 100000, usable_c: 100000 })];
        await draw();
        await turnOn();
        expect(screen.getByTestId('credit-balance').textContent).toContain('Balance −437.13 · using 437.13 of 1,000');
        // The check can fail: a stored value is seen by the enumerator below (the test setup's storage is a mock, not spreadable).
        localStorage.setItem('probe', '43713');
        expect(dumpStorage()).toContain('43713');
        localStorage.removeItem('probe');
        const dump = dumpStorage();
        expect(dump).not.toContain('43713');
        expect(dump).not.toMatch(/credit/i);
        // Red when the view is kept for offline.
        const cachesApi = (globalThis as { caches?: unknown }).caches;
        expect(cachesApi === undefined || cachesApi === null).toBe(true);
    });

    it('turning the switch off forgets every balance on the screen', async () => {
        await draw();
        await turnOn();
        fireEvent.click(screen.getByTestId('credit-switch'));
        expect(screen.queryByTestId('credit-list')).toBeNull();
        expect(screen.getByTestId('credit-panel').textContent).not.toMatch(/Balance/);
    });

    it('no "Ʀ", and the balance never appears without its line beside it', async () => {
        await draw();
        await turnOn();
        const text = screen.getByTestId('credit-panel').textContent ?? '';
        expect(text).not.toMatch(/Ʀ/);
        for (const b of screen.getAllByTestId('credit-balance')) {
            if (!/Balance 0|Balance \+/.test(b.textContent ?? '')) expect(b.textContent).toMatch(/using .* of |more than their credit line/);
        }
    });
});
