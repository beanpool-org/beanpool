/**
 * The two names-list boxes on the web's invite screen (DESIGN-invites-and-names-list-amend3-fable.md §1, §4, slice A3; Marty,
 * 8 Nov, Q2: phone first). An owner or admin on a node that offers the names list sees "Add them to the names list" and
 * "Make them a voucher" greyed under the vouch presets, with one sentence; a member sees nothing new; the presets and what
 * an invite sends are as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({
            success: true,
            invite: { code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getVouchersBlock: vi.fn(async () => null),
        myNodeRoleOnce: vi.fn(async () => 'owner'),
        getMyVouching: vi.fn(async () => ({
            voucher: true,
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
        })),
    };
});

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
    })),
}));

vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';
import { generateInvite, getMyVouching, myNodeRoleOnce } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

const SENTENCE = 'On the phone for now: the names list’s keys live on the admins’ phones.';

/** Renders the page and lets the node's answers (its info, the signer's role, the vouch budget) all land. */
async function renderPage(props: { preview?: boolean } = {}) {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} {...props} />);
    if (!props.preview) {
        await waitFor(() => expect(myNodeRoleOnce).toHaveBeenCalled());
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await waitFor(() => expect(getMyVouching).toHaveBeenCalled());
    }
    await screen.findByText(/Invite Someone/);
    // One more turn so the answers above are set into the page before anything is asserted absent.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('InvitePage: the names-list boxes, greyed on the web (A3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.mocked(myNodeRoleOnce).mockResolvedValue('owner');
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
        } as never);
    });

    it('an owner sees both boxes greyed (disabled and aria-disabled) with the one sentence', async () => {
        await renderPage();

        const names = await screen.findByTestId('invite-adds-names');
        const voucher = screen.getByTestId('invite-adds-voucher');
        expect(screen.getByText('Add them to the names list')).toBeInTheDocument();
        expect(screen.getByText('Make them a voucher')).toBeInTheDocument();
        for (const box of [names, voucher]) {
            expect(box).toHaveAttribute('type', 'checkbox');
            expect(box).toBeDisabled();
            expect(box).toHaveAttribute('aria-disabled', 'true');
            expect(box).not.toBeChecked();
        }
        const note = screen.getByTestId('invite-adds-note');
        expect(note).toHaveTextContent(SENTENCE);
        expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
        // The sentence names why they are greyed, for a screen reader on each box.
        expect(names).toHaveAttribute('aria-describedby', note.id);
        expect(voucher).toHaveAttribute('aria-describedby', note.id);
    });

    it('an admin sees them too, even one who is not a voucher (no presets)', async () => {
        vi.mocked(myNodeRoleOnce).mockResolvedValue('admin');
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: false, presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [],
        });
        await renderPage();

        expect(await screen.findByTestId('invite-adds-names')).toBeDisabled();
        expect(screen.getByTestId('invite-adds-voucher')).toBeDisabled();
        expect(screen.queryByTestId('invite-vouch')).not.toBeInTheDocument();
    });

    it.each([
        ['a member (the node says no role)', null],
        ['a moderator', 'moderator'],
        ['a signer whose role the node has not said yet', undefined],
    ])('%s sees nothing new', async (_who, role) => {
        vi.mocked(myNodeRoleOnce).mockResolvedValue(role as string | null | undefined);
        await renderPage();

        expect(screen.getByTestId('invite-vouch')).toBeInTheDocument();
        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
        expect(screen.queryByText('Add them to the names list')).not.toBeInTheDocument();
        expect(screen.queryByText('Make them a voucher')).not.toBeInTheDocument();
        expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('an owner on a node that keeps no names list (the global profile) sees nothing new', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { invites: true, beans: true },
        } as never);
        await renderPage();

        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('an owner on a node that has not said what it is (its info never came) sees nothing new', async () => {
        vi.mocked(communityInfoOnce).mockRejectedValue(new Error('offline'));
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(myNodeRoleOnce).toHaveBeenCalled());
        await screen.findByTestId('invite-vouch');
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
    });

    it('the preview (invites on the global node) never asks the role and shows no boxes', async () => {
        await renderPage({ preview: true });

        expect(myNodeRoleOnce).not.toHaveBeenCalled();
        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
    });

    it('the vouch presets are as before, and the boxes sit under them and above the Generate button', async () => {
        await renderPage();

        const presets = screen.getByTestId('invite-vouch');
        const boxes = await screen.findByTestId('invite-adds');
        const generate = screen.getByRole('button', { name: /Generate/ });
        for (const id of ['none', '25', '50', '75', '100']) {
            expect(screen.getByTestId(`invite-vouch-${id}`)).not.toBeDisabled();
        }
        expect(presets.compareDocumentPosition(boxes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(boxes.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the boxes cannot be ticked, and an invite is made exactly as before (the picked vouch, nothing else)', async () => {
        await renderPage();

        const names = await screen.findByTestId('invite-adds-names');
        const voucher = screen.getByTestId('invite-adds-voucher');
        // Taps the way a person makes them: on the words, and on the box itself. user-event does not deliver a click to a
        // disabled control, as a browser does not (a bare dispatchEvent click does tick one in jsdom, which no person can send).
        const user = userEvent.setup();
        await user.click(screen.getByText('Add them to the names list'));
        await user.click(screen.getByText('Make them a voucher'));
        await user.click(names);
        await user.click(voucher);
        expect(names).not.toBeChecked();
        expect(voucher).not.toBeChecked();
        // Not in the tab order either (no focus trap): walk the whole page with Tab. The walk must reach the Generate button,
        // which comes after the boxes, so it did pass where they are, and must never have stopped on either box.
        const generate = screen.getByRole('button', { name: /Generate/ });
        const stops = new Set<Element | null>();
        for (let i = 0; i < 60; i++) {
            await user.tab();
            stops.add(document.activeElement);
        }
        expect(stops.has(generate)).toBe(true);
        expect(stops.has(names)).toBe(false);
        expect(stops.has(voucher)).toBe(false);

        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(generateInvite).toHaveBeenCalledWith(IDENTITY.publicKey, undefined, 50);
        // No extra argument: the web sends no names-list entry and no voucher level.
        expect(vi.mocked(generateInvite).mock.calls[0]).toHaveLength(3);
    });

    it('an invite with no vouch picked is made with the two arguments it always had', async () => {
        await renderPage();
        await screen.findByTestId('invite-adds');

        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(vi.mocked(generateInvite).mock.calls[0]).toEqual([IDENTITY.publicKey, undefined]);
    });
});
