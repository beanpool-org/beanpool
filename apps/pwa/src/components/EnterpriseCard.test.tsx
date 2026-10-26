import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnterpriseCard } from './EnterpriseCard';
import type { Treasury } from '../lib/api';
import { isPastDeadline } from '../lib/enterprise-pledge';

const mockTreasury: Treasury = {
    publicKey: 'pub_test123',
    name: 'Green Farm Collective',
    callsign: 'greenfarm',
    purpose: 'Local organic food growing collective',
    balance: 150,
    creditLine: 0,
    earnedSurplus: 45,
    status: 'active',
    lifecycle: 'bounded',
    goalAmount: 500,
    currentAmount: 200,
    deadlineAt: new Date(Date.now() + 86400000 * 5).toISOString(),
    liveOffers: 3,
    keepers: [{ publicKey: 'k1', callsign: 'keeper1' }, { publicKey: 'k2', callsign: 'keeper2' }],
};

describe('EnterpriseCard Accessibility', () => {
    it('renders with role="button" and focus-visible ring classes', () => {
        render(<EnterpriseCard treasury={mockTreasury} />);
        const card = screen.getByRole('button');
        expect(card).toBeInTheDocument();
        expect(card.className).toContain('focus-visible:ring-2');
        expect(card.className).toContain('focus-visible:ring-emerald-500');
    });

    it('triggers onOpen when clicked or on Enter/Space key press', () => {
        const onOpen = vi.fn();
        render(<EnterpriseCard treasury={mockTreasury} onOpen={onOpen} />);
        const card = screen.getByRole('button');

        fireEvent.click(card);
        expect(onOpen).toHaveBeenLastCalledWith('pub_test123');

        fireEvent.keyDown(card, { key: 'Enter' });
        expect(onOpen).toHaveBeenLastCalledWith('pub_test123');

        fireEvent.keyDown(card, { key: ' ' });
        expect(onOpen).toHaveBeenLastCalledWith('pub_test123');
    });

    it('wraps decorative emojis with aria-hidden="true"', () => {
        const { container } = render(<EnterpriseCard treasury={mockTreasury} />);
        const hiddenEmojis = container.querySelectorAll('span[aria-hidden="true"]');
        expect(hiddenEmojis.length).toBeGreaterThan(0);
        // Verify default fallback seedling emoji is aria-hidden
        const seedlingSpan = Array.from(hiddenEmojis).find(span => span.textContent?.includes('🌱'));
        expect(seedlingSpan).toBeDefined();
    });

    it('shows Pledge Beans when the project is active and deadline is in the future', () => {
        render(<EnterpriseCard treasury={mockTreasury} />);
        expect(screen.getByText('Pledge Beans')).toBeInTheDocument();
    });

    it('hides Pledge Beans when the project deadline has passed', () => {
        const expiredTreasury: Treasury = {
            ...mockTreasury,
            deadlineAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        };
        render(<EnterpriseCard treasury={expiredTreasury} />);
        expect(screen.getByText(/Expired/)).toBeInTheDocument();
        expect(screen.queryByText('Pledge Beans')).not.toBeInTheDocument();
    });
});

// The badge and the node's pledge gate are one rule (#2500, its deciding review): a deadline is the chosen day, so on that
// day the badge says "Ends today" and the card still says Pledge Beans; from the moment the badge says "Expired" it doesn't.
describe('The deadline badge, and Pledge Beans until it says Expired', () => {
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const NOW = Date.parse('2026-10-26T09:30:00.000Z');
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => { vi.useRealTimers(); });

    // [when the deadline's instant was, ms before now, what the badge has always said then]
    it.each([
        ['3 days ahead', -3 * DAY, '3 days left'],
        ['an hour ahead', -HOUR, '1 days left'],
        ['at the deadline', 0, 'Ends today'],
        ['an hour after', HOUR, 'Ends today'],
        ['23 h 59 m after', DAY - MINUTE, 'Ends today'],
        ['a millisecond short of 24 h after', DAY - 1, 'Ends today'],
        ['24 h after', DAY, 'Expired'],
        ['25 h after', DAY + HOUR, 'Expired'],
        ['3 days after', 3 * DAY, 'Expired'],
    ] as const)('%s', (_when, before, badge) => {
        const deadlineAt = new Date(NOW - before).toISOString();
        render(<EnterpriseCard treasury={{ ...mockTreasury, deadlineAt }} />);
        expect(screen.getByText(badge).textContent).toBe(`⏳ ${badge}`);
        const expired = badge === 'Expired';
        expect(isPastDeadline(deadlineAt)).toBe(expired);
        expect(screen.queryByText('Pledge Beans') !== null).toBe(!expired);
    });
});
