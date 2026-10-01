import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * No invites on the global node (Marty, 2026-10-01: "Off on global"; config/node-profile.ts `invites` on the server):
 * anyone joins it with a sign-in, so the Invites page there makes nothing (no code, no QR, no ticket, no pending list,
 * no invite tree) and offers the community's plain link to share. Every node that takes invites, and one too old to
 * say, exactly as before.
 */

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({ success: true, invite: { code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null } })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [{ code: 'INV-OLD1-CODE', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null }] })),
        getInviteTree: vi.fn(async () => []),
    };
});
// The node's /api/community/info, read once per page load. By default it says nothing about invites, as every node
// before the switch.
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} })),
}));
// The QR code isn't what is under test, and qrcode.react brings its own copy of React.
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { buildOfflineInviteCode, generateInvite } from '../lib/api';
import { communityLinkText, invitesOn, invitesOffRefusal, INVITES_OFF_FALLBACK } from '../lib/node-invites';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
const info = (features: Record<string, boolean>, profile: 'local' | 'global' = 'global') =>
    ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile, features });
const GLOBAL = info({ beans: false, openJoin: true, guestListingsOnly: true, decisions: false, invites: false });
const WORDS = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
});

describe('node-invites', () => {
    it('only a node that says outright it makes no invites makes none', () => {
        expect(invitesOn(GLOBAL)).toBe(false);
        expect(invitesOn(info({ invites: true }, 'local'))).toBe(true);
        expect(invitesOn(info({}, 'local'))).toBe(true);
        expect(invitesOn(null)).toBe(true);
        expect(invitesOn(undefined)).toBe(true);
    });

    it("the link is the community's plain address, with no code", () => {
        expect(communityLinkText('https://global.beanpool.org/')).toBe('Join me on BeanPool: https://global.beanpool.org');
    });

    it("only the node's 404 feature_off is read as invites being off", () => {
        const off = Object.assign(new Error(WORDS), { status: 404, code: 'feature_off' });
        expect(invitesOffRefusal(off)).toBe(WORDS);
        expect(invitesOffRefusal(Object.assign(new Error(''), { status: 404, code: 'feature_off' }))).toBe(INVITES_OFF_FALLBACK);
        expect(invitesOffRefusal(new TypeError('Failed to fetch'))).toBeNull();
        expect(invitesOffRefusal(Object.assign(new Error('Not Found'), { status: 404 }))).toBeNull();
        expect(invitesOffRefusal(Object.assign(new Error('Too many'), { status: 429, code: 'writer_limit' }))).toBeNull();
        expect(invitesOffRefusal(null)).toBeNull();
    });
});

describe('the Invites page where the node takes no invites (the global node)', () => {
    it("makes nothing: no generate, no code, no QR, no pending list, no tree; the community's link to copy and share", async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(GLOBAL);
        const share = vi.fn(async () => {});
        Object.defineProperty(navigator, 'share', { value: share, configurable: true });
        try {
            render(<InvitePage identity={IDENTITY} />);
            await waitFor(() => expect(screen.getByText(/Bring someone here/)).toBeInTheDocument());
            expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
            expect(screen.queryByText(/Invite Someone/)).toBeNull();
            expect(screen.queryByPlaceholderText(/Who is this invite for/)).toBeNull();
            expect(screen.queryByText(/INV-OLD1-CODE/)).toBeNull();
            expect(screen.queryByRole('button', { name: /Tree/ })).toBeNull();
            expect(screen.getByText(window.location.origin)).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: "Share this community's link" }));
            await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'BeanPool', text: communityLinkText(window.location.origin) }));
            const sent = (share.mock.calls[0] as unknown as [{ text: string }])[0].text;
            expect(sent).not.toMatch(/invite=|INV-|BP-/);
            expect(generateInvite).not.toHaveBeenCalled();
        } finally {
            delete (navigator as { share?: unknown }).share;
        }
    });

    it("a generate the node refuses before the page heard: the node's words, and no offline ticket", async () => {
        // The info read hasn't answered yet, so the page is drawn as before; the node answers the generate itself.
        vi.mocked(communityInfoOnce).mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(generateInvite).mockRejectedValueOnce(Object.assign(new Error(WORDS), { status: 404, code: 'feature_off' }));
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(screen.getByText(WORDS)).toBeInTheDocument());
        expect(screen.getByText(/Bring someone here/)).toBeInTheDocument();
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
        expect(localStorage.getItem(`bp_offline_invites_${IDENTITY.publicKey}`)).toBeNull();
    });
});

describe('the Invites page everywhere else: as before', () => {
    for (const [label, answer] of [
        ['a node that takes invites', () => Promise.resolve(info({ invites: true }, 'local'))],
        ['a node too old to say', () => Promise.resolve(info({ beans: true }, 'local'))],
        ['an unanswered read', () => Promise.reject(new Error('offline'))],
    ] as const) {
        it(`${label}: Generate, the pending code and the tree`, async () => {
            vi.mocked(communityInfoOnce).mockImplementationOnce(answer as () => Promise<any>);
            render(<InvitePage identity={IDENTITY} />);
            await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
            expect(await screen.findByRole('button', { name: /Generate New Invite/ })).toBeInTheDocument();
            expect(await screen.findByText(/INV-OLD1-CODE/)).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Tree/ })).toBeInTheDocument();
            expect(screen.queryByText(/Bring someone here/)).toBeNull();
        });
    }

    it('an unreachable node still gets an offline ticket, as before', async () => {
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(buildOfflineInviteCode).toHaveBeenCalled());
        expect(screen.queryByText(/Bring someone here/)).toBeNull();
    });
});
