import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import * as api from '../lib/api';

// Answers A, G and M (board, 2026-09-19) on the enterprise page: pending keeper changes with an Object button and
// countdown, the lead's Remove, anyone's Step down, and succession's Yes / No with its deadline.

const ENT = 'enterprise-eggs-pubkey';
const ALICE = { publicKey: 'lead-alice', callsign: 'Alice', tier: 'Elder' } as any;
const BOB = { publicKey: 'keeper-bob', callsign: 'Bob', tier: 'Resident' } as any;
const DAY = 24 * 60 * 60 * 1000;

function treasury(over: any = {}) {
    return {
        publicKey: ENT, name: 'Community Eggs', status: 'active', paused: false, balance: 100,
        keepers: [
            { publicKey: 'lead-alice', callsign: 'Alice', role: 'lead', backing: 0, grantedAt: '2026-01-01T00:00:00Z' },
            { publicKey: 'keeper-bob', callsign: 'Bob', role: 'keeper', backing: 0, grantedAt: '2026-02-01T00:00:00Z' },
            { publicKey: 'keeper-cara', callsign: 'Cara', role: 'keeper', backing: 0, grantedAt: '2026-03-01T00:00:00Z' },
        ],
        keeperChanges: [],
        posts: [], flow: [],
        ...over,
    };
}

const REMOVE_CARA = {
    id: 'chg-1', enterprisePubkey: ENT, kind: 'remove', memberPubkey: 'keeper-cara', memberCallsign: 'Cara',
    requestId: null, pledgedBacking: 0, proposedBy: 'lead-alice', proposedByCallsign: 'Alice', status: 'pending',
    createdAt: new Date().toISOString(), appliesAt: new Date(Date.now() + 2 * DAY + 60_000).toISOString(),
    resolvedAt: null, resolvedBy: null, resolvedByCallsign: null, reason: null,
};

describe('Enterprise keeper answers (A, G, M)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 50, keeperOf: [ENT] } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            enterprise: { publicKey: ENT, name: 'Community Eggs', status: 'active', paused: false, balance: 100 },
            period: { since: null, until: null },
            summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 100, endingBalance: 100, transactionCount: 0 },
            entries: [],
        } as any);
    });

    it('shows a pending removal with its countdown, and another keeper can object', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury({ keeperChanges: [REMOVE_CARA] }));
        const objectSpy = vi.spyOn(api, 'objectToKeeperChange').mockResolvedValue({ success: true, change: { ...REMOVE_CARA, status: 'objected' } } as any);
        render(<TreasuryDetailPage identity={BOB} pubkey={ENT} onBack={vi.fn()} />);

        expect(await screen.findByText('Removing Cara as a keeper')).toBeInTheDocument();
        expect(screen.getByText(/Objection window: 2 days left/)).toBeInTheDocument();
        const btn = screen.getByRole('button', { name: 'Object: Removing Cara as a keeper' });
        expect(btn.className).toContain('min-h-[48px]');
        fireEvent.click(btn);
        await waitFor(() => expect(objectSpy).toHaveBeenCalledWith(ENT, 'chg-1'));
    });

    it('the lead who made the change is not offered Object, and cannot re-remove the same keeper', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury({ keeperChanges: [REMOVE_CARA], isLeadOrSoleKeeperOrAdmin: true }));
        render(<TreasuryDetailPage identity={ALICE} pubkey={ENT} onBack={vi.fn()} />);
        expect(await screen.findByText('Removing Cara as a keeper')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Object/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Remove Bob' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove Cara' })).toBeNull();
    });

    it('the lead removes a keeper after confirming', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury({ isLeadOrSoleKeeperOrAdmin: true }));
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const removeSpy = vi.spyOn(api, 'removeEnterpriseKeeper').mockResolvedValue({ success: true, applied: false, change: null });
        render(<TreasuryDetailPage identity={ALICE} pubkey={ENT} onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }));
        await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(ENT, 'keeper-bob'));
        expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unless another keeper objects first'));
    });

    it('a keeper steps down; the server\'s refusal is shown as it says it', async () => {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury());
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const refusal = 'This enterprise is 30 beans in debt and your pledge is part of what covers it. You can step down once the debt is down to 10 beans, or once the other keepers pledge 20 beans more.';
        const stepSpy = vi.spyOn(api, 'stepDownAsKeeper').mockRejectedValue(new Error(refusal));
        render(<TreasuryDetailPage identity={BOB} pubkey={ENT} onBack={vi.fn()} />);
        const btn = await screen.findByRole('button', { name: 'Step down as keeper' });
        expect(btn.className).toContain('min-h-[48px]');
        fireEvent.click(btn);
        await waitFor(() => expect(stepSpy).toHaveBeenCalledWith(ENT));
        expect(await screen.findByText(refusal)).toBeInTheDocument();
    });

    it('succession offers Yes and No with its deadline, and sends the choice', async () => {
        const inactivity = { leadPubkey: 'lead-alice', leadCallsign: 'Alice', daysInactive: 40, isEligible: true, autoPromoted: false };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury({
            leadInactivity: inactivity,
            succession: {
                inactivity,
                proposals: [{
                    id: 'prop-1', enterprisePubkey: ENT, leadPubkey: 'lead-alice', candidatePubkey: 'keeper-cara', candidateCallsign: 'Cara',
                    status: 'active', votesCount: 1, noVotesCount: 0, requiredVotes: 2, totalEligible: 2,
                    deadlineAt: new Date(Date.now() + 13 * DAY + 60_000).toISOString(),
                    votes: [{ voterPubkey: 'keeper-cara', choice: 'yes' }],
                }],
            },
        }));
        const voteSpy = vi.spyOn(api, 'voteEnterpriseSuccession').mockResolvedValue({ success: true, executed: false } as any);
        render(<TreasuryDetailPage identity={BOB} pubkey={ENT} onBack={vi.fn()} />);

        expect(await screen.findByText('1 yes, 0 no. Needs 2 yes of 2 keepers.')).toBeInTheDocument();
        expect(screen.getByText(/Open for 14 days: 13 days left/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'No, do not make Cara lead keeper' }));
        await waitFor(() => expect(voteSpy).toHaveBeenCalledWith(ENT, 'prop-1', 'no'));
    });

    it('after an automatic promotion the card says so, without an inactivity count', async () => {
        const inactivity = { leadPubkey: 'lead-alice', leadCallsign: 'Alice', daysInactive: 0, isEligible: true, autoPromoted: true };
        vi.spyOn(api, 'getTreasury').mockResolvedValue(treasury({ leadInactivity: inactivity, succession: { inactivity, proposals: [] } }));
        render(<TreasuryDetailPage identity={BOB} pubkey={ENT} onBack={vi.fn()} />);
        expect(await screen.findByText('NEW LEAD CHOSEN AUTOMATICALLY')).toBeInTheDocument();
        expect(screen.getByText(/can choose someone else now/)).toBeInTheDocument();
    });
});
