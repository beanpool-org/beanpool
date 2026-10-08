/**
 * Edit home on the card frame (CARD-FRAME-DESIGN-fable.md §1.3, slice F3): ＋ Add a card first, rows with ↑ ↓ …, no
 * switches and no Hidden list, a saved search named by its words in every label (never on the row), Settings… only on a
 * type that has them, Remove moves focus to the nearest row, Reset to defaults, and "not on your account yet".
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditHomeDialog, type EditHomeRow } from './EditHomeDialog';

const ROWS: EditHomeRow[] = [
    { id: 'search-aaaa', name: 'A saved search', label: '"eggs"', hasSettings: true },
    { id: 'steps', name: 'First steps', label: 'First steps', note: 'Nothing to show now', hasSettings: false },
    { id: 'tips', name: 'Tips', label: 'Tips', note: 'All tips seen', hasSettings: false },
];

function draw(over: Partial<Parameters<typeof EditHomeDialog>[0]> = {}) {
    const props = { rows: ROWS, onAdd: vi.fn(), onMove: vi.fn(), onSettings: vi.fn(), onRemove: vi.fn(), onReset: vi.fn(), onClose: vi.fn(), ...over };
    render(<EditHomeDialog {...props} />);
    return props;
}

describe('EditHomeDialog', () => {
    it('＋ Add a card first, then the cards in order with ↑ ↓ …; no switches, no Hidden; every target 44 px', () => {
        const p = draw();
        const dialog = screen.getByRole('dialog', { name: 'Edit home' });
        const buttons = within(dialog).getAllByRole('button');
        expect(buttons[0]).toHaveTextContent('Add a card');
        expect(within(dialog).queryAllByRole('switch')).toHaveLength(0);
        expect(dialog.textContent).not.toMatch(/Hidden/);
        expect(within(dialog).getAllByRole('listitem').map(li => li.getAttribute('data-testid'))).toEqual(['home-edit-row-search-aaaa', 'home-edit-row-steps', 'home-edit-row-tips']);
        expect(screen.getByTestId('home-edit-row-steps')).toHaveTextContent('Nothing to show now');
        expect(screen.getByTestId('home-edit-row-tips')).toHaveTextContent('All tips seen');
        for (const b of buttons) expect(b.className).toContain('min-h-[44px]');
        fireEvent.click(buttons[0]);
        expect(p.onAdd).toHaveBeenCalled();
    });

    it('a saved search is named by its words in its labels, never on its row; arrows at the ends are off', () => {
        const p = draw();
        expect(screen.getByTestId('home-edit-row-search-aaaa')).toHaveTextContent('A saved search');
        expect(screen.getByTestId('home-edit-row-search-aaaa').textContent).not.toContain('eggs');
        expect(screen.getByRole('button', { name: 'Move "eggs" up' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Move Tips down' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Move "eggs" down' }));
        expect(p.onMove).toHaveBeenCalledWith('search-aaaa', 'down');
    });

    it('"…": Settings… only on a type that has them; Remove takes it off and focus goes to the nearest row', () => {
        const p = draw();
        fireEvent.click(screen.getByRole('button', { name: 'Options for First steps', expanded: false }));
        expect(screen.queryByText('Settings…')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove First steps from Home' }));
        expect(p.onRemove).toHaveBeenCalledWith('steps');
        expect(document.activeElement).toBe(screen.getByTestId('home-edit-menu-tips'));
        fireEvent.click(screen.getByTestId('home-edit-menu-search-aaaa'));
        fireEvent.click(screen.getByRole('button', { name: 'Settings for "eggs"' }));
        expect(p.onSettings).toHaveBeenCalledWith('search-aaaa');
    });

    it('Reset to defaults; "not on your account yet" when the node can\'t keep the cards; Escape closes', () => {
        const p = draw({ notOnAccount: true });
        expect(screen.getByTestId('home-edit-not-on-account')).toHaveTextContent("Your community's server needs an update before your cards follow you to other devices.");
        fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
        expect(p.onReset).toHaveBeenCalled();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(p.onClose).toHaveBeenCalled();
    });
});
