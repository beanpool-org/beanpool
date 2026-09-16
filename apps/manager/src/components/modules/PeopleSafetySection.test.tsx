import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeopleSafetySection } from './PeopleSafetySection';
import type { NodeProfile } from '../../lib/profiles';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-password',
};

const realServerReports: any[] = [
    {
        id: 'rep_1',
        reporter_pubkey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        target_pubkey: '02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        target_post_id: null,
        reason: 'Suspected spam activity',
        created_at: '2026-09-10T00:00:00Z',
        status: 'pending',
        reporter_callsign: 'alice',
        target_callsign: 'bob',
    },
];

const mockMembers: any[] = [
    {
        publicKey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        callsign: 'alice',
        tier: 'Elder',
        standing: 'Elder',
        canVouch: true,
        nodeRole: 'owner',
    },
    {
        publicKey: '02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        callsign: 'bob',
        tier: 'Resident',
        standing: 'Resident',
        canVouch: false,
        nodeRole: null,
    },
];

describe('PeopleSafetySection Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders real server reports with snake_case target_pubkey without crashing', async () => {
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{
                        reports: realServerReports,
                        members: mockMembers,
                    }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        // Switch to reports tab
        const reportsTab = screen.getByRole('button', { name: /triage & moderation/i });
        await act(async () => {
            fireEvent.click(reportsTab);
        });

        expect(screen.getByText(/Community Report Triage/i)).toBeInTheDocument();
        expect(screen.getByText('Suspected spam activity')).toBeInTheDocument();
        // Target pubkey slice should render without throwing
        expect(screen.getByText(/02abcdef1234/i)).toBeInTheDocument();
    });

    it('renders safely with empty or missing nodeData', async () => {
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{}}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        expect(screen.getByText('People & Safety')).toBeInTheDocument();
        expect(screen.getByText(/No registered members/i)).toBeInTheDocument();
    });

    it('guards against wrong-typed targetPubkey (numbers, objects, nulls)', async () => {
        const malformedReports: any[] = [
            {
                id: 'mal_1',
                targetPubkey: { nested: 'not-a-string' },
                reporterPubkey: 12345,
                reason: 'Malformed report 1',
                status: 'pending',
            },
            {
                id: 'mal_2',
                target_pubkey: null,
                reporter_pubkey: undefined,
                reason: 'Malformed report 2',
                status: 'pending',
            },
        ];

        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{
                        reports: malformedReports,
                        members: [],
                    }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        const reportsTab = screen.getByRole('button', { name: /triage & moderation/i });
        await act(async () => {
            fireEvent.click(reportsTab);
        });

        expect(screen.getByText('Malformed report 1')).toBeInTheDocument();
        expect(screen.getByText('Malformed report 2')).toBeInTheDocument();
    });
});
