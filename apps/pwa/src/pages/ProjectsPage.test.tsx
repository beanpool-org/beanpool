import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Treasury, BalanceInfo } from '../lib/api';
import { getTreasuries, getBalance, getDecisions, createEnterprise } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

const mockTreasuries: Treasury[] = [
    {
        publicKey: 'treasury-1',
        name: 'Community Garden Solar Irrigation',
        callsign: 'garden-solar',
        purpose: 'Installing solar-powered automated water pumps and drip irrigation lines for community plots.',
        balance: 150,
        creditLine: 0,
        liveOffers: 1,
        goalAmount: 500,
        currentAmount: 150,
        deadlineAt: '2026-10-31T23:59:59.000Z',
        lifecycle: 'bounded',
        status: 'active',
        avatar: null,
    },
    {
        publicKey: 'treasury-mine',
        name: 'My Own Tool Library Project',
        callsign: 'tool-library',
        purpose: 'Purchasing shared carpentry tools for the community workshop.',
        balance: 0,
        creditLine: 0,
        liveOffers: 0,
        goalAmount: 300,
        currentAmount: 0,
        deadlineAt: null,
        lifecycle: 'bounded',
        status: 'active',
        avatar: null,
    },
];

const mockTreasuryDetail: any = {
    publicKey: 'treasury-1',
    name: 'Community Garden Solar Irrigation',
    callsign: 'garden-solar',
    purpose: 'Installing solar-powered automated water pumps and drip irrigation lines for community plots.',
    balance: 150,
    creditLine: 0,
    goalAmount: 500,
    currentAmount: 150,
    deadlineAt: '2026-10-31T23:59:59.000Z',
    lifecycle: 'bounded',
    status: 'active',
    avatar: null,
    created_at: '2026-09-01T00:00:00.000Z',
    signers: [
        { publicKey: 'keeper-pubkey-123', callsign: 'GardenerBob', role: 'admin' },
    ],
    keepers: [
        { pubkey: 'keeper-pubkey-123', callsign: 'GardenerBob', role: 'admin' },
    ],
    rules: {
        approval_threshold: 1,
        auto_payout_limit: 0,
    },
    posts: [],
    flow: [],
    deferredClaims: [],
};

const mockBalance: BalanceInfo = {
    balance: 100,
    floor: -500,
    commonsBalance: 250,
    earnedCredit: 12,
    callsign: 'CharlieBacker',
    keeperOf: ['treasury-mine'],
    tier: 'contributor' as any,
};

vi.mock('../lib/api', () => ({
    getTreasuries: vi.fn(async () => ({
        treasuries: mockTreasuries,
    })),
    getTreasury: vi.fn(async (pk: string) => {
        if (pk === 'treasury-1') return mockTreasuryDetail;
        return {
            ...mockTreasuryDetail,
            publicKey: pk,
            keepers: [{ pubkey: 'my-user-pubkey', callsign: 'Alice', role: 'admin' }],
        };
    }),
    getBalance: vi.fn(async () => mockBalance),
    createEnterprise: vi.fn(async () => ({ success: true })),
    treasuryPledge: vi.fn(async () => ({ success: true, txId: 'tx-pledge-123' })),
    treasurySweep: vi.fn(async () => ({ success: true })),
    treasuryApprove: vi.fn(async () => ({ success: true })),
    treasuryReject: vi.fn(async () => ({ success: true })),
    treasuryComplete: vi.fn(async () => ({ success: true })),
    treasuryPostOffer: vi.fn(async () => ({ success: true })),
    treasuryPostNeed: vi.fn(async () => ({ success: true })),
    deleteCrowdfundProject: vi.fn(async () => ({ success: true })),
    getDecisions: vi.fn(async () => ({ decisions: [], myPoolVoting: { voiceCredits: 9.6, hasCompletedTrade: true } })),
    getCommonsBalance: vi.fn(async () => ({ balance: 250 })),
    getAllMembers: vi.fn(async () => []),
    getGroups: vi.fn(async () => []),
    createDecision: vi.fn(async () => ({ success: true, decision: { id: 'dec-1' } })),
    proposeDecision: vi.fn(async () => ({ success: true })),
    castDecisionVote: vi.fn(async () => ({ success: true })),
    request: vi.fn(),
}));

const backerIdentity: BeanPoolIdentity = {
    publicKey: 'backer-pubkey-456',
    privateKey: 'privkey-456',
    callsign: 'CharlieBacker',
    createdAt: '2026-09-01T00:00:00Z',
};

const creatorIdentity: BeanPoolIdentity = {
    publicKey: 'my-user-pubkey',
    privateKey: 'privkey-mine',
    callsign: 'Alice',
    createdAt: '2026-09-01T00:00:00Z',
};

describe('ProjectsPage regression: Project Detail scroll container & pledge form clearance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders projects and opens project detail on click via onOpenTreasury', async () => {
        const handleOpenTreasury = vi.fn();
        render(<ProjectsPage identity={backerIdentity} onOpenTreasury={handleOpenTreasury} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Click on the project card to open detail
        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));

        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');
    });

    it('supports keyboard navigation (Enter and Space) on enterprise cards', async () => {
        const handleOpenTreasury = vi.fn();
        render(<ProjectsPage identity={backerIdentity} onOpenTreasury={handleOpenTreasury} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        const cards = screen.getAllByRole('button').filter(el => el.getAttribute('tabindex') === '0');
        expect(cards.length).toBeGreaterThan(0);
        const firstCard = cards[0];

        // Enter key activates card
        fireEvent.keyDown(firstCard, { key: 'Enter' });
        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');

        handleOpenTreasury.mockClear();

        // Space key activates card
        fireEvent.keyDown(firstCard, { key: ' ' });
        expect(handleOpenTreasury).toHaveBeenCalledWith('treasury-1');
    });

    it('ensures ProjectsPage scroll container has overflow-y: auto and paddingBottom: var(--bottom-nav-offset)', async () => {
        const { container } = render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Verify the root page container has overflowY: auto and var(--bottom-nav-offset) clearance (#788)
        const rootContainer = container.firstElementChild as HTMLElement;
        expect(rootContainer).not.toBeNull();
        expect(rootContainer).toHaveStyle({ overflowY: 'auto' });
        expect(rootContainer).toHaveStyle({ paddingBottom: 'var(--bottom-nav-offset)' });
    });

    it('ensures propose enterprise modal has dynamic bottom-nav-offset clearance and closes on Escape', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Click propose button to open modal
        const proposeBtn = screen.getByRole('button', { name: /\+ Propose/i });
        fireEvent.click(proposeBtn);

        const modalHeading = screen.getByRole('heading', { name: 'Propose an Enterprise / Project' });
        expect(modalHeading).toBeInTheDocument();

        // Verify modal outer container has dynamic paddingBottom clearance (#791)
        const modalContainer = modalHeading.closest('.fixed.inset-0') as HTMLElement;
        expect(modalContainer).not.toBeNull();
        expect(modalContainer).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 2rem)' });

        // Verify inner modal dialog has overflowY and clearance
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 1.5rem)' });

        // Press Escape key to close dialog
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('heading', { name: 'Propose an Enterprise / Project' })).not.toBeInTheDocument();
    });

    it('positions pledge form with widened amount input and handles pledge submission in TreasuryDetailPage', async () => {
        render(<TreasuryDetailPage identity={backerIdentity} pubkey="treasury-1" onBack={vi.fn()} />);

        await waitFor(() => {
            expect(screen.getByText('Back this initiative')).toBeInTheDocument();
        });

        // Find pledge button
        const pledgeButton = screen.getByRole('button', { name: /Pledge Beans/i });
        expect(pledgeButton).toBeInTheDocument();

        // Verify Amount input is wide enough for placeholder and 4-digit value (#790)
        const amountInput = screen.getByPlaceholderText('Amount (🫘)');
        expect(amountInput).toBeInTheDocument();
        expect(amountInput.className).toContain('w-32');
        expect(amountInput.className).toContain('min-w-[7.5rem]');
        expect(screen.getByPlaceholderText('Memo (optional)')).toBeInTheDocument();

        // Verify content container has dynamic bottom nav offset clearance (#793)
        const contentContainer = pledgeButton.closest('.max-w-2xl');
        expect(contentContainer).not.toBeNull();
        expect(contentContainer).toHaveStyle({ paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)' });
    });

    it('renders keeper operational controls for enterprise keeper and preserves treasury actions', async () => {
        render(<TreasuryDetailPage identity={creatorIdentity} pubkey="treasury-mine" onBack={vi.fn()} />);

        await waitFor(() => {
            expect(screen.getByText('Operator Controls')).toBeInTheDocument();
        });

        // Keeper sees action buttons (Post Offer, Post Need, To Commons)
        expect(screen.getByRole('button', { name: /Post Offer/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Post Need/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /To Commons/i })).toBeInTheDocument();
    });

    it('renders cancel initiative button for keeper of bounded unfunded project and triggers deletion', async () => {
        const handleBack = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(window, 'alert').mockImplementation(() => {});

        render(<TreasuryDetailPage identity={creatorIdentity} pubkey="treasury-mine" onBack={handleBack} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Cancel Initiative & Refund Escrow/i })).toBeInTheDocument();
        });

        const cancelBtn = screen.getByRole('button', { name: /Cancel Initiative & Refund Escrow/i });
        fireEvent.click(cancelBtn);

        await waitFor(() => {
            expect(handleBack).toHaveBeenCalled();
        });
    });

    it('renders live offer count and badge parity on enterprise cards in ProjectsPage', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Project badge
        expect(screen.getAllByText('🌱 Project').length).toBeGreaterThan(0);

        // Live offers count
        expect(screen.getByText(/1 live offer/i)).toBeInTheDocument();
    });
});

describe('ProjectsPage small screens (320x640 at 1.3x text)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('pins only the section tabs; the title, pool cards and filter chips scroll away with the list', async () => {
        const { container } = render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        const stickies = Array.from(container.querySelectorAll('.sticky'));
        expect(stickies).toHaveLength(1);
        const tabs = stickies[0] as HTMLElement;
        expect(tabs).toHaveAttribute('data-testid', 'commons-section-tabs');
        expect(within(tabs).getByText('Decide')).toBeInTheDocument();
        expect(within(tabs).getByText('Enterprises')).toBeInTheDocument();
        expect(within(tabs).getByText('Groups')).toBeInTheDocument();

        for (const text of ['The Commons', 'Commons Pool', 'Voice credits for money votes', 'All Enterprises', 'Bounded Projects']) {
            expect(screen.getByText(text).closest('.sticky')).toBeNull();
        }
    });

    it('the voice-credits card shows the number the node checks for money votes, not earned credit', async () => {
        render(<ProjectsPage identity={backerIdentity} />);
        const card = await screen.findByTestId('voice-credits-card');
        // qualifiedTradeValue 9.6 from the Decisions list, floored; earnedCredit (12) is a different number.
        await waitFor(() => expect(within(card).getByText('9')).toBeInTheDocument());
        expect(within(card).queryByText('12')).toBeNull();
        expect(within(card).getByText('From completed trades · N votes cost N×N')).toBeInTheDocument();
    });

    it('gates Propose on the node\'s rule: a node admin with no earned credit may propose', async () => {
        vi.mocked(getBalance).mockResolvedValueOnce({ ...mockBalance, earnedCredit: 0 });
        vi.mocked(getDecisions).mockResolvedValueOnce({ decisions: [], myPoolVoting: null, canPropose: true });
        render(<ProjectsPage identity={backerIdentity} initialSection="decide" />);
        await waitFor(() => expect(getDecisions).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByText(/Open to members with a completed trade or earned standing, and to node admins\./)).toBeInTheDocument());
        expect(screen.queryByText(/You can propose once you have completed a trade\./)).toBeNull();
    });

    it('and a member the node says may not propose is told so, whatever their earned credit', async () => {
        vi.mocked(getDecisions).mockResolvedValueOnce({ decisions: [], myPoolVoting: null, canPropose: false });
        render(<ProjectsPage identity={backerIdentity} initialSection="decide" />);
        await waitFor(() => expect(screen.getByText(/You can propose once you have completed a trade\./)).toBeInTheDocument());
    });

    it('fits the section tabs in a 320px row and never lets the page scroll sideways', async () => {
        const { container } = render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // The page scroller clips sideways overflow instead of dragging the whole page.
        expect(container.firstElementChild as HTMLElement).toHaveStyle({ overflowX: 'hidden' });

        // Below `sm` each tab stacks its emoji over its label and may shrink, so all three fit.
        const tabs = within(screen.getByTestId('commons-section-tabs')).getAllByRole('button');
        expect(tabs).toHaveLength(3);
        for (const tab of tabs) {
            expect(tab).toHaveClass('flex-1', 'min-w-0', 'flex-col', 'sm:flex-row', 'px-1');
            expect(tab.className).not.toMatch(/(^|\s)px-3(\s|$)/);
        }
    });

    it('lets the enterprise chips scroll on their own row without a visible scrollbar', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        const row = screen.getByTestId('enterprise-filter-chips');
        expect(row).toHaveClass('overflow-x-auto', 'scrollbar-none');
        for (const chip of within(row).getAllByRole('button')) {
            expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap');
        }
    });

    it('lets the group chips scroll on their own row without a visible scrollbar', async () => {
        render(<ProjectsPage identity={backerIdentity} initialSection="groups" />);

        const row = await screen.findByTestId('group-filter-chips');
        expect(row).toHaveClass('min-w-0', 'overflow-x-auto', 'scrollbar-none');
    });

    it('defines the scrollbar-none utility the chip rows rely on', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf-8');
        expect(css).toMatch(/\.scrollbar-none[\s\S]*?scrollbar-width:\s*none/);
        expect(css).toMatch(/\.scrollbar-none::-webkit-scrollbar[\s\S]*?display:\s*none/);
    });
});

describe('ProjectsPage enterprise card avatar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('falls back to the no-avatar placeholder when the avatar image fails to load', async () => {
        vi.mocked(getTreasuries).mockResolvedValueOnce({
            treasuries: [{ ...mockTreasuries[0], avatar: '/uploads/avatars/missing.png' }],
        } as any);
        render(<ProjectsPage identity={backerIdentity} />);

        const img = await screen.findByRole('img', { name: 'Community Garden Solar Irrigation' });
        const box = img.parentElement as HTMLElement;
        fireEvent.error(img);

        await waitFor(() => {
            expect(screen.queryByRole('img', { name: 'Community Garden Solar Irrigation' })).not.toBeInTheDocument();
        });
        // The same placeholder a card without an avatar shows — not the alt text spilling out.
        expect(box).toHaveTextContent('🌱');
    });
});

describe('ProjectsPage: the viewer balance is a member-only request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('never asks for the balance of a guest', async () => {
        render(<ProjectsPage identity={backerIdentity} isMember={false} />);
        await waitFor(() => expect(getTreasuries).toHaveBeenCalled());
        await screen.findByText('Community Garden Solar Irrigation');
        expect(getBalance).not.toHaveBeenCalled();
    });

    it('waits while membership is unknown, then asks once for a member', async () => {
        const view = render(<ProjectsPage identity={backerIdentity} isMember={null} />);
        await screen.findByText('Community Garden Solar Irrigation');
        expect(getBalance).not.toHaveBeenCalled();

        view.rerender(<ProjectsPage identity={backerIdentity} isMember={true} />);
        await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1));
        expect(getBalance).toHaveBeenCalledWith(backerIdentity.publicKey);
    });

    it('asks once, not twice, for a member on mount', async () => {
        render(<ProjectsPage identity={backerIdentity} />);
        await screen.findByText('Community Garden Solar Irrigation');
        await waitFor(() => expect(getBalance).toHaveBeenCalled());
        expect(getBalance).toHaveBeenCalledTimes(1);
    });
});

describe('ProjectsPage: an enterprise photo goes through the canvas resize, never as the raw file (G9a-3)', () => {
    // jsdom decodes no pictures and draws on no canvas: these stand in for both and record what was asked of them.
    let restore: Array<() => void> = [];
    afterEach(() => {
        restore.forEach((r) => r());
        restore = [];
    });

    it('a 4032x3024 camera photo is sent as an 800px re-encoded JPEG, and the raw file is not', async () => {
        vi.clearAllMocks();
        const originalImage = window.Image;
        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            width = 4032;
            height = 3024;
            set src(_value: string) { setTimeout(() => this.onload?.(), 0); }
        }
        (window as any).Image = FakeImage;
        restore.push(() => { (window as any).Image = originalImage; });
        const drawn: Array<{ width: number; height: number }> = [];
        const originalGetContext = window.HTMLCanvasElement.prototype.getContext;
        const originalToDataUrl = window.HTMLCanvasElement.prototype.toDataURL;
        (window.HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement) {
            const canvas = this;
            return { drawImage: () => drawn.push({ width: canvas.width, height: canvas.height }) };
        };
        const toDataURL = vi.fn(() => 'data:image/jpeg;base64,UkVTSVpFRA==');
        (window.HTMLCanvasElement.prototype as any).toDataURL = toDataURL;
        restore.push(() => {
            (window.HTMLCanvasElement.prototype as any).getContext = originalGetContext;
            (window.HTMLCanvasElement.prototype as any).toDataURL = originalToDataUrl;
        });

        render(<ProjectsPage identity={backerIdentity} />);
        await screen.findByText('Community Garden Solar Irrigation');
        fireEvent.click(screen.getByRole('button', { name: /\+ Propose/i }));
        const dialog = screen.getByRole('dialog');

        fireEvent.click(within(dialog).getByRole('button', { name: /Ongoing Enterprise/i }));
        fireEvent.change(within(dialog).getByPlaceholderText(/Community Tool Shed/i), { target: { value: 'Shade House' } });
        fireEvent.change(within(dialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'We build a shade house' } });

        // A camera original: SOI then an APP1 Exif segment, which is where a phone puts its GPS.
        const raw = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])], 'IMG_0001.jpg', { type: 'image/jpeg' });
        const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(picker, { target: { files: [raw] } });

        const preview = await within(dialog).findByAltText('Preview');
        expect(preview).toHaveAttribute('src', 'data:image/jpeg;base64,UkVTSVpFRA==');
        expect(drawn).toEqual([{ width: 800, height: 600 }]);
        expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.7);

        fireEvent.click(within(dialog).getByRole('button', { name: /Propose Enterprise/i }));
        await waitFor(() => expect(createEnterprise).toHaveBeenCalledTimes(1));
        const sent = vi.mocked(createEnterprise).mock.calls[0][0];
        expect(sent.avatar).toBe('data:image/jpeg;base64,UkVTSVpFRA==');
        expect(sent.photos).toEqual(['data:image/jpeg;base64,UkVTSVpFRA==']);
        // The raw file's own data URL (its Exif segment in base64) is nowhere in what went to the node.
        expect(JSON.stringify(sent)).not.toContain('/9j/4QAIRXhpZg');
    });
});
