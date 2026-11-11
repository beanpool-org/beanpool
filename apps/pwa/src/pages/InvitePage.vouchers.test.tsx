/**
 * The Vouchers block on the web's Invites screen, reshaped (invites-vouching I4; DESIGN-invites-vouching-review-fable.md §3 asks
 * 1, 4 and 5(b), §3 "the invite panel keeps the names box and gets a link"): owners pinned first under one line "Owners · no
 * limit", each row "@Marty · 2 vouched ›" with no budget words; every other voucher "@Rob · 400 left ›"; a Waiting to join
 * section from the node's `waiting`, whose names are sealed in the names list (the web holds no key), so each row says "Name on
 * the phone"; and "Invite someone from the names list ›" in the invite panel, which says where it is done, as the rows beside it do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const BLOCK = vi.hoisted(() => ({ body: null as null | Record<string, unknown> }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: true, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], budget: { level: 100000, left: 90000 } })),
        getVouchersBlock: vi.fn(async () => BLOCK.body),
        getVoucherCard: vi.fn(async () => { throw new Error('not opened in this test'); }),
        myNodeRoleOnce: vi.fn(async () => 'owner'),
        getCommunityCard: vi.fn(async () => null),
        request: vi.fn(async () => ({ role: 'owner' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, beans: true } })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Owen', createdAt: '2026-10-01T00:00:00.000Z' };
const row = (pk: string, callsign: string, over: Record<string, unknown> = {}) => ({
    memberPubkey: pk, callsign, source: 'entry', entryId: null, madeBy: null, madeByCallsign: '', madeAt: null, stoppedAt: null, stopReason: null,
    left: 40000, held: 0, heldInvites: 0, vouched: 35000, peopleVouched: 4, level: 40000, belowZero: 1, writtenOff: 0,
    passedOn: { amount_c: 0, people: 0, belowZero: 0 }, invitesWithVouch: 0, trading: { withOthers: 0, insideOnly: 0 }, ...over,
});
const SETTINGS = { voucherBudget: 100000, memberGift: 10000, presets: [2500, 5000, 7500, 10000], vouchMax: 10000, vouchesPerPerson: 3, budgetMax: 200000 };
const FULL = {
    vouchers: [
        row('1'.repeat(64), 'Marty', { noLimit: true, source: 'role', peopleVouched: 2, left: 0, level: 0 }),
        row('2'.repeat(64), 'Rob', { left: 40000, level: 90000 }),
    ],
    waiting: [{ entryId: '9'.repeat(32), level: 100000, vouchAmount: 2500, madeBy: '1'.repeat(64), madeByCallsign: 'Marty', madeAt: '2026-11-09T10:00:00Z', expiresAt: '2026-12-09T10:00:00Z' }],
    settings: SETTINGS,
};

beforeEach(() => { localStorage.clear(); BLOCK.body = FULL; });
afterEach(() => cleanup());

async function draw() {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
    await screen.findByTestId('vouchers-block');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const block = () => screen.getByTestId('vouchers-block');

describe('the Vouchers block on the web', () => {
    it('owners first under "Owners · no limit", each row "@Marty · 2 vouched ›" and no budget words', async () => {
        await draw();
        expect(within(block()).getByTestId('vouchers-owners-line')).toHaveTextContent(/^Owners · no limit$/);
        const marty = within(block()).getByTestId('voucher-row-Marty');
        expect(marty).toHaveTextContent(/^@Marty · 2 vouched ›$/);
        expect(marty.textContent).not.toMatch(/left|budget|of \d|below zero|limit/i);
        // Pinned: the owner's row comes before the other voucher's, and the owners' line before both.
        const rob = within(block()).getByTestId('voucher-row-Rob');
        expect(marty.compareDocumentPosition(rob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(block()).getByTestId('vouchers-owners-line').compareDocumentPosition(marty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('every other voucher reads "@Rob · 400 left ›"', async () => {
        await draw();
        expect(within(block()).getByTestId('voucher-row-Rob')).toHaveTextContent(/^@Rob · 400 left ›$/);
        expect(within(block()).getByTestId('voucher-row-Rob').textContent).not.toMatch(/vouched|below zero| of /);
    });

    it('Waiting to join: the promised budget from `waiting`, the name "on the phone" (the web holds no list key), never an entry id', async () => {
        await draw();
        expect(within(block()).getByTestId('vouchers-waiting-heading')).toHaveTextContent('Waiting to join');
        const waiting = within(block()).getByTestId('voucher-waiting-row');
        expect(waiting).toHaveTextContent(/^Name on the phone · waiting to join · budget 1,000 ›$/);
        expect(block().textContent).not.toContain('9'.repeat(32));
        expect(block().textContent).not.toMatch(/balance/i);
        const rob = within(block()).getByTestId('voucher-row-Rob');
        expect(rob.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('a waiting row says where the names list is (the phone), as "+ Make someone a voucher" does', async () => {
        await draw();
        fireEvent.click(within(block()).getByTestId('voucher-waiting-row'));
        expect(await screen.findByTestId('make-voucher-notice')).toBeInTheDocument();
    });

    it('nobody waiting, and a node from before I4 (no `waiting`): no Waiting to join; its owner flag absent, every voucher a "left" row', async () => {
        BLOCK.body = { vouchers: FULL.vouchers.slice(1), settings: SETTINGS };
        await draw();
        expect(screen.queryByTestId('vouchers-waiting-heading')).toBeNull();
        expect(screen.queryByTestId('voucher-waiting-row')).toBeNull();
        expect(screen.queryByTestId('vouchers-owners-line')).toBeNull();
        expect(within(block()).getByTestId('voucher-row-Rob')).toHaveTextContent('@Rob · 400 left ›');
    });

    it('where the node gave no block (a member, a plain admin): none of it', async () => {
        BLOCK.body = null;
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await screen.findByText(/Invite Someone/);
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(screen.queryByTestId('vouchers-block')).toBeNull();
    });
});

describe('the invite panel: the names box stays, and there is a link to the names list', () => {
    it('"Invite someone from the names list ›" sits beside the two rows and says where it is done', async () => {
        await draw();
        await waitFor(() => expect(screen.getByTestId('invite-adds-names')).toBeInTheDocument());
        expect(screen.getByTestId('invite-adds-names')).toBeInTheDocument();
        const link = screen.getByTestId('invite-from-names-list');
        expect(link).toHaveTextContent('Invite someone from the names list ›');
        expect(screen.queryByTestId('invite-adds-note')).toBeNull();
        fireEvent.click(link);
        expect(await screen.findByTestId('invite-adds-note')).toHaveTextContent(
            'Adding someone to the names list, and making them a voucher, is done in the BeanPool app on your phone.',
        );
        expect(link).toHaveAttribute('aria-describedby', screen.getByTestId('invite-adds-note').id);
    });
});
