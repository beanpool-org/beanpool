import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CategoryTile } from './CategoryTile';

describe('CategoryTile (PWA)', () => {
    it('renders unknown category with package emoji 📦 and GENERAL on general tint', () => {
        const { getByTestId } = render(<CategoryTile category="unknown_xyz" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-general-tint)');
        expect(tile.textContent).toContain('📦');
        expect(tile.textContent).toContain('GENERAL');
    });

    it('renders null/undefined category with package emoji 📦 and GENERAL on general tint', () => {
        const { getByTestId } = render(<CategoryTile category={null} />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-general-tint)');
        expect(tile.textContent).toContain('📦');
        expect(tile.textContent).toContain('GENERAL');
    });

    it('renders known general category with seedling emoji 🌱', () => {
        const { getByTestId } = render(<CategoryTile category="general" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-general-tint)');
        expect(tile.textContent).toContain('🌱');
        expect(tile.textContent).toContain('GENERAL');
    });

    it('renders known food category with carrot emoji 🥕', () => {
        const { getByTestId } = render(<CategoryTile category="food" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-food-tint)');
        expect(tile.textContent).toContain('🥕');
        expect(tile.textContent).toContain('FOOD & PRODUCE');
    });

    it('renders event tile with calendar emoji 📅 and EVENT label', () => {
        const { getByTestId } = render(<CategoryTile kind="event" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-event-tint)');
        expect(tile.textContent).toContain('📅');
        expect(tile.textContent).toContain('EVENT');
    });

    it('renders pulse tile with newspaper emoji 🗞️ and PULSE label', () => {
        const { getByTestId } = render(<CategoryTile kind="pulse" />);
        const tile = getByTestId('category-tile');
        expect(tile).toBeInTheDocument();
        expect(tile.style.backgroundColor).toContain('var(--bp-tile-pulse-tint)');
        expect(tile.textContent).toContain('🗞️');
        expect(tile.textContent).toContain('PULSE');
    });
});
