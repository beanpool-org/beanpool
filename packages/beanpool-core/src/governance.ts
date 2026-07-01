import { Passport } from './passport.js';
import { LedgerManager } from './ledger.js';

export type ProposalCategory = 'Infrastructure' | 'Emergency' | 'Art' | 'Community';

export interface Proposal {
    id: string;
    proposerId: string;
    title: string;
    cost: number;
    votesNeeded: number;
    currentVotes: number;
    category: ProposalCategory;
    status: 'Active' | 'Passed' | 'Failed';
    origin: 'SYSTEM' | 'STEWARD';
}

export class GovernanceManager {
    private proposals: Map<string, Proposal>;
    private ledgerManager: LedgerManager;
    // Track who voted for which proposal to prevent double voting
    // Map<proposalId, Set<voterId>>
    private votesLedger: Map<string, Set<string>>;

    constructor(ledgerManager: LedgerManager) {
        this.proposals = new Map();
        this.ledgerManager = ledgerManager;
        this.votesLedger = new Map();
    }

    /**
     * Creates a new proposal if the proposer has sufficient standing.
     */
    createProposal(
        proposerPassport: Passport,
        title: string,
        cost: number,
        votesNeeded: number,
        category: ProposalCategory,
        origin: 'SYSTEM' | 'STEWARD' = 'STEWARD'
    ): Proposal | null {
        // Constraint: Standing Score > 50 to create a proposal
        if (proposerPassport.standing <= 50) {
            console.error(`Proposal rejected: Proposer ${proposerPassport.id} has insufficient standing (${proposerPassport.standing} <= 50).`);
            return null;
        }

        const newProposal: Proposal = {
            id: `prop-${Date.now()}`,
            proposerId: proposerPassport.id,
            title,
            cost,
            votesNeeded,
            currentVotes: 0,
            category,
            status: 'Active',
            origin
        };

        this.proposals.set(newProposal.id, newProposal);
        this.votesLedger.set(newProposal.id, new Set());

        console.log(`Proposal created: ${title} [${newProposal.id}] by ${proposerPassport.id}`);
        return newProposal;
    }

    /**
     * Calculates the Quadratic Voting credit cost for a given number of votes.
     * QV Formula: Cost = N² (e.g., 3 votes costs 9 credits)
     */
    static calculateQVCost(voteCount: number): number {
        return voteCount * voteCount;
    }

    /**
     * Casts a quadratic vote. The cost of N votes is N² governance credits.
     * Credits are derived from the voter's energyCycled (total beans transacted).
     *
     * @param proposalId The proposal to vote on
     * @param voterPassport The voter's passport
     * @param voteCount Number of votes to allocate (1+)
     * @param availableCredits The voter's remaining governance credits
     * @returns Object with success flag and creditsUsed
     */
    castVote(
        proposalId: string,
        voterPassport: Passport,
        voteCount: number = 1,
        availableCredits: number = Infinity
    ): { success: boolean; creditsUsed: number; error?: string } {
        const proposal = this.proposals.get(proposalId);

        if (!proposal || proposal.status !== 'Active') {
            return { success: false, creditsUsed: 0, error: 'Proposal not found or inactive' };
        }

        if (voteCount < 1 || !Number.isInteger(voteCount)) {
            return { success: false, creditsUsed: 0, error: 'Vote count must be a positive integer' };
        }

        const voters = this.votesLedger.get(proposalId);
        if (voters?.has(voterPassport.id)) {
            return { success: false, creditsUsed: 0, error: 'Already voted on this proposal' };
        }

        // Quadratic Voting: Cost = N²
        const creditCost = GovernanceManager.calculateQVCost(voteCount);

        if (creditCost > availableCredits) {
            return {
                success: false,
                creditsUsed: 0,
                error: `Insufficient credits: ${voteCount} votes costs ${creditCost} credits, but you have ${availableCredits}`
            };
        }

        proposal.currentVotes += voteCount;
        voters?.add(voterPassport.id);

        console.log(`QV cast: ${voterPassport.id} allocated ${voteCount} votes (${creditCost} credits) to proposal ${proposalId}. New total: ${proposal.currentVotes}`);

        // Check if the proposal has passed after this vote
        this.finalizeProposal(proposalId);

        return { success: true, creditsUsed: creditCost };
    }

    /**
     * Checks if a proposal has met its vote threshold. If so, executes the escrow transfer.
     */
    finalizeProposal(proposalId: string): boolean {
        const proposal = this.proposals.get(proposalId);

        if (!proposal || proposal.status !== 'Active') {
            return false;
        }

        if (proposal.currentVotes >= proposal.votesNeeded) {
            proposal.status = 'Passed';

            const escrowAccount = `Escrow-${proposal.id}`;
            let success: boolean;

            if (proposal.origin === 'SYSTEM') {
                // SYSTEM proposals (Grand Bounties) draw directly from the Demurrage Commons pool
                success = this.ledgerManager.deductFromCommons(proposal.cost);
                if (success) {
                    const account = this.ledgerManager.getAccount(escrowAccount);
                    account.balance += proposal.cost;
                }
            } else {
                // STEWARD proposals draw from the proposer's own balance
                success = this.ledgerManager.transfer(proposal.proposerId, escrowAccount, proposal.cost);
            }

            if (success) {
                console.log(`Proposal Passed: ${proposal.title}. Escrow funded with ${proposal.cost}.`);
            } else {
                console.error(`Proposal Passed but Ledger Transfer Failed for ${proposal.title}. Insufficient funds?`);
            }
            return true;
        }

        return false;
    }

    /**
     * Deletes a proposal. Enforces the Grand Bounty Lock.
     */
    deleteProposal(proposalId: string, requesterId: string): boolean {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) return false;

        // Grand Bounty Lock
        if (proposal.origin === 'SYSTEM') {
            console.error(`Grand Bounty Lock: SYSTEM proposals cannot be deleted by ${requesterId}.`);
            return false;
        }

        if (proposal.proposerId !== requesterId) {
            console.error(`Delete failed: ${requesterId} is not the author of proposal ${proposalId}.`);
            return false;
        }

        this.proposals.delete(proposalId);
        this.votesLedger.delete(proposalId);
        console.log(`Proposal deleted: ${proposalId}`);
        return true;
    }

    /**
     * Retrieves all proposals.
     */
    getProposals(): Proposal[] {
        return Array.from(this.proposals.values());
    }
}
