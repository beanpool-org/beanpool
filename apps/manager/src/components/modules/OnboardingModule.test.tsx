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

    const renderModule = () => render(
        <OnboardingModule
            profiles={mockProfiles}
            activeProfileId="node-1"
            onSelectNode={mockSelectNode}
        />
    );

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders loading state initially and fetches onboarding funnel data', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockImplementation(
            () => new Promise(() => {}) // pending promise
        );

        renderModule();

        expect(screen.getByRole('heading', { name: /Onboarding/i })).toBeInTheDocument();
        expect(screen.getByText(/How many people tried to join Node Alpha/i)).toBeInTheDocument();
        expect(screen.getByText('Reading the funnel…')).toBeInTheDocument();
        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'secretpassword1',
            30,
            undefined
        );
    });

    it('renders error state when funnel fetch fails', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockRejectedValue(
            new Error('Network error reaching node')
        );

        renderModule();

        await waitFor(() => {
            expect(screen.getByText("Couldn't read this node")).toBeInTheDocument();
        });
        expect(screen.getByText('Network error reaching node')).toBeInTheDocument();
    });

    it('renders empty state when profiles array is empty', () => {
        render(
            <OnboardingModule
                profiles={[]}
                activeProfileId=""
                onSelectNode={mockSelectNode}
            />
        );

        expect(screen.getByText('No Node Profiles Available')).toBeInTheDocument();
        expect(
            screen.getByText(/Configure or select a sovereign node profile in Fleet Settings/i)
        ).toBeInTheDocument();
    });

    it('says plainly when nobody joined and when no step has been counted per person', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({ days: 30, rows: [] });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText(/Nobody joined in this window/i)).toBeInTheDocument();
        });
        expect(screen.getByText(/Nothing counted once per person yet/i)).toBeInTheDocument();
    });

    /**
     * The cohort: one group of people, followed. "Joined" is the base and is 100%; the rows
     * under it are subsets of that same group, so their percentages are shares of it.
     */
    it('renders the cohort with Joined as 100% and the follow-ups as shares of it', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 8 },
                { day: '2026-09-01', event: 'cohort_photo', variant: '', count: 6 },
                { day: '2026-09-01', event: 'cohort_posted', variant: '', count: 2 },
                { day: '2026-09-02', event: 'member_created', variant: '', count: 2 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Joined')).toBeInTheDocument();
        });

        const row = (label: string) =>
            screen.getByText(label).closest('div.p-3') as HTMLElement;

        // 10 joined across the two days, and every rate below is a share of that.
        expect(row('Joined')).toHaveTextContent('10');
        expect(row('Joined')).toHaveTextContent('100%');
        expect(row('Has a photo')).toHaveTextContent('6');
        expect(row('Has a photo')).toHaveTextContent('60%');
        expect(row('Has posted')).toHaveTextContent('2');
        expect(row('Has posted')).toHaveTextContent('20%');

        // The screen says out loud that the in-app steps are not tied to these people.
        expect(screen.getByText(/cannot link these/i)).toBeInTheDocument();
    });

    /**
     * The in-app steps count only rows a client deduplicated per person. The old
     * one-per-showing rows are what produced "56 showings from 20 joins, shown as 350%";
     * they cannot be corrected after the fact, so they are named and left out.
     */
    it('adds up only the per-person in-app reports, and names the day they start from', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 20 },
                // Old, one-per-showing: 56 reports from 20 people. Ignored.
                { day: '2026-09-01', event: 'protection_shown', variant: 'C', count: 56 },
                { day: '2026-09-01', event: 'guide_complete', variant: '', count: 9 },
                // New, one per person.
                { day: '2026-09-10', event: 'protection_shown', variant: 'once', count: 7 },
                { day: '2026-09-11', event: 'protection_choice', variant: 'once:words', count: 3 },
                { day: '2026-09-11', event: 'protection_choice', variant: 'once:skip', count: 1 },
                { day: '2026-09-12', event: 'guide_complete', variant: 'once', count: 4 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Saw the protection screen')).toBeInTheDocument();
        });

        const row = (label: string) =>
            screen.getByText(label).closest('div.p-3') as HTMLElement;

        expect(row('Saw the protection screen')).toHaveTextContent('7');
        expect(row('Saw the protection screen')).not.toHaveTextContent('56');
        // Both sub-types of the same step add up into one figure for the step.
        expect(row('Chose how to be protected')).toHaveTextContent('4');
        expect(row('Finished the guide')).toHaveTextContent('4');

        // The earliest per-person day, not the earliest day in the window.
        expect(screen.getByText(/Counted once per person since/i)).toHaveTextContent('2026-09-10');
        // 56 + 9 older reports, named rather than silently dropped.
        expect(screen.getByText(/older reports are left out/i)).toHaveTextContent('65');
    });

    it('keeps codes as their own box, counted as attempts rather than people', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'invite_attempt', variant: '', count: 10 },
                { day: '2026-09-01', event: 'invite_reentry', variant: '', count: 1 },
                { day: '2026-09-01', event: 'invite_failed', variant: 'invalid', count: 2 },
                { day: '2026-09-01', event: 'invite_failed', variant: 'expired', count: 1 },
                { day: '2026-09-01', event: 'member_created', variant: '', count: 6 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Entered an invite code')).toBeInTheDocument();
        });

        expect(screen.getByText(/Attempts, not people/i)).toBeInTheDocument();
        expect(screen.getByText('Code not recognised')).toBeInTheDocument();
        expect(screen.getByText('Code had expired')).toBeInTheDocument();
        expect(screen.getByText(/already-a-member re-entry/i)).toBeInTheDocument();
    });

    /**
     * Both were stale: keeper recovery is gone, so nothing lands in the keepers panel and
     * nothing "arrives with Phase A" any more. Leaving either on screen tells an operator
     * something untrue about their own community.
     */
    it('no longer shows the keepers panel or the Phase A hints', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [
                { day: '2026-09-01', event: 'member_created', variant: '', count: 4 },
                { day: '2026-09-01', event: 'protection_shown', variant: 'A', count: 5 },
            ],
        });

        renderModule();

        await waitFor(() => {
            expect(screen.getByText('Joined')).toBeInTheDocument();
        });

        expect(screen.queryByText(/Keepers at signup/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/had a spare to offer/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/no longer grow/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Phase A/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/not measured yet/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Actually got started/i)).not.toBeInTheDocument();
    });

    it('allows switching lookback window days and changing target node', async () => {
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        renderModule();

        await waitFor(() => {
            expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
                'https://alpha.beanpool.org',
                'secretpassword1',
                30,
                undefined
            );
        });

        const window7Btn = screen.getByRole('button', { name: '7 days' });
        await userEvent.click(window7Btn);

        expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
            'https://alpha.beanpool.org',
            'secretpassword1',
            7,
            undefined
        );

        const nodeSelect = screen.getByRole('combobox', {
            name: "Choose which node's funnel to show",
        });
        await userEvent.selectOptions(nodeSelect, 'node-2');

        expect(mockSelectNode).toHaveBeenCalledWith('node-2');
    });

    it('forwards 2FA session token when available in sessionStorage', async () => {
        sessionStorage.setItem('bp_tfa_session_node-1', 'tfa-session-token-123');
        vi.mocked(nodeClient.fetchOnboardingFunnel).mockResolvedValue({
            days: 30,
            rows: [],
        });

        renderModule();

        await waitFor(() => {
            expect(nodeClient.fetchOnboardingFunnel).toHaveBeenCalledWith(
                'https://alpha.beanpool.org',
                'secretpassword1',
                30,
                'tfa-session-token-123'
            );
        });

        sessionStorage.removeItem('bp_tfa_session_node-1');
    });
});
