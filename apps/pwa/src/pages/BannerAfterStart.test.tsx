import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import * as pictureCrop from '../lib/picture-crop';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../components/EnterpriseDecisions', () => ({
    EnterpriseDecisions: () => null,
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(async () => true),
}));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 5,
        postCount: 0,
        transactionCount: 0,
        commonsBalance: 100,
        profile: 'local',
        features: { beans: true, enterprises: true, decisions: true },
    })),
}));

const KEEPER_ID: BeanPoolIdentity = {
    publicKey: 'keeper-alice',
    privateKey: 'mock-key',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00Z',
};

const STRANGER_ID: BeanPoolIdentity = {
    publicKey: 'stranger-bob',
    privateKey: 'mock-key-2',
    callsign: 'Bob',
    createdAt: '2026-01-01T00:00:00Z',
};

const ENT_KEY = 'treasury-eggs-1';

function sampleEnterprise(over: Record<string, any> = {}) {
    return {
        publicKey: ENT_KEY,
        name: 'Community Eggs',
        purpose: 'Fresh eggs from local hens.',
        status: 'active',
        paused: false,
        lifecycle: 'ongoing',
        balance: 50,
        creditLine: 100,
        liveOffers: 1,
        keepers: [{ publicKey: KEEPER_ID.publicKey, callsign: 'Alice', role: 'lead' }],
        shop: {
            id: 'shop-eggs',
            name: 'Community Eggs',
            ownerPublicKey: ENT_KEY,
            photoUrl: null,
            category: 'food',
        },
        posts: [],
        flow: [],
        pendingBids: [],
        activeDeals: [],
        ...over,
    };
}

describe('banner-after-start (PWA)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, keeperOf: [ENT_KEY] } as any);
        vi.spyOn(api, 'getCommonsBalance').mockResolvedValue({ balance: 500 });
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getYourGroups').mockResolvedValue({ items: [] } as any);
        vi.spyOn(api, 'getDecisions').mockResolvedValue({ decisions: [] } as any);
        vi.spyOn(api, 'getCommunityMe').mockResolvedValue({ tier: 'member', features: null } as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, messages: [], readOnly: false } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(null as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('1. start an enterprise → lands on its page via onOpenTreasury', async () => {
        const onOpenTreasury = vi.fn();
        vi.spyOn(api, 'createEnterprise').mockResolvedValue({
            success: true,
            publicKey: 'new-ent-pwa-99',
            name: 'Mullum Honey',
            purpose: 'Local raw honey',
            lifecycle: 'ongoing',
        } as any);

        render(<ProjectsPage identity={KEEPER_ID} onOpenTreasury={onOpenTreasury} isMember={true} />);
        await waitFor(() => expect(api.getTreasuries).toHaveBeenCalled());

        // Open "Start something" dialog
        const startBtn = screen.getByRole('button', { name: /Start something/i });
        fireEvent.click(startBtn);

        const startDialog = screen.getByRole('dialog', { name: /Start something/i });
        const enterpriseOption = within(startDialog).getByRole('button', { name: /Enterprise/i });
        fireEvent.click(enterpriseOption);

        // Propose modal opens
        const proposeDialog = screen.getByRole('dialog', { name: /Start an enterprise/i });
        const nameInput = within(proposeDialog).getByPlaceholderText(/Community Tool Shed/i);
        const purposeInput = within(proposeDialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i);

        fireEvent.change(nameInput, { target: { value: 'Mullum Honey' } });
        fireEvent.change(purposeInput, { target: { value: 'Local raw honey' } });
        // A logo first (Pictures S4): until one is chosen Start says so and is off.
        expect(within(proposeDialog).getByRole('button', { name: 'Choose a logo' })).toBeDisabled();
        fireEvent.click(within(proposeDialog).getByRole('button', { name: 'Select Leaf avatar' }));

        const submitBtn = within(proposeDialog).getByRole('button', { name: /Start the enterprise/i });
        fireEvent.click(submitBtn);

        await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledWith(expect.objectContaining({
            lifecycle: 'ongoing',
            name: 'Mullum Honey',
            purpose: 'Local raw honey',
            avatar: 'bundled://leaf',
        })));

        // Expect to land on the new enterprise's page
        await waitFor(() => expect(onOpenTreasury).toHaveBeenCalledWith('new-ent-pwa-99'));
    });

    it('7. starting a project still lands where it did (stays on page, onOpenTreasury not called)', async () => {
        const onOpenTreasury = vi.fn();
        vi.spyOn(api, 'createEnterprise').mockResolvedValue({
            success: true,
            publicKey: 'new-proj-pwa-88',
            name: 'Solar Co-op',
            purpose: 'Solar panels',
            lifecycle: 'bounded',
        } as any);

        render(<ProjectsPage identity={KEEPER_ID} onOpenTreasury={onOpenTreasury} isMember={true} />);
        await waitFor(() => expect(api.getTreasuries).toHaveBeenCalled());

        const startBtn = screen.getByRole('button', { name: /Start something/i });
        fireEvent.click(startBtn);

        const startDialog = screen.getByRole('dialog', { name: /Start something/i });
        const projectOption = within(startDialog).getByRole('button', { name: /Project/i });
        fireEvent.click(projectOption);

        const proposeDialog = screen.getByRole('dialog', { name: /Start a project/i });
        const nameInput = within(proposeDialog).getByPlaceholderText(/Community Tool Shed/i);
        const purposeInput = within(proposeDialog).getByPlaceholderText(/State clearly what this enterprise exists to do/i);
        const goalInput = within(proposeDialog).getByPlaceholderText(/500/i);

        fireEvent.change(nameInput, { target: { value: 'Solar Co-op' } });
        fireEvent.change(purposeInput, { target: { value: 'Solar panels' } });
        fireEvent.change(goalInput, { target: { value: '250' } });
        expect(within(proposeDialog).getByRole('button', { name: 'Choose a logo' })).toBeDisabled();
        fireEvent.click(within(proposeDialog).getByRole('button', { name: 'Select Leaf avatar' }));

        const submitBtn = within(proposeDialog).getByRole('button', { name: /Start the project/i });
        fireEvent.click(submitBtn);

        await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledWith(expect.objectContaining({
            lifecycle: 'bounded',
            name: 'Solar Co-op',
            avatar: 'bundled://leaf',
        })));

        // Modal closed
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /Start a project/i })).toBeNull());
        // onOpenTreasury not called for project
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });

    it('2. a keeper sees the button with no banner', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(sampleEnterprise({ shop: { photoUrl: null } }) as any);

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(screen.getByText('Add a banner photo')).toBeInTheDocument());
        expect(screen.getByText('Not now')).toBeInTheDocument();
    });

    it('3. not with a banner', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(sampleEnterprise({
            shop: { photoUrl: 'https://mullum.example/banner.jpg' },
        }) as any);

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(api.getTreasury).toHaveBeenCalled());
        expect(screen.queryByText('Add a banner photo')).toBeNull();
    });

    it('4. not as a non-keeper', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(sampleEnterprise({ shop: { photoUrl: null } }) as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [] } as any);

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={STRANGER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(api.getTreasury).toHaveBeenCalled());
        expect(screen.queryByText('Add a banner photo')).toBeNull();
    });

    it('5. the button opens the crop step and saving sets the banner', async () => {
        vi.spyOn(pictureCrop, 'drawPictureCrop').mockReturnValue('data:image/jpeg;base64,PWA_CROPPED_BANNER');
        vi.spyOn(pictureCrop, 'readPictureFile').mockResolvedValue({
            src: 'data:image/jpeg;base64,UkFX',
            width: 1600,
            height: 1200,
            image: {} as HTMLImageElement,
        });

        let entData = sampleEnterprise({ shop: { photoUrl: null } });
        vi.spyOn(api, 'getTreasury').mockImplementation(async () => entData as any);
        const changeShopSpy = vi.spyOn(api, 'changeEnterpriseShop').mockImplementation(async (_key, changes: any) => {
            if (changes.photo) {
                entData = { ...entData, shop: { ...entData.shop, photoUrl: changes.photo } };
            }
            return {
                success: true,
                shop: { photoUrl: changes.photo },
            } as any;
        });

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(screen.getByText('Add a banner photo')).toBeInTheDocument());

        // Locate file input for the banner prompt
        const fileInput = document.querySelector('input[type="file"][data-testid="add-banner-input"]') as HTMLInputElement
            || screen.getByLabelText(/Add a banner photo/i) as HTMLInputElement;
        expect(fileInput).toBeInTheDocument();

        // Simulate picking a file
        const file = new File(['mock-image-data'], 'banner.jpg', { type: 'image/jpeg' });
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } });
        });

        // The crop dialog opens
        const cropDialog = await screen.findByRole('dialog', { name: /Choose the part (that shows|to show)/i });
        expect(cropDialog).toBeInTheDocument();

        // Complete crop
        const doneBtn = within(cropDialog).getByRole('button', { name: /Done/i });
        await act(async () => {
            fireEvent.click(doneBtn);
        });

        await waitFor(() => expect(changeShopSpy).toHaveBeenCalledWith(ENT_KEY, expect.objectContaining({
            photo: expect.any(String),
        })));

        // Button goes
        await waitFor(() => expect(screen.queryByText('Add a banner photo')).toBeNull());
    });

    it('6. Not now hides it and stays hidden after a reload', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(sampleEnterprise({ shop: { photoUrl: null } }) as any);

        const { unmount } = render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(screen.getByText('Not now')).toBeInTheDocument());

        const notNowBtn = screen.getByText('Not now');
        fireEvent.click(notNowBtn);

        // Hidden immediately
        expect(screen.queryByText('Add a banner photo')).toBeNull();

        // Unmount and re-render to simulate reload
        unmount();

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(api.getTreasury).toHaveBeenCalled());
        expect(screen.queryByText('Add a banner photo')).toBeNull();
    });

    it('7. banner prompt not shown on completed or closed enterprise', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(sampleEnterprise({
            status: 'completed',
            shop: { photoUrl: null },
        }) as any);

        render(<TreasuryDetailPage pubkey={ENT_KEY} identity={KEEPER_ID} isMember={true} onBack={vi.fn()} />);

        await waitFor(() => expect(api.getTreasury).toHaveBeenCalled());
        expect(screen.queryByText('Add a banner photo')).toBeNull();
    });
});
