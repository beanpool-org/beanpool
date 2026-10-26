import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ExampleListings } from './ExampleListings';

describe('ExampleListings category tile', () => {
    it('each example card renders CategoryTile', () => {
        render(<ExampleListings />);
        const cards = screen.getAllByTestId('example-card');
        expect(cards.length).toBeGreaterThan(0);
        for (const card of cards) {
            expect(within(card).getByTestId('category-tile')).toBeInTheDocument();
        }
    });
});
