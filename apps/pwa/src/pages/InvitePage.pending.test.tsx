import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { inviteFolds } from '@beanpool/core';

/**
 * Invites → Pending and Joined (invites-vouching slice I1; Marty, 10 Nov: a bound invite showed as a bare code, so a second,
 * plain one was made for her). Both are folded and closed at first render with their counts in the row; an opened row says who the
 * invite is for, what it carries and how long it has left (red at 3 days or fewer); the whole row opens the invite; and the made
 * card says the same, with the form folded behind "Make another invite". The web holds no names-list key, so an invite bound to an
 * entry says "Name on the phone". Real dates, so a fixture never ages out.
 */
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const INVITES = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async (_pk: string, note?: string, vouch?: number) => ({
            success: true,
            invite: { code: 'INV-MADE-0001', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null, ...(note ? { intendedFor: note } : {}), ...(vouch ? { vouchAmount: vouch } : {}) },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: INVITES.rows })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { level: 100000, left: 90000 } })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => null),
        request: vi.fn(async () => ({ role: 'member' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, beans: true } })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} /> }));

import { InvitePage } from './InvitePage';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
const APPLICANT_KEY = 'f'.repeat(64);

const base = (code: string, madeDaysAgo: number) => ({
    code, createdBy: 'me', createdAt: ago(madeDaysAgo), usedBy: null, usedAt: null,
    namesEntryId: null, vouchAmount: null, voucherLevel: null, forKnock: false,
    expiresAt: new Date(Date.parse(ago(madeDaysAgo)) + 30 * DAY).toISOString(),
});

function fixture() {
    INVITES.rows = [
        // A bound invite: bound to a names-list entry, with a 200 vouch and a 1,000 voucher budget, made 7 days ago (23 left).
        { ...base('INV-BOUND-0001', 7), namesEntryId: 'entry-1', vouchAmount: 20000, voucherLevel: 100000 },
        // A plain one with a note.
        { ...base('INV-NOTE-0002', 1), intendedFor: 'Kim' },
        // A plain one with nothing on it, 28 days old: 2 days left, so red.
        base('INV-PLAIN-0003', 28),
        // Made when a request to join was answered: its note is the applicant's key, never shown as a name.
        { ...base('INV-KNOCK-0004', 2), intendedFor: APPLICANT_KEY, forKnock: true },
        // 31 days old: past its life, the node deletes it within the hour. Not pending.
        base('INV-LAPSED-0005', 31),
        // Used: Joined.
        { ...base('INV-USED-0006', 10), usedBy: 'c'.repeat(64), usedAt: ago(9), usedByCallsign: 'joanne', vouchAmount: 10000 },
    ];
}

beforeEach(() => { localStorage.clear(); inviteFolds.clear(); fixture(); });
afterEach(() => cleanup());

const rows = () => screen.queryAllByTestId('invite-pending-row');
const openPending = async () => fireEvent.click(await screen.findByTestId('invites-pending-fold'));

describe('Pending and Joined are folded', () => {
    it('both closed at first render, with the count in the row, and a lapsed code not counted', async () => {
        render(<InvitePage identity={IDENTITY} />);
        expect(await screen.findByTestId('invites-pending-fold')).toHaveTextContent('Pending (4)');
        expect(screen.getByTestId('invites-joined-fold')).toHaveTextContent('Joined (1)');
        expect(screen.getByTestId('invites-pending-fold')).toHaveAttribute('aria-expanded', 'false');
        expect(rows()).toHaveLength(0);
        expect(screen.queryByTestId('invite-joined-row')).toBeNull();
        expect(document.body.textContent).not.toContain('INV-BOUND-0001');
        expect(document.body.textContent).not.toContain('INV-LAPSED-0005');
    });

    it('opening Pending lists a row for each code that still works; Joined stays closed', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        expect(rows()).toHaveLength(4);
        expect(screen.getByTestId('invites-pending-fold')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.queryByTestId('invite-joined-row')).toBeNull();
    });

    it('stays open for the session once opened: the page mounted again finds it open, and a fresh session finds it closed', async () => {
        const first = render(<InvitePage identity={IDENTITY} />);
        await openPending();
        expect(rows()).toHaveLength(4);
        first.unmount();
        render(<InvitePage identity={IDENTITY} />);
        await screen.findByTestId('invites-pending-fold');
        expect(await screen.findAllByTestId('invite-pending-row')).toHaveLength(4);
        cleanup();
        inviteFolds.clear();
        render(<InvitePage identity={IDENTITY} />);
        await screen.findByTestId('invites-pending-fold');
        expect(rows()).toHaveLength(0);
    });
});

describe('what a Pending row says', () => {
    const rowOf = (code: string) => rows().find((r) => within(r).queryByTestId('invite-who')?.textContent === code) ?? null;

    it('a bound invite: the name is on the phone, what it carries in words, and the days left', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        const bound = rows().find((r) => r.textContent?.includes('Name on the phone'))!;
        expect(bound).toBeTruthy();
        expect(within(bound).getByTestId('invite-carries')).toHaveTextContent('200 vouch · voucher budget 1,000 · confirms them as known');
        expect(within(bound).getByTestId('invite-left')).toHaveTextContent('23 days left');
        // The names-list entry id is never drawn.
        expect(document.body.textContent).not.toContain('entry-1');
    });

    it('a plain invite with a note says "For: Kim" and "Plain invite"; one with nothing shows its code', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        const kim = rows().find((r) => r.textContent?.includes('For: Kim'))!;
        expect(within(kim).getByTestId('invite-carries')).toHaveTextContent('Plain invite');
        expect(within(kim).getByTestId('invite-left')).toHaveTextContent('29 days left');
        const plain = rowOf('INV-PLAIN-0003')!;
        expect(plain).toBeTruthy();
        expect(within(plain).getByTestId('invite-carries')).toHaveTextContent('Plain invite');
    });

    it('red at 3 days left or fewer, and not before', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        expect(within(rowOf('INV-PLAIN-0003')!).getByTestId('invite-left')).toHaveTextContent('2 days left');
        expect(within(rowOf('INV-PLAIN-0003')!).getByTestId('invite-left').className).toContain('text-bp-ink-danger');
        const bound = rows().find((r) => r.textContent?.includes('Name on the phone'))!;
        expect(within(bound).getByTestId('invite-left').className).not.toContain('text-bp-ink-danger');
    });

    it('a code made for a request to join says so, and the applicant\'s key is never shown as a name', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        const knock = rows().find((r) => r.textContent?.includes('For someone who asked to join'))!;
        expect(knock).toBeTruthy();
        expect(document.body.textContent).not.toContain(APPLICANT_KEY);
    });

    it('Joined: who joined and when, once opened', async () => {
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByTestId('invites-joined-fold'));
        const joined = await screen.findByTestId('invite-joined-row');
        expect(joined).toHaveTextContent('INV-USED-0006 · @joanne');
        expect(joined).toHaveTextContent(/Joined \d{1,2} \w{3} \d{4}/);
    });
});

describe('the whole row opens the invite', () => {
    it('its QR holds the link, its code is shown, Share is on it, and Close closes it', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await openPending();
        fireEvent.click(rows().find((r) => r.textContent?.includes('For: Kim'))!);
        const sheet = await screen.findByTestId('invite-sheet');
        expect(within(sheet).getByTestId('invite-who')).toHaveTextContent('For: Kim');
        expect(within(sheet).getByTestId('qr')).toHaveAttribute('data-value', `${window.location.origin}/?invite=INV-NOTE-0002`);
        expect(sheet).toHaveTextContent('INV-NOTE-0002');
        expect(within(sheet).getByRole('button', { name: 'Share invite link' })).toBeInTheDocument();
        fireEvent.click(within(sheet).getByTestId('invite-sheet-close'));
        expect(screen.queryByTestId('invite-sheet')).toBeNull();
    });
});

// The words sweep (invites-vouching I6): three sentences the design retired, asserted absent from what the page draws.
const RETIRED_INVITE_WORDS = ['Invited directly by the system admin', 'Vetted by the admin at sign-up', 'Share this cryptographic code'];

describe('the retired sentences are drawn nowhere (invites-vouching I6)', () => {
    it('after Generate, and again with the form back and Pending and Joined open: none of the three', async () => {
        const { container } = render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await screen.findByTestId('invite-made-card');
        for (const gone of RETIRED_INVITE_WORDS) expect(container.textContent).not.toContain(gone);
        fireEvent.click(screen.getByTestId('invite-make-another'));
        fireEvent.click(await screen.findByTestId('invites-pending-fold'));
        fireEvent.click(await screen.findByTestId('invites-joined-fold'));
        expect(rows().length).toBeGreaterThan(0);
        for (const gone of RETIRED_INVITE_WORDS) expect(container.textContent).not.toContain(gone);
    });
});

describe('the made card and the folded form', () => {
    it('after Generate the card says who it is for, what it carries and 30 days; the form is gone until Make another invite', async () => {
        INVITES.rows = [];
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.change(await screen.findByPlaceholderText("A note for you, kept on your community's server"), { target: { value: 'Sam' } });
        fireEvent.click(screen.getByRole('radio', { name: /100/ }));
        fireEvent.click(screen.getByRole('button', { name: /Generate New Invite/ }));
        const card = await screen.findByTestId('invite-made-card');
        expect(within(card).getByTestId('invite-made-title')).toHaveTextContent('Invite for Sam');
        expect(within(card).getByTestId('invite-made-carries')).toHaveTextContent('100 vouch');
        expect(within(card).getByTestId('invite-made-left')).toHaveTextContent('30 days left');
        expect(card).not.toHaveTextContent('cryptographic');
        // A second code is a deliberate tap.
        expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
        expect(screen.queryByPlaceholderText("A note for you, kept on your community's server")).toBeNull();
        fireEvent.click(screen.getByTestId('invite-make-another'));
        expect(screen.getByRole('button', { name: /Generate New Invite/ })).toBeInTheDocument();
        expect(screen.getByPlaceholderText("A note for you, kept on your community's server")).toBeInTheDocument();
        expect(screen.queryByTestId('invite-make-another')).toBeNull();
    });

    it('an invite with no name or vouch says "Invite made · Plain invite"', async () => {
        INVITES.rows = [];
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        const card = await screen.findByTestId('invite-made-card');
        expect(within(card).getByTestId('invite-made-title')).toHaveTextContent('Invite made');
        expect(within(card).getByTestId('invite-made-carries')).toHaveTextContent('Plain invite');
    });
});
