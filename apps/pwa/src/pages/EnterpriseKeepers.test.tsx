import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';

describe('Enterprise Keepers & Succession (Slice 6)', () => {
    const mockLeadIdentity = {
        publicKey: 'lead-alice-pubkey',
        callsign: 'Alice',
        tier: 'Elder',
    } as any;

    const mockApplicantIdentity = {
        publicKey: 'applicant-charlie-pubkey',
        callsign: 'Charlie',
        tier: 'Resident',
    } as any;

    const mockKeeperIdentity = {
        publicKey: 'keeper-bob-pubkey',
        callsign: 'Bob',
        tier: 'Resident',
    } as any;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: [],
        } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            enterprise: {
                publicKey: 'enterprise-eggs-pubkey',
                name: 'Community Eggs',
                status: 'active',
                paused: false,
                balance: 100,
            },
            period: { since: null, until: null },
            summary: {
                totalIncome: 0,
                totalSpend: 0,
                netChange: 0,
                startingBalance: 100,
                endingBalance: 100,
                transactionCount: 0,
            },
            entries: [],
        } as any);
    });

    it('displays Lead keeper badge vs Keeper badge in Accountable Keepers card', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0 },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Lead keeper')).toBeInTheDocument();
        expect(screen.getByText('Keeper')).toBeInTheDocument();
        expect(screen.getByText('+50 🫘')).toBeInTheDocument();
        // Vocabulary check: never owner, never steward
        expect(screen.queryByText(/owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/steward/i)).not.toBeInTheDocument();
    });

    it('shows a suspended keeper labelled as suspended instead of hiding them (PR #838 B1)', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50, suspended: true },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 0, suspended: false },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Accountable Keepers \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getAllByText('Suspended')).toHaveLength(1);
    });

    it('renders single control "Back this enterprise with your standing: 0 … <available>" and submits join request', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            availableToBack: 80,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        const requestSpy = vi.spyOn(api, 'requestToJoinEnterprise').mockResolvedValue({
            success: true,
            request: {
                id: 'req-1',
                enterprisePubkey: 'enterprise-eggs-pubkey',
                memberPubkey: 'applicant-charlie-pubkey',
                pledgedBacking: 30,
                status: 'pending',
                createdAt: new Date().toISOString(),
            },
        });

        render(
            <TreasuryDetailPage
                identity={mockApplicantIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText('Ask to Join as a Keeper')).toBeInTheDocument();
        expect(screen.getByText(/Back this enterprise with your standing: 0 … 80/i)).toBeInTheDocument();

        // Change backing pledge to 30
        const input = screen.getByLabelText(/Back this enterprise with your standing: 0 … 80/i);
        fireEvent.change(input, { target: { value: '30' } });

        const submitBtn = screen.getByRole('button', { name: /request to join as keeper/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(requestSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 30);
        });
    });

    it('renders pending keeper requests panel for lead keeper and handles approve and decline', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            isLeadOrSoleKeeperOrAdmin: true,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
            ],
            keeperRequests: [
                {
                    id: 'req-charlie',
                    enterprisePubkey: 'enterprise-eggs-pubkey',
                    memberPubkey: 'applicant-charlie-pubkey',
                    callsign: 'Charlie',
                    pledgedBacking: 25,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                },
            ],
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 100,
            keeperOf: ['enterprise-eggs-pubkey'],
        } as any);

        const approveSpy = vi.spyOn(api, 'approveKeeperRequest').mockResolvedValue({
            success: true,
            backing: 25,
        });
        const declineSpy = vi.spyOn(api, 'declineKeeperRequest').mockResolvedValue({
            success: true,
        });

        const { rerender } = render(
            <TreasuryDetailPage
                identity={mockLeadIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Pending Keeper Requests \(1\)/i)).toBeInTheDocument();
        expect(screen.getByText('Charlie')).toBeInTheDocument();
        expect(screen.getByText('25 🫘')).toBeInTheDocument();

        // Click approve
        const approveBtn = screen.getByRole('button', { name: /approve/i });
        fireEvent.click(approveBtn);

        await waitFor(() => {
            expect(approveSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'req-charlie');
        });

        // Test decline
        rerender(
            <TreasuryDetailPage
                identity={mockLeadIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );
        const declineBtn = screen.getByRole('button', { name: /decline/i });
        fireEvent.click(declineBtn);

        await waitFor(() => {
            expect(declineSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'req-charlie');
        });
    });

    it('renders lead succession section when lead is inactive >= 30 days and allows keeper to propose or vote', async () => {
        const mockTreasury = {
            publicKey: 'enterprise-eggs-pubkey',
            name: 'Community Eggs',
            status: 'active',
            paused: false,
            balance: 100,
            keepers: [
                { publicKey: 'lead-alice-pubkey', callsign: 'Alice', role: 'lead', backing: 50 },
                { publicKey: 'keeper-bob-pubkey', callsign: 'Bob', role: 'keeper', backing: 20 },
                { publicKey: 'keeper-charlie-pubkey', callsign: 'Charlie', role: 'keeper', backing: 10 },
            ],
            leadInactivity: {
                leadPubkey: 'lead-alice-pubkey',
                leadCallsign: 'Alice',
                daysInactive: 32,
                isEligible: true,
                isEligibleForSuccession: true,
            },
            succession: {
                inactivity: {
                    leadPubkey: 'lead-alice-pubkey',
                    leadCallsign: 'Alice',
                    daysInactive: 32,
                    isEligible: true,
                    isEligibleForSuccession: true,
                },
                proposals: [],
            },
            posts: [],
            flow: [],
        };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: ['enterprise-eggs-pubkey'],
        } as any);

        const proposeSpy = vi.spyOn(api, 'proposeEnterpriseSuccession').mockResolvedValue({
            success: true,
            executed: false,
            proposal: {
                id: 'prop-1',
                enterprisePubkey: 'enterprise-eggs-pubkey',
                leadPubkey: 'lead-alice-pubkey',
                candidatePubkey: 'keeper-bob-pubkey',
                candidateCallsign: 'Bob',
                votesCount: 1,
                votesRequired: 2,
                status: 'active',
            } as any,
            status: 'active',
            votesCount: 1,
            votesRequired: 2,
            leadMoved: false,
        });

        render(
            <TreasuryDetailPage
                identity={mockKeeperIdentity}
                pubkey="enterprise-eggs-pubkey"
                onBack={vi.fn()}
            />
        );

        expect(await screen.findByText(/Lead Keeper Inactive \(32 days\)/i)).toBeInTheDocument();
        expect(screen.getByText('Propose an Active Keeper as Lead')).toBeInTheDocument();

        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'keeper-bob-pubkey' } });

        const proposeBtn = screen.getByRole('button', { name: /propose lead/i });
        fireEvent.click(proposeBtn);

        await waitFor(() => {
            expect(proposeSpy).toHaveBeenCalledWith('enterprise-eggs-pubkey', 'keeper-bob-pubkey');
        });
    });
});
