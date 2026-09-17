import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { DecideSection } from './DecideSection';

vi.mock('../lib/api', () => ({
    castDecisionVote: vi.fn(),
    getGovernanceCredits: vi.fn(async () => ({ totalCredits: 0, usedCredits: 0, availableCredits: 0 })),
}));

const renderDecide = (canPropose: boolean) => render(
    <DecideSection
        decisions={[]}
        activeMembers30d={0}
        identity={{ publicKey: 'viewer', privateKey: 'k', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' }}
        balanceInfo={null}
        commonsBalance={0}
        onRefresh={async () => {}}
        onOpenPropose={() => {}}
        canPropose={canPropose}
        hasOpenDecision={false}
        activeView="open"
        onChangeView={() => {}}
    />
);

describe('DecideSection wording', () => {
    it('says who can propose in plain words, without the developer term earnedCredit', () => {
        const { container } = renderDecide(false);

        expect(screen.getByText(/Open to anyone who has completed a trade\./)).toBeInTheDocument();
        expect(screen.getByText(/You can propose once you have completed a trade\./)).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/earnedCredit/);
    });
});
