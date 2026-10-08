/**
 * A Home card's "…" (components/HomeCard.tsx): version 1's Hide · Move up · Move down, and the card frame's (CARD-FRAME
 * §1.3, slice F3) Settings… · Move up · Move down · Remove, named by the card's screen-reader name, never its caption.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeCard } from './HomeCard';

describe('HomeCard menu', () => {
    it('the card frame: Settings… · Move up · Move down · Remove, labelled by the saved search\'s words; the caption stays fixed words', () => {
        const onRemove = vi.fn();
        const onSettings = vi.fn();
        render(
            <HomeCard id="search-aaaa" title="A saved search"
                menu={{ label: '"eggs"', canMoveUp: true, canMoveDown: false, onRemove, onSettings, onMove: vi.fn() }}>
                <p>body</p>
            </HomeCard>,
        );
        expect(screen.getByRole('heading', { name: 'A saved search' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Settings…', 'Move up', 'Move down', 'Remove']);
        expect(screen.queryByText('Hide')).toBeNull();
        expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Remove "eggs" from Home' }));
        expect(onRemove).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Card options for "eggs"' }));
        fireEvent.click(screen.getByTestId('home-menu-settings'));
        expect(onSettings).toHaveBeenCalled();
    });

    it('version 1: Hide · Move up · Move down, as before', () => {
        const onHide = vi.fn();
        render(<HomeCard id="events" title="Coming up" menu={{ canMoveUp: false, canMoveDown: true, onHide, onMove: vi.fn() }}><p>body</p></HomeCard>);
        fireEvent.click(screen.getByRole('button', { name: 'Card options for Coming up' }));
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['…', 'Hide', 'Move up', 'Move down']);
        fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
        expect(onHide).toHaveBeenCalled();
    });
});
