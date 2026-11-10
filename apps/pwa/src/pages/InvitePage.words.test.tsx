/**
 * The Invites page in the member's language (words S3, web sweep W4): in the pseudo-locale every word it writes came
 * through t(), lib/node-invites.ts's sentences included; who an invite is for, members' names and the codes are shown as
 * written, and the dates are core's. The message an invite is shared with is the member's language too. In English
 * nothing is bracketed and the words are as they were.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { formatDate, inviteFolds } from '@beanpool/core';

const INFO = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
// Two days ago: inside an invite's 30 days, so the codes below are still pending.
const AT = vi.hoisted(() => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    const at = AT;
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({ success: true, invite: { code: 'INV-NEW1-CODE', createdBy: 'me', createdAt: at, usedBy: null, usedAt: null } })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getCommunityCard: vi.fn(async () => ({ name: 'Mullum', host: window.location.host, members: null, area: null, joining: 'invite', askUrl: null, globalUrl: null })),
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
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: INFO.features })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';
import { generateInvite } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
/** What others wrote, and codes: shown as written. */
const OTHERS = ['Kim', 'Lou', 'Ana', 'Bo', 'INV-OLD1-CODE', 'INV-USED-CODE', 'INV-NEW1-CODE', window.location.origin, 'A', 'B'];

beforeEach(() => {
    localStorage.clear();
    inviteFolds.clear();
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
        // Pending and Joined are folded until opened, with their counts in the row.
        const fold = await screen.findByText(xx('Pending ({count})').replace('{count}', '1'));
        expect(screen.getByText(xx('Joined ({count})').replace('{count}', '1'))).toBeInTheDocument();
        expect(screen.queryByText(xx('For: {name}').replace('{name}', 'Kim'))).toBeNull();
        fireEvent.click(fold);
        expect(await screen.findByText(xx('For: {name}').replace('{name}', 'Kim'))).toBeInTheDocument();
        expect(screen.getByText(xx('Plain invite'))).toBeInTheDocument();
        fireEvent.click(screen.getByText(xx('Joined ({count})').replace('{count}', '1')));
        expect(await screen.findByText(xx('Joined {date}').replace('{date}', formatDate(new Date(AT), 'day-month-year')))).toBeInTheDocument();
        allThroughWords();

        fireEvent.click(screen.getByRole('button', { name: xx('✨ Generate New Invite') }));
        expect(await screen.findByText(xx('Invite made'))).toBeInTheDocument();
        allThroughWords();

        const share = vi.fn(async (_data: ShareData) => {});
        vi.stubGlobal('navigator', { ...navigator, share });
        fireEvent.click(screen.getAllByRole('button', { name: xx('Share invite link') })[0]);
        await waitFor(() => expect(share).toHaveBeenCalled());
        const sent = share.mock.calls[0][0];
        expect(sent.title).toBe(xx('Join me on BeanPool'));
        // Front doors S10: plain words, the community's name from its card, the link, the code, the address; no "node", no "URL".
        expect(sent.text).toBe(
            xx("Join my BeanPool community, {name}:\n{link}\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\n{code}\n\nCommunity address: {address}")
                .replace('{name}', 'Mullum').replace('{link}', `${window.location.origin}/?invite=INV-NEW1-CODE`)
                .replace('{code}', 'INV-NEW1-CODE').replace('{address}', window.location.host),
        );

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
        const day = formatDate(new Date(AT), 'day-month-year');
        fireEvent.click(await screen.findByText('Pending (1)'));
        expect(await screen.findByText('For: Kim')).toBeInTheDocument();
        expect(screen.getByText('28 days left')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Joined (1)'));
        expect(await screen.findByText('Joined ' + day)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '🌳 Tree' }));
        expect(await screen.findByText('Joined ' + day + ' · 1 invite')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
    });

    it('nothing on it says vouch (the reset, R0): the codes, a new code and the tree, and the invite asks with the key alone', async () => {
        vi.mocked(generateInvite).mockClear();
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByTestId('invites-pending-fold'));
        expect(await screen.findByText('For: Kim')).toBeInTheDocument();
        expect(screen.queryByRole('radio')).toBeNull();
        expect(document.body.textContent).not.toMatch(/vouch/i);
        fireEvent.click(screen.getByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(generateInvite).toHaveBeenCalledWith(IDENTITY.publicKey, undefined);
        expect(document.body.textContent).not.toMatch(/vouch/i);
        fireEvent.click(screen.getByRole('button', { name: '🌳 Tree' }));
        expect(await screen.findByText('Joined ' + formatDate(new Date(AT), 'day-month-year') + ' · 1 invite')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/vouch/i);
    });
});
