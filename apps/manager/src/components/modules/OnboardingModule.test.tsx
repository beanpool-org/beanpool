import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingModule } from './OnboardingModule';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        fetchOnboardingFunnel: vi.fn(),
    };
});

describe('OnboardingModule', () => {
    const mockProfiles: NodeProfile[] = [
        {
            id: 'node-1',
            name: 'Node Alpha',
            url: 'https://alpha.beanpool.org',
            adminPassword: 'secretpassword1',
        },
        {
            id: 'node-2',
            name: 'Node Beta',
            url: 'https://beta.beanpool.org',
            adminPassword: 'secretpassword2',
        },
    ];

    const mockSelectNode = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders loading state initially and fetches onboarding funnel data', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockImplementation(
            () => new Promise(() => {}) // pending promise
        );

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                onSelectNode={mockSelectNode}
            />
        );

        expect(screen.getByRole('heading', { name: /Onboarding/i })).toBeInTheDocument();
        expect(screen.getByText(/How many people tried to join Node Alpha/i)).toBeInTheDocument();
        expect(screen.getByText('Reading the funnel…')).toBeInTheDocument();
        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'secretpassword1',
            30
        );
    });

    it('renders error state when funnel fetch fails', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockRejectedValue(
            new Error('Network error reaching node')
        );

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                onSelectNode={mockSelectNode}
            />
        );

        await waitFor(() => {
            expect(screen.getByText("Couldn't read this node")).toBeInTheDocument();
        });
        expect(screen.getByText('Network error reaching node')).toBeInTheDocument();
    });

    it('renders empty funnel notice when no tallied data exists', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                onSelectNode={mockSelectNode}
            />
        );

        await waitFor(() => {
            expect(
                screen.getByText(/Nothing has been tallied yet on this node/i)
            ).toBeInTheDocument();
        });
        expect(screen.getAllByText('not measured yet').length).toBeGreaterThan(0);
    });

    it('renders funnel steps, calculated conversion percentages, rejections, and protection choices', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-03-01', event: 'invite_attempt', variant: 'standard', count: 10 },
                { day: '2026-03-01', event: 'member_created', variant: 'standard', count: 8 },
                { day: '2026-03-01', event: 'avatar_published', variant: 'standard', count: 6 },
                { day: '2026-03-01', event: 'invite_failed', variant: 'invalid', count: 2 },
                { day: '2026-03-01', event: 'invite_failed', variant: 'expired', count: 1 },
                { day: '2026-03-01', event: 'invite_reentry', variant: 'standard', count: 1 },
                { day: '2026-03-01', event: 'protection_shown', variant: 'A', count: 5 },
            ],
        });

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                onSelectNode={mockSelectNode}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Entered an invite code')).toBeInTheDocument();
        });

        expect(screen.getAllByText('Joined').length).toBeGreaterThan(0);
        expect(screen.getByText('Added a photo')).toBeInTheDocument();

        // Rejections section
        expect(screen.getByText('Code not recognised')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
        expect(screen.getByText('Code had expired')).toBeInTheDocument();
        expect(screen.getAllByText('1').length).toBeGreaterThan(0);

        // Keeper protection states
        expect(screen.getByText('3 keepers — had a spare to offer')).toBeInTheDocument();
    });

    it('allows switching lookback window days and changing target node', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        render(
            <OnboardingModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                onSelectNode={mockSelectNode}
            />
        );

        await waitFor(() => {
            expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
                'https://alpha.beanpool.org',
                'secretpassword1',
                30
            );
        });

        const window7Btn = screen.getByRole('button', { name: '7 days' });
        await userEvent.click(window7Btn);

        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'secretpassword1',
            7
        );

        const nodeSelect = screen.getByRole('combobox', {
            name: "Choose which node's funnel to show",
        });
        await userEvent.selectOptions(nodeSelect, 'node-2');

        expect(mockSelectNode).toHaveBeenCalledWith('node-2');
    });
});
