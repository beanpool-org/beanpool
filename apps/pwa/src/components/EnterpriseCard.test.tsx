import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnterpriseCard } from './EnterpriseCard';
import type { Treasury } from '../lib/api';

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
});
