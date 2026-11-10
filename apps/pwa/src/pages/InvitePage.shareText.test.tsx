import { inviteFolds } from '@beanpool/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Share on the invite page sends the invite as TEXT ONLY (Marty, 10 Nov: a shared QR picture lost the link, the code and the
 * community's address, and "most people dont know how to scan their own QR code"). `navigator.share` gets a title and the one
 * message, from inside the tap (Safari refuses a share that waited first), and never a file; where the browser has no share the
 * message is copied. The QR stays on the card, for someone standing beside you to scan.
 */

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({
            success: true,
            invite: { code: 'INV-TEST1234', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        })),
        getMyInvites: vi.fn(async () => ({
            invites: [{ code: 'INV-ROWONE99', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null }],
        })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: false, presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [] })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => null),
        // The member's own role, asked only where the door is admins (the last test): a member, who may not invite.
        request: vi.fn(async () => ({ role: 'member' })),
    };
});

// What the community says about itself; one test below makes it a community where only admins invite.
const community = vi.hoisted(() => ({ features: { invites: true, beans: true } as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: community.features,
    })),
}));

// A member's answered ask (an invite an admin made for them to pass on): the third place Share lives on this page.
vi.mock('../lib/invite-asks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/invite-asks')>();
    return {
        ...actual,
        readMyAsks: vi.fn(async () => ({
            waiting: [],
            answers: [{ id: 'n1', outcome: 'invited', state: 'ready', code: 'INV-ASKED123', askedAt: '2026-11-03T00:00:00.000Z', answeredAt: '2026-11-04T00:00:00.000Z' }],
        })),
    };
});

// The QR's drawing is not under test; its value is (it is the link a scan opens).
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} /> }));

import { InvitePage } from './InvitePage';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

function setNavigator(over: { share?: unknown; canShare?: unknown; writeText?: unknown }) {
    for (const [key, value] of Object.entries({ share: over.share, canShare: over.canShare, clipboard: over.writeText ? { writeText: over.writeText } : undefined })) {
        Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
    }
}

const messageFor = (code: string) => [
    `Join my BeanPool community, ${window.location.host}:`,
    `${window.location.origin}/?invite=${code}`,
    '',
    "If the link doesn't open, install BeanPool from beanpool.org and paste this code:",
    code,
    '',
    `Community address: ${window.location.host}`,
].join('\n');

/** Generate an invite; the QR card's Share is the first "Share invite link" button on the page. */
async function newInvite() {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
    await screen.findByText('INV-TEST1234', { selector: 'p' });
    return screen.getAllByRole('button', { name: 'Share invite link' })[0];
}

beforeEach(() => { localStorage.clear(); inviteFolds.clear(); community.features = { invites: true, beans: true }; });
afterEach(() => {
    cleanup();
    for (const key of ['share', 'canShare', 'clipboard']) delete (navigator as unknown as Record<string, unknown>)[key];
});

describe('Share on a new invite', () => {
    it('sends the whole message as text from inside the tap: the link, the code, the address, and no file', async () => {
        const share = vi.fn(async (_data: ShareData) => {});
        const canShare = vi.fn(() => true);
        setNavigator({ share, canShare });
        const button = await newInvite();

        fireEvent.click(button);
        // Not after an await: Safari refuses a share that waited first.
        expect(share).toHaveBeenCalledTimes(1);

        const data = share.mock.calls[0][0] as ShareData;
        expect(data).toEqual({ title: 'Join me on BeanPool', text: messageFor('INV-TEST1234') });
        expect(Object.keys(data).sort()).toEqual(['text', 'title']);
        // No `files` and no `url`: the browser is never asked whether it can take a picture.
        expect(data.files).toBeUndefined();
        expect(data.url).toBeUndefined();
        expect(canShare).not.toHaveBeenCalled();
    });

    it('still shows the invite\'s QR on the card, for someone beside you to scan', async () => {
        setNavigator({ share: vi.fn(async () => {}) });
        await newInvite();
        const values = screen.queryAllByTestId('qr').map((el) => el.getAttribute('data-value'));
        expect(values).toContain(`${window.location.origin}/?invite=INV-TEST1234`);
    });

    it('copies the same message where the browser has no share', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        setNavigator({ writeText });
        fireEvent.click(await newInvite());

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(writeText).toHaveBeenCalledWith(messageFor('INV-TEST1234'));
    });

    it('does nothing more when the person closes the share', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        const share = vi.fn(async (_data: ShareData) => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); });
        setNavigator({ share, writeText });
        fireEvent.click(await newInvite());

        await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
    });

    it('offers no picture to save anywhere on the page', async () => {
        setNavigator({ writeText: vi.fn(async () => {}) });
        fireEvent.click(await newInvite());
        // The copy answers with the Copy buttons' own "✓ Copied!", and nothing about a picture.
        await screen.findAllByText('✓ Copied!');
        expect(screen.queryByRole('button', { name: /QR picture/i })).toBeNull();
        expect(screen.queryByTestId('invite-copied-note')).toBeNull();
    });
});

describe('Share on an invite already made', () => {
    it('sends that invite\'s own message, as text only', async () => {
        const share = vi.fn(async (_data: ShareData) => {});
        setNavigator({ share, canShare: () => true });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        // Pending is folded until opened; the row opens the invite, and Share is on it.
        fireEvent.click(await screen.findByTestId('invites-pending-fold'));
        fireEvent.click(await screen.findByTestId('invite-pending-row'));
        expect(screen.getByTestId('invite-sheet')).toHaveTextContent('INV-ROWONE99');

        fireEvent.click(screen.getByRole('button', { name: 'Share invite link' }));
        expect(share).toHaveBeenCalledTimes(1);
        const data = share.mock.calls[0][0] as ShareData;
        expect(data).toEqual({ title: 'Join me on BeanPool', text: messageFor('INV-ROWONE99') });
        expect(data.files).toBeUndefined();
        expect(data.url).toBeUndefined();
    });
});

describe('Share on an invite an admin made for you (where only admins invite)', () => {
    it('sends that invite\'s message, as text only', async () => {
        community.features = { invites: true, beans: true, inviteAsks: true, door: 'admins' };
        const share = vi.fn(async (_data: ShareData) => {});
        setNavigator({ share, canShare: () => true });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        const row = await screen.findByTestId('invite-ask-answer-n1');

        fireEvent.click(within(row).getByRole('button', { name: 'Share invite link' }));
        expect(share).toHaveBeenCalledTimes(1);
        const data = share.mock.calls[0][0] as ShareData;
        expect(data).toEqual({ title: 'Join me on BeanPool', text: messageFor('INV-ASKED123') });
        expect(data.files).toBeUndefined();
        expect(data.url).toBeUndefined();
    });
});
