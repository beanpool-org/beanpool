/**
 * The Invites page in the member's language (words S3, web sweep W4): in the pseudo-locale every word it writes came
 * through t(), lib/node-invites.ts's sentences included; who an invite is for, members' names and the codes are shown as
 * written, and the dates are core's. The message an invite is shared with is the member's language too. In English
 * nothing is bracketed and the words are as they were.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const INFO = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    const at = '2026-10-03T12:00:00.000Z';
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({ success: true, invite: { code: 'INV-NEW1-CODE', createdBy: 'me', createdAt: at, usedBy: null, usedAt: null } })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [
            { code: 'INV-OLD1-CODE', createdBy: 'me', createdAt: at, usedBy: null, usedAt: null, intendedFor: 'Kim' },
            { code: 'INV-USED-CODE', createdBy: 'me', createdAt: at, usedBy: 'x', usedAt: at, intendedFor: 'Lou' },
        ] })),
        getInviteTree: vi.fn(async () => [
            { publicKey: 'a'.repeat(64), callsign: 'Ana', joinedAt: at, inviteCode: '', children: [
                { publicKey: 'c'.repeat(64), callsign: 'Bo', joinedAt: at, inviteCode: 'INV-OLD0-CODE', children: [] },
            ] },
        ]),
        request: vi.fn(async () => ({ role: null, communityName: 'Mullum' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: INFO.features })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
/** What others wrote, and codes: shown as written. */
const OTHERS = ['Kim', 'Lou', 'Ana', 'Bo', 'INV-OLD1-CODE', 'INV-USED-CODE', 'INV-NEW1-CODE', window.location.origin, 'A', 'B'];

beforeEach(() => {
    localStorage.clear();
    INFO.features = { beans: true, knocks: true, invites: true, door: 'members' };
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
});

function allThroughWords(others: readonly string[] = OTHERS, atLeast = 3) {
    expect(bypassing(document.body, { others })).toEqual([]);
    expect(bracketed()).toBeGreaterThanOrEqual(atLeast);
}

describe('the Invites page in the pseudo-locale', () => {
    it('inviting someone: the codes waiting and used, a new code to share, and the tree', async () => {
        await showIn('xx');
        render(<InvitePage identity={IDENTITY} />);
        expect(await screen.findByText(xx('For: {name}').replace('{name}', 'Kim'))).toBeInTheDocument();
        expect(screen.getByText(xx('⏳ Pending ({count})').replace('{count}', '1'))).toBeInTheDocument();
        allThroughWords();

        fireEvent.click(screen.getByRole('button', { name: xx('✨ Generate New Invite') }));
        expect(await screen.findByText(xx('Share this code with someone you trust'))).toBeInTheDocument();
        allThroughWords();

        const share = vi.fn(async (_data: ShareData) => {});
        vi.stubGlobal('navigator', { ...navigator, share });
        fireEvent.click(screen.getAllByRole('button', { name: xx('Share invite link') })[0]);
        await waitFor(() => expect(share).toHaveBeenCalled());
        const sent = share.mock.calls[0][0];
        expect(sent.title).toBe(xx('Join BeanPool Node'));
        expect(sent.text).toBe(xx('Join my BeanPool community node: {url}').replace('{url}', `${window.location.origin}/?invite=INV-NEW1-CODE`));

        fireEvent.click(screen.getByRole('button', { name: xx('🌳 Tree') }));
        expect(await screen.findByText(xx('🌳 Community Tree'))).toBeInTheDocument();
        await screen.findByText('Bo');
        allThroughWords();
    });

    it('where only admins invite, a member is told who does; where the community takes no invites, its link', async () => {
        await showIn('xx');
        INFO.features = { beans: true, knocks: true, invites: true, door: 'admins' };
        render(<InvitePage identity={IDENTITY} />);
        expect(await screen.findByText(xx('In this community only its admins invite people. Share its link: in the BeanPool app they can ask to join, and an admin will answer. Or ask an admin to invite them.'))).toBeInTheDocument();
        allThroughWords();
        cleanup();

        INFO.features = { beans: true, knocks: false, invites: false };
        render(<InvitePage identity={IDENTITY} />);
        expect(await screen.findByText(xx('📤 Bring someone here'))).toBeInTheDocument();
        allThroughWords();
    });

    it('in English nothing is bracketed: the dates as the phone writes them, the counts by their plural', async () => {
        render(<InvitePage identity={IDENTITY} />);
        expect(await screen.findByText('For: Kim')).toBeInTheDocument();
        expect(screen.getByText('⏳ Pending (1)')).toBeInTheDocument();
        expect(screen.getByText('✅ Redeemed (1)')).toBeInTheDocument();
        expect(screen.getAllByText('Created 3 Oct 2026').length).toBeGreaterThan(0);
        expect(screen.getByText('Used 3 Oct 2026')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '🌳 Tree' }));
        expect(await screen.findByText('Joined 3 Oct 2026 · 1 invite')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
    });
});
