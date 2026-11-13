import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThreatReviewModal, type ThreatItem, type MemberItem } from './ThreatReviewModal';

/**
 * "New accounts went deep into credit within two weeks" said "Members involved (0)" (Marty, 14 Nov 2026). The node now names
 * them (only owners and admins read flags), each with their allowance, the days after joining it got there and who gave it;
 * an owner's or admin's grant shows as not counted. Plain words: allowance, never "floor depth", and never spending.
 */

const ANN = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';
const BOB = 'bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900aa11';
const VIC = 'cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900aa11bb22';

const roster: MemberItem[] = [
    { publicKey: ANN, callsign: 'Ann' },
    { publicKey: BOB, callsign: 'Bob' },
    { publicKey: VIC, callsign: 'Vic' },
];

const flag: ThreatItem = {
    type: 'cohort_velocity',
    severity: 'warning',
    description: '2 new members reached a credit allowance of 600 Beans or more within 14 days of joining, not counting what an owner or admin gave. This is about how much credit they may use, not what they spent.',
    members: [ANN, BOB],
    allowances: [
        { member: ANN, allowance_c: 75000, counted_c: 65000, daysAfterJoining: 3, parts: [
            { kind: 'vouch', from: VIC, amount_c: 60000, counted: true },
            { kind: 'earned', from: null, amount_c: 5000, counted: true },
            { kind: 'granted', from: null, amount_c: 10000, counted: false },
        ] },
        { member: BOB, allowance_c: 60000, counted_c: 60000, daysAfterJoining: 5, parts: [{ kind: 'gift', from: ANN, amount_c: 60000, counted: true }] },
    ],
};

describe('ThreatReviewModal: new members\' allowance flag', () => {
    it('names the members, each with allowance, days after joining and who gave it', () => {
        render(<ThreatReviewModal threat={flag} members={roster} onClose={vi.fn()} />);
        expect(screen.getByText('Members involved (2)')).toBeInTheDocument();
        expect(screen.getByText('Allowance 750 Beans, reached 3 days after joining')).toBeInTheDocument();
        expect(screen.getByText('Allowance 600 Beans, reached 5 days after joining')).toBeInTheDocument();
        expect(screen.getByText('Vouched by Vic: 600 Beans')).toBeInTheDocument();
        expect(screen.getByText('Trades: 50 Beans')).toBeInTheDocument();
        expect(screen.getByText('Granted by an owner or admin: 100 Beans (not counted)')).toBeInTheDocument();
        expect(screen.getByText('A gift from Ann: 600 Beans')).toBeInTheDocument();
    });

    it('in plain words: allowance, not spending, and no "floor depth"', () => {
        render(<ThreatReviewModal threat={flag} members={roster} onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('New members reached a large credit allowance within two weeks');
        expect(document.body.textContent).toMatch(/not what they spent/);
        expect(document.body.textContent).not.toMatch(/floor/i);
        expect(screen.queryByRole('button', { name: /Freeze Accounts/ })).not.toBeInTheDocument();
    });
});
