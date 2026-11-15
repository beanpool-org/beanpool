/**
 * Make invite on the web, its two classes as invariants over whole tables (PR #3206 round 3; DESIGN-getting-paid-fable.md
 * §4.5, slice B3), as on the phone (apps/native utils/__tests__/invite-refusals-render.test.ts):
 *
 *   C. Every refusal POST /api/invite/generate can answer shows its OWN words, and the page stays. Only the invites' own 404
 *      `feature_off` (`feature: 'invites'`) takes the page away for "Bring someone here"; a bill's (`feature: 'bills'`: bills
 *      switched off after the page read the node) is the bill's refusal, in its words, with the form still there. A refusal
 *      in the node's words makes no offline ticket, with a bill or without; only no answer, a 5xx or a page that isn't the
 *      node's falls back to one, and never with a bill.
 *   D. An invite is in Pending once, by its code: an answer with an invite already listed replaces that row.
 *
 * The chain is real (lib/api.ts generateInvite -> request -> refusalError, which now carries `feature`, -> the page); only
 * fetch is faked, answering as the server does. The refusals are the server's own, read from apps/server routes/community.ts
 * POST /api/invite/generate, engine/invites.ts generateInvite, engine/bills.ts checkInviteBill and assertUnderLimits,
 * engine/writer-bounds.ts assertMayMakeInvite, config/door.ts, config/node-role.ts, routes/profile-feature-gate.ts and
 * gateway-rate-limit.ts. Nothing here contacts a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { billLines, busyWords, inviteBillLines, inviteFolds } from '@beanpool/core';

type Row = { code: string; createdBy: string; createdAt: string; usedBy: null; usedAt: null; intendedFor?: string; bill?: unknown };
const page = vi.hoisted(() => ({ mine: [] as Row[], tickets: 0 }));

vi.mock('../lib/identity', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/identity')>()), loadIdentity: vi.fn(async () => null) }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        // generateInvite stays real: request and refusalError read the faked fetch below.
        buildOfflineInviteCode: vi.fn(async () => { page.tickets++; return `BP-offline-ticket-${page.tickets}`; }),
        getMyInvites: vi.fn(async () => ({ invites: page.mine.map((r) => ({ ...r })) })),
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

/** What the fake node answers one generate with. */
type Answer = { status: number; body: Record<string, unknown> | null } | { thrown: true } | { invite: Row };
const generates = { answers: [] as Answer[], bodies: [] as Array<Record<string, any>> };
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith('/api/invite/generate')) throw new TypeError('Failed to fetch');
    generates.bodies.push(JSON.parse(String(init?.body)));
    const a = generates.answers.shift() ?? { thrown: true };
    if ('thrown' in a) throw new TypeError('Failed to fetch');
    const status = 'invite' in a ? 200 : a.status;
    const body = 'invite' in a ? { success: true, invite: a.invite } : a.body;
    return {
        ok: status >= 200 && status < 300, status, statusText: status === 429 ? 'Too Many Requests' : 'Error', headers: new Headers(),
        json: async () => { if (body === null) throw new SyntaxError('Unexpected token < in JSON'); return body; },
        text: async () => (body === null ? '<html>A page in front of the node</html>' : JSON.stringify(body)),
    } as unknown as Response;
});

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    localStorage.clear();
    inviteFolds.clear();
    page.mine = [];
    page.tickets = 0;
    generates.answers = [];
    generates.bodies = [];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async () => {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('invite-bill-toggle')).toBeInTheDocument());
};
const fillBill = (whatFor = 'Bread', beans = '12') => {
    if (!screen.queryByTestId('invite-bill-what-for')) fireEvent.click(screen.getByTestId('invite-bill-toggle'));
    fireEvent.change(screen.getByTestId('invite-bill-what-for'), { target: { value: whatFor } });
    fireEvent.change(screen.getByTestId('invite-bill-beans'), { target: { value: beans } });
};
const generateButton = () => screen.queryByRole('button', { name: /Generate/ });
const generate = async () => {
    const another = screen.queryByTestId('invite-make-another');
    if (another) fireEvent.click(another);
    await act(async () => { fireEvent.click(generateButton()!); });
    await waitFor(() => expect(screen.queryByText(/Generating/)).not.toBeInTheDocument());
};

// ── C: every refusal in its own words ───────────────────────────────────────────────────────────────────────────────────

/** How the page must read one. `gone`: the invites' own switch takes the page away; `admins`: the form gives way to the
 *  admins' words (Pending stays); `notice`: its words under the button, the form there; `lost`/`ticket`: no answer. */
type Read = 'gone' | 'admins' | 'notice' | 'busy' | 'lost';
const REFUSALS: Array<[string, number, Record<string, unknown> | null, Read]> = [
    ['invites off', 404, { error: 'This community doesn’t use invites: anyone joins it with a sign-in. Share its link.', code: 'feature_off', feature: 'invites' }, 'gone'],
    ['bills off', 404, { error: 'Bills are switched off on this node.', code: 'feature_off', feature: 'bills' }, 'notice'],
    ['Beans off', 403, { error: 'Beans are switched off on this node.', code: 'profile_no_beans' }, 'notice'],
    ['bill id', 400, { error: billLines.badId(), code: 'bill_id' }, 'notice'],
    ['bill sender', 403, { error: billLines.notAMember(), code: 'bill_sender' }, 'notice'],
    ['bill amount', 400, { error: billLines.badAmount(), code: 'bill_amount' }, 'notice'],
    ['bill what for', 400, { error: billLines.badWhatFor(), code: 'bill_what_for' }, 'notice'],
    ['bill id reused', 409, { error: billLines.idReused(), code: 'bill_id_reused' }, 'notice'],
    ['bills on hold', 403, { error: billLines.onHold(), code: 'bills_on_hold' }, 'notice'],
    ['bills sent today', 429, { error: 'You have sent 20 bills today. You can send more from 16 Nov.', code: 'bills_sent_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'notice'],
    ['bills to new people today', 429, { error: 'You have sent bills to 3 new people today.', code: 'bills_new_people_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'notice'],
    ['bills out', 429, { error: 'You have 30 bills nobody has paid yet.', code: 'bills_out' }, 'notice'],
    ['muted', 403, { error: 'You are muted for an hour.', code: 'moderation_muted', mutedUntil: '2026-11-15T10:00:00.000Z' }, 'notice'],
    ['only admins invite', 403, { error: 'In this community only its admins invite people. Ask one.', code: 'admins_only' }, 'admins'],
    ['paused', 403, { error: 'Your account here is paused for now, so you can’t invite anyone.', code: 'paused' }, 'notice'],
    ['not a member', 403, { error: 'Only registered members can generate invites' }, 'notice'],
    ['not signed', 401, { error: 'A signed request is required' }, 'notice'],
    ['invites today', 429, { error: 'You can make 20 invites in any 24 hours. You can make more at 09:00.', code: 'invites_per_day', resetsAt: '2026-11-16T09:00:00.000Z' }, 'notice'],
    ['invites unused', 429, { error: 'You have 50 invites nobody has used yet, the most one member can hold.', code: 'invites_unused' }, 'notice'],
    ['a standby', 409, { error: 'This server is a standby copy of the community, not its main server.', code: 'standby' }, 'notice'],
    ['the gateway limit', 429, { error: 'Gateway rate limit exceeded. Please try again in 9s.' }, 'notice'],
    ['the day budget', 429, { error: 'You have made 1,000 changes today.', code: 'day_budget', resetsAt: '2026-11-16T09:00:00.000Z' }, 'notice'],
    ['a busy network (not JSON)', 429, null, 'busy'],
    ['a server fault', 500, { error: 'Something went wrong on the server.' }, 'lost'],
    ['a proxy page', 502, null, 'lost'],
];
const TABLE: Array<[string, boolean, number, Record<string, unknown> | null, Read]> = [];
for (const [name, status, body, read] of REFUSALS) for (const withBill of [true, false]) TABLE.push([name, withBill, status, body, read]);

describe('C: every refusal of Make invite shows its own words, and the page stays (the whole table)', () => {
    it('the table holds every refusal with a bill and without, and both switches', () => {
        expect(TABLE).toHaveLength(REFUSALS.length * 2);
        expect(REFUSALS.filter(([, , b]) => b?.code === 'feature_off').map(([, , b]) => b?.feature)).toEqual(['invites', 'bills']);
    });

    it.each(TABLE)('%s, with a bill: %s', async (_name, withBill, status, body, read) => {
        await open();
        if (withBill) fillBill();
        generates.answers = [{ status, body }];
        await generate();
        expect(generates.bodies, 'one generate').toHaveLength(1);
        expect('bill' in generates.bodies[0]).toBe(withBill);
        const alert = () => screen.queryByRole('alert')?.textContent ?? null;

        if (read === 'gone') {
            // The invites' own switch: the page is "Bring someone here", with the node's words.
            expect(generateButton()).not.toBeInTheDocument();
            expect(screen.getByText('📤 Bring someone here')).toBeInTheDocument();
            expect(screen.getByText(body!.error as string)).toBeInTheDocument();
        } else if (read === 'admins') {
            expect(generateButton(), 'no generator where only admins invite').not.toBeInTheDocument();
            expect(screen.getByText(body!.error as string)).toBeInTheDocument();
        } else if (read === 'lost' && !withBill) {
            // No answer and no bill: the offline ticket, as it always was, on its made card.
            expect(screen.getByTestId('invite-made-card')).toBeInTheDocument();
            expect(alert()).toBeNull();
        } else {
            // The page stays: the form is there, with the fold as it was.
            expect(generateButton(), 'the form stays').toBeInTheDocument();
            expect(!!screen.queryByTestId('invite-bill-what-for'), 'the fold stays as it was').toBe(withBill);
            if (read === 'notice') expect(alert(), 'the node\'s own words').toBe(body!.error);
            if (read === 'busy') expect(alert(), 'the busy sentence').toBe(busyWords());
            if (read === 'lost') expect(alert()).toBe(withBill ? inviteBillLines.answerLost() : null);
        }
        if (read !== 'gone' && read !== 'admins') expect(screen.queryByText('📤 Bring someone here'), 'never "Bring someone here" for another refusal').toBeNull();
        // An offline ticket only where nobody knows and no bill went: a refusal is never answered with one.
        expect(page.tickets, 'offline tickets').toBe(read === 'lost' && !withBill ? 1 : 0);
    });

    it('no answer at all: with a bill "not known" and no ticket; without, the offline ticket as always', async () => {
        await open();
        fillBill();
        generates.answers = [{ thrown: true }];
        await generate();
        expect(screen.getByRole('alert')).toHaveTextContent(inviteBillLines.answerLost());
        expect(page.tickets).toBe(0);
        fireEvent.click(screen.getByTestId('invite-bill-toggle'));
        generates.answers = [{ thrown: true }];
        await generate();
        expect(page.tickets).toBe(1);
    });
});

// ── D: an invite in Pending once, by its code ───────────────────────────────────────────────────────────────────────────

const row = (code: string, createdAt: string, extra: Partial<Row> = {}): Row => ({ code, createdBy: IDENTITY.publicKey, createdAt, usedBy: null, usedAt: null, ...extra });
const OLD = row('INV-OLD1', '2026-11-01T00:00:00.000Z');
const X = row('INV-XXXX', new Date(Date.now() - 60_000).toISOString(), { bill: { id: 'b-1', whatFor: 'Bread', amount_c: 1200 } });
const NEW = row('INV-NEW2', new Date().toISOString(), { bill: { id: 'b-2', whatFor: 'Bread', amount_c: 1200 } });
const pendingCodes = () => {
    const fold = screen.queryByTestId('invites-pending-fold');
    if (!fold) return [];
    if (fold.getAttribute('aria-expanded') !== 'true') fireEvent.click(fold);
    return screen.queryAllByTestId('invite-pending-row').map((r) => r.querySelector('[data-testid="invite-who"]')?.textContent);
};

type ListCase = 'new invite' | 'same invite as listed' | 'same invite after a reload of mine';
const LIST: Array<[ListCase, string[]]> = [
    ['new invite', ['INV-NEW2', 'INV-OLD1']],
    ['same invite as listed', ['INV-XXXX', 'INV-OLD1']],
    // The web reads its list from the node only when the page opens, so the reload is the page opened again.
    ['same invite after a reload of mine', ['INV-XXXX', 'INV-OLD1']],
];

describe('D: an invite is in Pending once, by its code (the whole table)', () => {
    it.each(LIST)('%s', async (which, codes) => {
        page.mine = which === 'same invite as listed' ? [X, OLD] : [OLD];
        await open();
        await waitFor(() => expect(pendingCodes()).toEqual(page.mine.map((r) => r.code)));
        fillBill();
        if (which === 'same invite after a reload of mine') {
            // The answer is lost; the node made it; the page is opened again and reads it back from the node.
            generates.answers = [{ thrown: true }];
            await generate();
            expect(screen.getByRole('alert')).toHaveTextContent(inviteBillLines.answerLost());
            cleanup();
            page.mine = [X, OLD];
            await open();
            await waitFor(() => expect(pendingCodes()).toEqual(['INV-XXXX', 'INV-OLD1']));
            fillBill();
        }
        // The node answers with the invite it made: a new one, or the one already listed.
        generates.answers = [{ invite: which === 'new invite' ? NEW : X }];
        await generate();
        expect(screen.getByTestId('invite-made-card')).toBeInTheDocument();
        expect(pendingCodes(), 'Pending, in order').toEqual(codes);
        expect(screen.getByTestId('invites-pending-fold')).toHaveTextContent(`Pending (${codes.length})`);
    });
});
