import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QRCodeSVG } from 'qrcode.react';

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
// The QR code spy: verifies what value is encoded.
vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { buildOfflineInviteCode, generateInvite, getInviteTree, getMyInvites } from '../lib/api';
import { communityLinkText, invitesOn, invitesOffRefusal, INVITES_OFF_FALLBACK } from '../lib/node-invites';
import { LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET } from '@beanpool/core';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
const info = (features: Record<string, boolean>, profile: 'local' | 'global' = 'global') =>
    ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile, features });
const GLOBAL = info({ beans: false, openJoin: true, guestListingsOnly: true, decisions: false, invites: false });
const WORDS = 'This community doesn’t use invites: anyone joins it with a sign-in in the BeanPool app. To bring someone here, share its link.';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(communityInfoOnce).mockImplementation(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} }) as never);
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
    it('the global node that previews (showcase): the plain words say 12 words or a sign-in, and the 🏘️ line opens the sheet', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({ ...GLOBAL, features: { ...GLOBAL.features, showcase: true } });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(screen.getByText(/Bring someone here/)).toBeInTheDocument());
        expect(screen.getByText(/Anyone can join it with 12 words or a sign-in/)).toBeInTheDocument();
        const line = await screen.findByTestId('local-community-line');
        expect(line.textContent).toBe(LOCAL_COMMUNITY_LINES.invites);
        fireEvent.click(line);
        expect(screen.getByTestId('local-community-sheet').textContent).toContain(LOCAL_COMMUNITY_SHEET.features.invites);
    });

    it('a node whose 12-words door is shut (wordsDoor false): the plain words say a sign-in only', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({ ...GLOBAL, features: { ...GLOBAL.features, wordsDoor: false } });
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(/Anyone can join it with a sign-in/)).toBeInTheDocument());
        expect(screen.queryByText(/12 words/)).toBeNull();
    });

    it('the global node without showcase (a server from before it): no line, as today', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue(GLOBAL);
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(/Bring someone here/)).toBeInTheDocument());
        expect(screen.queryByTestId('local-community-line')).toBeNull();
    });

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

    it('the whole tree refused (403 members_on_demand, features.openMembership): no tree drawn, no error, the link to share', async () => {
        // DESIGN-global-member-privacy-fable.md §3: where anyone can join in a minute the whole invite tree is every member,
        // and the node refuses it. The page asks for it as it always did, and swallows the refusal.
        vi.mocked(communityInfoOnce).mockResolvedValue({ ...GLOBAL, features: { ...GLOBAL.features, membersOnDemand: true, openMembership: true } });
        vi.mocked(getInviteTree).mockRejectedValue(Object.assign(new Error('On this community you see the people you invited, not everyone: ask with root set to your own key'), { status: 403, code: 'members_on_demand' }));
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(/Bring someone here/)).toBeInTheDocument());
        await waitFor(() => expect(getInviteTree).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /Tree/ })).toBeNull();
        expect(screen.queryByText(/Community Tree/)).toBeNull();
        expect(screen.queryByText(/No members yet/)).toBeNull();
        expect(screen.queryByText(/not everyone|members_on_demand|people you invited/)).toBeNull();
        expect(screen.getByText(window.location.origin)).toBeInTheDocument();
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

describe('the Invites page reads nothing of the member\'s where invites are in preview (global previews audit, P3)', () => {
    const SHOWCASE = { ...GLOBAL, features: { ...GLOBAL.features, escrow: false, enterprises: false, showcase: true } };

    it('global (previews): the line, and neither the member\'s codes nor the invite tree is asked', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue(SHOWCASE as never);
        render(<InvitePage identity={IDENTITY} />);
        await screen.findByTestId('invites-local-line');
        await new Promise(r => setTimeout(r, 0));
        expect(getMyInvites).not.toHaveBeenCalled();
        expect(getInviteTree).not.toHaveBeenCalled();
    });

    it('with a paper ticket kept in this browser: the node is still asked for nothing', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue(SHOWCASE as never);
        localStorage.setItem(`bp_offline_invites_${IDENTITY.publicKey}`, JSON.stringify([{ code: 'BP-kept-ticket', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null }]));
        render(<InvitePage identity={IDENTITY} />);
        await screen.findByTestId('invites-local-line');
        await new Promise(r => setTimeout(r, 0));
        expect(getMyInvites).not.toHaveBeenCalled();
    });

    it('local (live): both are asked, as before', async () => {
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => { expect(getMyInvites).toHaveBeenCalledWith(IDENTITY.publicKey); expect(getInviteTree).toHaveBeenCalled(); });
    });

    it('invites off with no previews (hidden): both still asked, as before', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue(GLOBAL as never);
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => { expect(getMyInvites).toHaveBeenCalled(); expect(getInviteTree).toHaveBeenCalled(); });
    });
});

describe('the Invites page in preview mode shows the real screen with sample data', () => {
    const SHOWCASE = { ...GLOBAL, features: { ...GLOBAL.features, escrow: false, enterprises: false, showcase: true } };

    it('renders Example Valley invites: pending EXAMPLE-1234, used invites, community tree, and marker actions', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue(SHOWCASE as never);
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);

        // Strip, sample header, and invites-preview wrapper are present
        expect(await screen.findByTestId('local-community-strip')).toBeInTheDocument();
        expect(screen.getByTestId('sample-header')).toBeInTheDocument();
        expect(screen.getByTestId('invites-preview')).toBeInTheDocument();

        // Top line stays
        expect(await screen.findByText(/Bring someone here/)).toBeInTheDocument();
        const line = await screen.findByTestId('local-community-line');
        expect(line).toBeInTheDocument();

        // Real screen elements are present
        expect(screen.getByRole('button', { name: /Invites/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Tree/ })).toBeInTheDocument();

        // Pending invite card with EXAMPLE-1234
        expect(await screen.findByText(/EXAMPLE-1234/)).toBeInTheDocument();
        expect(screen.getAllByText(/For: a neighbour/).length).toBe(3);

        // Used invites
        expect(screen.getByText(/EXAMPLE-5678/)).toBeInTheDocument();
        expect(screen.getByText(/EXAMPLE-9012/)).toBeInTheDocument();

        // Marker actions: Generate and Share open the sheet
        const generateBtn = screen.getByRole('button', { name: /Generate New Invite/ });
        expect(generateBtn).toHaveAttribute('data-testid', 'local-community-action');
        fireEvent.click(generateBtn);
        const sheet = await screen.findByTestId('local-community-sheet');
        expect(sheet).toBeInTheDocument();
        expect(sheet.textContent).toContain(LOCAL_COMMUNITY_SHEET.features.invites);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

        // Share button on the pending card is a marker action
        const shareBtns = screen.getAllByRole('button', { name: /Share/ });
        const cardShare = shareBtns.find(b => b.getAttribute('data-testid') === 'local-community-action');
        expect(cardShare).toBeDefined();
        fireEvent.click(cardShare!);
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));

        // Copy button on the pending card is a marker action
        const writeText = vi.fn();
        Object.assign(navigator, { clipboard: { writeText } });
        const copyBtns = screen.getAllByRole('button', { name: /Copy/ });
        const cardCopy = copyBtns.find(b => b.getAttribute('data-testid') === 'local-community-action');
        expect(cardCopy).toBeDefined();
        fireEvent.click(cardCopy!);
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));
        expect(writeText).not.toHaveBeenCalled();

        // Tapping the phone/QR icon opens the QR card
        const qrToggle = screen.getByRole('button', { name: 'Show QR code' });
        fireEvent.click(qrToggle);
        expect(vi.mocked(QRCodeSVG).mock.calls[0][0]).toEqual(
            expect.objectContaining({ value: 'EXAMPLE-1234' }),
        );

        // QR card copy button is also a marker action and does not copy
        const qrCopyBtns = screen.getAllByRole('button', { name: /Copy/ }).filter(b => b.getAttribute('data-testid') === 'local-community-action');
        expect(qrCopyBtns.length).toBeGreaterThanOrEqual(2);
        fireEvent.click(qrCopyBtns[qrCopyBtns.length - 1]);
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));
        expect(writeText).not.toHaveBeenCalled();

        // Community Tree tab shows sample members
        fireEvent.click(screen.getByRole('button', { name: /Tree/ }));
        expect((await screen.findAllByText(/an example member/)).length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText(/a neighbour/).length).toBeGreaterThanOrEqual(2);

        // No network calls made for member's own invites/tree/generate
        expect(getMyInvites).not.toHaveBeenCalled();
        expect(getInviteTree).not.toHaveBeenCalled();
        expect(generateInvite).not.toHaveBeenCalled();
    });
});

