/**
 * The rest of the web's credit surfaces (DESIGN-credit-list-fable.md §3.4; amendment 1 §3.6, §5.2, tests 10, 20 (the asker's side)
 * and 21): the profile card, the log of looks in Settings and "Looked at by" on the card (the Inspect list), Ask for more in its
 * states, the Ledger's budget panel, and where the bell's `credit` row lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const NODE = vi.hoisted(() => ({
    role: 'owner' as 'owner' | 'admin' | 'member',
    vouching: null as null | Record<string, unknown>,
    card: null as null | Record<string, unknown>,
    sight: 'owner' as string,
    looks: { groups: [] as unknown[], looks: [] as unknown[] },
    calls: [] as { method: string; path: string; body?: unknown }[],
    ask: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        request: vi.fn(async (method: string, path: string, body?: unknown) => {
            NODE.calls.push({ method, path, body });
            if (path === '/api/node-admin/me') {
                if (NODE.role === 'member') throw Object.assign(new Error('no'), { status: 403 });
                return { role: NODE.role };
            }
            if (path.startsWith('/api/credit/people/')) {
                if (!NODE.card) throw Object.assign(new Error('Nobody here by that key.'), { status: 404, code: 'not_listed' });
                return { sight: NODE.sight, told: 'x', person: NODE.card };
            }
            if (path.startsWith('/api/credit/looks')) return NODE.looks;
            if (path === '/api/vouchers/ask') return NODE.ask();
            throw new Error(`unexpected ${method} ${path}`);
        }),
        getMyVouching: vi.fn(async () => NODE.vouching),
    };
});

import { CreditCard } from './CreditCard';
import { CreditLooksSection } from './CreditLooksSection';
import { AskForMore } from './AskForMore';
import { MyBudgetModal } from './MyBudgetModal';
import { goToNoticeTarget, noticeHasDestination } from './NeedsYouIcons';

const SAM = 's'.repeat(64);
const base = (over: Record<string, unknown> = {}) => ({
    memberPubkey: SAM, callsign: 'Sam', status: 'active', own: false, line_c: 130000, usable_c: 130000, liveOffers: 1,
    balance_c: -42000, owed_c: 42000, over_c: 0, paused: false, canGive: true,
    risk: { level: 'low', more: false, reasons: [{ code: 'confirmed', level: 'low', mark: 'admins', values: {} }] }, ...over,
});
const FULL = base({
    parts: { known_c: 100000, room_c: 20000, earned_c: 10000, granted_c: 0, cap_c: 200000 },
    standsBehind: { confirmedBy: { memberPubkey: 'm'.repeat(64), callsign: 'marty', at: '2026-11-01T00:00:00Z' }, vouchedBy: [{ memberPubkey: 'a'.repeat(64), callsign: 'marty', amount_c: 10000 }, { memberPubkey: 'b'.repeat(64), callsign: 'olive', amount_c: 10000 }] },
    frozen: { credit: false, known: false },
});
const VOUCHER = { voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { left: 15000, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 100000 } };

beforeEach(() => {
    NODE.role = 'owner'; NODE.vouching = { ...VOUCHER, voucher: false }; NODE.card = FULL; NODE.sight = 'owner'; NODE.calls = []; NODE.looks = { groups: [], looks: [] }; NODE.ask.mockReset();
    localStorage.clear();
});
afterEach(() => cleanup());

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the profile card (§3.4)', () => {
    it('an owner reads the line, the balance beside it, what it is made of, who stands behind it, the word with its reasons, and who looked', async () => {
        NODE.looks = { groups: [], looks: [
            { actorPubkey: 'j', actorCallsign: 'jane', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'list', sight: 'voucher', day: '2026-11-12', at: '2026-11-12T01:00:00Z' },
            { actorPubkey: 'j', actorCallsign: 'jane', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'card', sight: 'voucher', day: '2026-11-12', at: '2026-11-12T02:00:00Z' },
            { actorPubkey: 'm', actorCallsign: 'marty', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'list', sight: 'owner', day: '2026-11-11', at: '2026-11-11T01:00:00Z' },
        ] };
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        const card = await screen.findByTestId('credit-card');
        expect(within(card).getByTestId('credit-sentence').textContent).toBe('Credit line 1,300 · can use all of it now');
        expect(within(card).getByTestId('credit-balance').textContent).toContain('Balance −420 · using 420 of 1,300');
        expect(within(card).getByTestId('credit-made-of').textContent).toBe('Made of: known floor 1,000 · vouched 200 · earned 100');
        // Who stands behind the person (amendment 2 §5 item 4: who confirmed, each vouch): owners and admins only.
        expect(within(card).getByTestId('credit-confirmed-by').textContent).toBe('Confirmed by @marty');
        expect(within(card).getByTestId('credit-vouched-by').textContent).toBe('Vouched by @marty 100, @olive 100');
        expect(within(card).getByTestId('credit-live-offers').textContent).toBe('1 live Offer');
        expect(card.textContent).toContain('Only people who can give credit see this. Each look is recorded.');
        expect(within(card).getByTestId('credit-risk-reasons').textContent).toContain('Confirmed as known by an admin.');
        await waitFor(() => expect(within(card).getByTestId('credit-looked-at-by').textContent).toBe('Looked at by: @jane 12 Nov · @marty 11 Nov'));
    });

    it('a voucher’s card is every line but "Made of" and "Looked at by", plus "You vouched 50" where they did', async () => {
        NODE.role = 'member'; NODE.vouching = VOUCHER; NODE.sight = 'voucher';
        NODE.card = base({ youVouched_c: 5000, risk: { level: 'medium', more: true, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 70000, line: 130000, pct: 50 } }] } });
        render(<CreditCard memberPubkey={SAM} myVouching={VOUCHER as never} />);
        const card = await screen.findByTestId('credit-card');
        expect(screen.queryByTestId('credit-made-of')).toBeNull();
        expect(screen.queryByTestId('credit-confirmed-by')).toBeNull();
        expect(screen.queryByTestId('credit-vouched-by')).toBeNull();
        expect(screen.queryByTestId('credit-looked-at-by')).toBeNull();
        expect(within(card).getByTestId('credit-you-vouched')).toHaveTextContent('You vouched 50');
        expect(card.textContent).toContain('An owner or admin can say more.');
        expect(NODE.calls.some((c) => c.path.startsWith('/api/credit/looks'))).toBe(false);
        // Red when a voucher is asked for the log, or the card shows more than the voucher answer carries.
    });

    it('a plain member’s profile: no card, and not one request to a credit route', async () => {
        NODE.role = 'member'; NODE.vouching = { voucher: false };
        const { container } = render(<CreditCard memberPubkey={SAM} myVouching={{ voucher: false } as never} />);
        await act();
        expect(container.textContent).toBe('');
        expect(NODE.calls.filter((c) => c.path.startsWith('/api/credit'))).toEqual([]);
    });

    it('the node saying nobody is listed (an enterprise, a visitor) draws nothing', async () => {
        NODE.card = null;
        const { container } = render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        await act();
        expect(container.textContent).toBe('');
    });

    it('over the cap it says so: "Capped at 2,000, the most this community allows." (the parts add up to more than the cap)', async () => {
        NODE.card = { ...FULL, line_c: 200000, usable_c: 200000, parts: { known_c: 150000, room_c: 50000, earned_c: 20000, granted_c: 0, cap_c: 200000 } };
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        expect(await screen.findByTestId('credit-capped')).toHaveTextContent('Capped at 2,000, the most this community allows.');
        // Red when the card says "Capped" from the line alone (a line that merely reaches the cap loses nothing).
    });

    it('a line that reaches the cap exactly loses nothing, so the card does not say "Capped"', async () => {
        NODE.card = { ...FULL, line_c: 200000, usable_c: 200000, parts: { known_c: 150000, room_c: 50000, earned_c: 0, granted_c: 0, cap_c: 200000 } };
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        await screen.findByTestId('credit-card');
        expect(screen.queryByTestId('credit-capped')).toBeNull();
    });

    it('a person with nothing yet: no "Made of" line, no "Confirmed by", no "Vouched by" (a part of 0 is left out)', async () => {
        NODE.card = base({
            line_c: 0, usable_c: 0, liveOffers: 4, balance_c: 0, owed_c: 0,
            parts: { known_c: 0, room_c: 0, earned_c: 0, granted_c: 0, cap_c: 200000 },
            standsBehind: { confirmedBy: null, vouchedBy: [] }, frozen: { credit: false, known: false },
            risk: { level: 'not_known', more: false, reasons: [] },
        });
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        const card = await screen.findByTestId('credit-card');
        expect(within(card).getByTestId('credit-sentence').textContent).toBe('No credit yet · 4 live Offers');
        expect(card.textContent).not.toMatch(/Made of|Confirmed by|Vouched by|known floor 0/);
        // Red when a part of 0 is printed ("known floor 0 · vouched 0 · earned 0").
    });

    it('the lines come in the design’s order, the risk word last but for who looked', async () => {
        NODE.looks = { groups: [], looks: [{ actorPubkey: 'j', actorCallsign: 'jane', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'list', sight: 'voucher', day: '2026-11-12', at: '2026-11-12T01:00:00Z' }] };
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        const card = await screen.findByTestId('credit-card');
        await waitFor(() => within(card).getByTestId('credit-looked-at-by'));
        const order = ['credit-sentence', 'credit-live-offers', 'credit-balance', 'credit-made-of', 'credit-confirmed-by', 'credit-vouched-by', 'credit-risk-word', 'credit-looked-at-by'];
        const at = order.map((id) => Array.from(card.querySelectorAll('*')).indexOf(within(card).getByTestId(id)));
        expect(at).toEqual([...at].sort((a, b) => a - b));
        // Red when the risk word moves above "Made of" (the phone's and the design's order is the line, the balance, who stands behind, then the word).
    });

    it('nothing is kept: the card leaves no balance in browser storage', async () => {
        NODE.card = base({ balance_c: -43713, owed_c: 43713 });
        render(<CreditCard memberPubkey={SAM} myVouching={null} />);
        await screen.findByTestId('credit-card');
        // The enumerator can see a stored value, so this can fail (the test setup's storage is a mock, not spreadable).
        const dump = () => [localStorage, sessionStorage].map((s) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`).join('\n')).join('\n');
        localStorage.setItem('probe', '43713');
        expect(dump()).toContain('43713');
        localStorage.removeItem('probe');
        expect(dump()).not.toContain('43713');
    });
});

async function act() { await settle(); await settle(); }

describe('the log of looks in Settings and Inspect (§5.2)', () => {
    it('owners and admins read "@jane · 12 Nov · looked at 30 people ›", opening to the names; reading is a plain read', async () => {
        NODE.looks = { groups: [{ actorPubkey: 'j'.repeat(64), callsign: 'jane', day: '2026-11-12', sight: 'voucher', people: 30 }], looks: [] };
        render(<CreditLooksSection />);
        fireEvent.click(await screen.findByTestId('credit-looks-toggle'));
        const group = await screen.findByRole('button', { name: '@jane · 12 Nov · looked at 30 people ›' });
        NODE.looks = { groups: [], looks: [{ actorPubkey: 'j'.repeat(64), actorCallsign: 'jane', subjectPubkey: SAM, subjectCallsign: 'Sam', surface: 'list', sight: 'voucher', day: '2026-11-12', at: 'x' }] };
        fireEvent.click(group);
        expect(await screen.findByTestId('credit-looks-day')).toHaveTextContent('@Sam');
        expect(NODE.calls.some((c) => c.path.startsWith('/api/credit/looks?') && c.path.includes('actor='))).toBe(true);
    });

    it('a plain member’s Settings makes no request to the log (test 10)', async () => {
        NODE.role = 'member';
        const { container } = render(<CreditLooksSection />);
        await act();
        expect(container.textContent).toBe('');
        expect(NODE.calls.some((c) => c.path.startsWith('/api/credit/looks'))).toBe(false);
    });

    it('opening it, then closing, forgets the names', async () => {
        NODE.looks = { groups: [{ actorPubkey: 'j'.repeat(64), callsign: 'jane', day: '2026-11-12', sight: 'voucher', people: 2 }], looks: [] };
        render(<CreditLooksSection />);
        const toggle = await screen.findByTestId('credit-looks-toggle');
        fireEvent.click(toggle);
        await screen.findByTestId('credit-looks-groups');
        fireEvent.click(toggle);
        expect(screen.queryByTestId('credit-looks-groups')).toBeNull();
    });
});

describe('Ask for more (§3.6)', () => {
    const ASK = { askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null };

    it('ready: one button, one tap, no body at all; then the node’s state is read again', async () => {
        NODE.vouching = { ...VOUCHER, ask: ASK };
        NODE.ask.mockReturnValue({ askedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z' });
        render(<AskForMore ask={ASK} />);
        NODE.vouching = { ...VOUCHER, ask: { askedAt: '2026-11-12T01:00:00Z', lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null } };
        fireEvent.click(screen.getByTestId('ask-for-more'));
        expect(await screen.findByTestId('ask-asked')).toHaveTextContent('Asked on 12 Nov · an owner or the credit committee will see it.');
        const post = NODE.calls.find((c) => c.path === '/api/vouchers/ask')!;
        expect(post.method).toBe('POST');
        expect(post.body).toBeUndefined();
        // Red when the ask takes text or an amount.
    });

    it('a second ask in the week reads the node’s dates; frozen and paused read the node’s sentences; an owner (null) is shown nothing', () => {
        const { rerender, container } = render(<AskForMore ask={{ askedAt: null, lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null }} />);
        expect(screen.getByTestId('ask-week')).toHaveTextContent('You asked on 12 Nov. You can ask again on 19 Nov.');
        rerender(<AskForMore ask={{ ...ASK, blocked: 'frozen' }} />);
        expect(screen.getByTestId('ask-blocked')).toHaveTextContent('Your credit line is frozen, so your budget can’t be raised until an admin unfreezes it.');
        rerender(<AskForMore ask={{ ...ASK, blocked: 'paused' }} />);
        expect(screen.getByTestId('ask-blocked')).toHaveTextContent('Your account is paused, so your budget can’t be raised while it lasts.');
        rerender(<AskForMore ask={null} />);
        expect(container.textContent).toBe('');
    });

    it('a refusal from the node is said in its own sentence', async () => {
        NODE.vouching = { ...VOUCHER, ask: ASK };
        NODE.ask.mockImplementation(() => { throw Object.assign(new Error('You asked on 12 Nov. You can ask again on 19 Nov.'), { status: 409, code: 'asked_this_week' }); });
        render(<AskForMore ask={ASK} />);
        fireEvent.click(screen.getByTestId('ask-for-more'));
        expect(await screen.findByTestId('ask-refusal')).toHaveTextContent('You asked on 12 Nov. You can ask again on 19 Nov.');
    });

    it('a tap that gets no answer says "Could not ask just now.", never the browser’s own "Failed to fetch"', async () => {
        NODE.vouching = { ...VOUCHER, ask: ASK };
        NODE.ask.mockImplementation(() => { throw new TypeError('Failed to fetch'); });
        render(<AskForMore ask={ASK} />);
        fireEvent.click(screen.getByTestId('ask-for-more'));
        const said = await screen.findByTestId('ask-refusal');
        expect(said).toHaveTextContent('Could not ask just now.');
        expect(said.textContent).not.toContain('Failed to fetch');
        // Red when a thrown message with no status from the node is shown as it came.
    });

    it('the Ledger’s budget panel replaces the static sentence with the button, keeps it for a node that sends no `ask`, and shows an owner neither', () => {
        const v = { voucher: true, budget: { left: 15000, held: 0, heldInvites: 0, vouched: 0, peopleVouched: 0, level: 100000 }, presets: [], vouchMax: 10000, budgetMax: 200000, vouchedBy: [] };
        const { rerender } = render(<MyBudgetModal vouching={{ ...v, ask: ASK } as never} onClose={() => {}} />);
        expect(screen.getByTestId('ask-for-more')).toBeInTheDocument();
        expect(screen.queryByText(/ask an owner of this community/)).toBeNull();
        rerender(<MyBudgetModal vouching={v as never} onClose={() => {}} />);
        expect(screen.getByText(/ask an owner of this community/)).toBeInTheDocument();
        rerender(<MyBudgetModal vouching={{ ...v, noLimit: true, ask: null } as never} onClose={() => {}} />);
        expect(screen.queryByTestId('my-budget-ask')).toBeNull();
    });
});

describe('the bell’s `credit` row (test 21)', () => {
    const KEY = 'a'.repeat(64);
    it('lands on People → Community with Show credit on, the Vouchers chip and that voucher’s row', () => {
        const go = vi.fn();
        goToNoticeTarget('community.notice', { kind: 'voucher_ask', by: KEY, screen: 'credit' }, go);
        expect(go).toHaveBeenCalledWith('people-credit', `vouchers:${KEY}`);
        expect(noticeHasDestination('community.notice', { kind: 'voucher_ask', by: KEY, screen: 'credit' })).toBe(true);
    });
    it('a `by` that is not a key lands on the chip alone; a build without the screen lands elsewhere (the default path is unchanged)', () => {
        const go = vi.fn();
        goToNoticeTarget('community.notice', { screen: 'credit', by: 'not a key' }, go);
        expect(go).toHaveBeenCalledWith('people-credit', 'vouchers');
        const other = vi.fn();
        goToNoticeTarget('community.notice', { screen: 'nowhere' }, other);
        expect(other).not.toHaveBeenCalledWith('people-credit', expect.anything());
    });
});
