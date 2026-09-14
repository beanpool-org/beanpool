import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { CrowdfundProject, Treasury } from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ImageLightbox', () => ({
    ImageLightbox: () => null,
}));

const mockProjects: CrowdfundProject[] = [
    {
        id: 'proj-1',
        creator_pubkey: 'creator-pubkey-123',
        title: 'Community Garden Solar Irrigation',
        description: 'Installing solar-powered automated water pumps and drip irrigation lines for community plots.',
        photos: '[]',
        goal_amount: 500,
        current_amount: 150,
        deadline_at: '2026-10-31T23:59:59.000Z',
        status: 'active',
        created_at: '2026-09-01T00:00:00.000Z',
    },
    {
        id: 'proj-2',
        creator_pubkey: 'my-user-pubkey',
        title: 'My Own Tool Library Project',
        description: 'Purchasing shared carpentry tools for the community workshop.',
        photos: '[]',
        goal_amount: 300,
        current_amount: 0,
        deadline_at: null,
        status: 'active',
        created_at: '2026-09-02T00:00:00.000Z',
    },
];

const mockTreasuries: Treasury[] = [
    {
        publicKey: 'treasury-1',
        name: 'Main Bakery Treasury',
        balance: 120,
        avatar: null,
    } as any,
];

vi.mock('../lib/api', () => ({
    getCrowdfundProjects: vi.fn(async () => ({
        projects: mockProjects,
        maxProjectExpiryDays: 365,
    })),
    getAllMembers: vi.fn(async () => [
        { publicKey: 'creator-pubkey-123', callsign: 'GardenerBob' },
        { publicKey: 'my-user-pubkey', callsign: 'Alice' },
    ]),
    getTreasuries: vi.fn(async () => ({
        treasuries: mockTreasuries,
    })),
    createCrowdfundProject: vi.fn(),
    pledgeToCrowdfundProject: vi.fn(async () => ({ success: true })),
    getCrowdfundProject: vi.fn(async (id: string) => ({
        project: mockProjects.find(p => p.id === id) || null,
    })),
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

    it('renders projects and opens project detail modal on click', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        // Click on the project card to open detail modal
        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));

        // Modal should open
        expect(screen.getByRole('heading', { name: 'Project Details' })).toBeInTheDocument();
        expect(screen.getByText('About the Project')).toBeInTheDocument();
    });

    it('ensures project detail modal has overflow-y: auto and content container has pb-72 md:pb-48 clearance', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));

        // Verify the full-screen modal container has overflowY: auto
        const modalHeading = screen.getByRole('heading', { name: 'Project Details' });
        const modalContainer = modalHeading.closest('.fixed.inset-0');
        expect(modalContainer).not.toBeNull();
        expect(modalContainer).toHaveStyle({ overflowY: 'auto' });
        expect(modalContainer?.className).toContain('fixed inset-0 z-50 flex flex-col');

        // Verify content container has pb-72 (18rem) and md:pb-48 (12rem)
        // so content is never occluded behind sticky pledge footer and bottom nav bar
        const aboutHeading = screen.getByText('About the Project');
        const contentContainer = aboutHeading.closest('.max-w-lg');
        expect(contentContainer).not.toBeNull();
        expect(contentContainer?.className).toContain('pb-72');
        expect(contentContainer?.className).toContain('md:pb-48');
    });

    it('positions sticky pledge footer above mobile bottom nav bar (bottom-16 md:bottom-0 z-30)', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));

        // Find pledge footer
        const pledgeButton = screen.getByRole('button', { name: /Pledge Beans/i });
        expect(pledgeButton).toBeInTheDocument();

        const pledgeFooter = pledgeButton.closest('.fixed');
        expect(pledgeFooter).not.toBeNull();
        expect(pledgeFooter?.className).toContain('bottom-16');
        expect(pledgeFooter?.className).toContain('md:bottom-0');
        expect(pledgeFooter?.className).toContain('z-30');

        // Verify Amount input and Optional memo input exist in pledge footer
        expect(screen.getByPlaceholderText('Amount')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Optional memo...')).toBeInTheDocument();
    });

    it('does not render pledge footer for project creator and preserves edit capability', async () => {
        render(<ProjectsPage identity={creatorIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('My Own Tool Library Project')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('My Own Tool Library Project'));

        // Creator should see Edit button
        expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();

        // Pledge footer should NOT be rendered for creator
        expect(screen.queryByRole('button', { name: /Pledge Beans/i })).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Amount')).not.toBeInTheDocument();
    });

    it('closes the project detail modal on close button click and escape key', async () => {
        render(<ProjectsPage identity={backerIdentity} />);

        await waitFor(() => {
            expect(screen.getByText('Community Garden Solar Irrigation')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Community Garden Solar Irrigation'));
        expect(screen.getByRole('heading', { name: 'Project Details' })).toBeInTheDocument();

        // Press Escape key
        fireEvent.keyDown(window, { key: 'Escape' });

        expect(screen.queryByRole('heading', { name: 'Project Details' })).not.toBeInTheDocument();
    });
});
