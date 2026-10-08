/**
 * Add a card (CARD-FRAME-DESIGN-fable.md §1.2, slice F3): the picker lists only this node's types in three groups, says
 * "On Home" and "2 of 5 on Home", adds a type without settings at once, opens a saved search's words first ("Add to
 * Home"), and says nothing locked. The settings dialog's Save keeps the other settings.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultCards, defaultHomeLayout } from '@beanpool/core';
import { AddCardDialog, CardSettingsDialog, PICKER_FULL_NOTE } from './AddCardDialog';
import { pickerGroups } from '../lib/home-layout';

const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const GLOBAL = { profile: 'global', features: { beans: false, escrow: false, enterprises: false, invites: false, decisions: false } };
const TWO_SEARCHES = {
    ...defaultHomeLayout(),
    cards: [...defaultCards(), { id: 'search-aaaa', type: 'search', settings: { q: 'eggs' } }, { id: 'search-bbbb', type: 'search', settings: { q: 'jam' } }],
};

describe('AddCardDialog', () => {
    it('three groups, this node\'s types only, "On Home" for one already there, "2 of 5 on Home", nothing locked', () => {
        const { groups, full } = pickerGroups(LOCAL, TWO_SEARCHES, 'admin');
        render(<AddCardDialog groups={groups} full={full} onAdd={vi.fn()} onClose={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: 'Add a card' });
        expect(within(dialog).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['For you', 'Around you', 'Getting started']);
        expect(screen.getByTestId('home-add-on-market')).toHaveTextContent('On Home');
        expect(screen.getByTestId('home-add-on-market')).toHaveAttribute('aria-label', 'New in the Market is already on Home');
        expect(screen.getByTestId('home-add-count-search')).toHaveTextContent('2 of 5 on Home');
        expect(screen.getByRole('button', { name: 'Add Your Beans to Home' })).toBeInTheDocument();
        expect(screen.queryByTestId('home-add-row-community')).toBeNull();
        expect(screen.queryByTestId('home-add-row-needs')).toBeNull();
        expect(dialog.textContent).not.toMatch(/lock|earn|tier|Ʀ/i);
        for (const b of within(dialog).getAllByRole('button')) expect(b.className).toContain('min-h-[44px]');
    });

    it('the worldwide community\'s picker has no Beans, deals, enterprise, Decide or Grow your community', () => {
        const { groups, full } = pickerGroups(GLOBAL, null, null);
        render(<AddCardDialog groups={groups} full={full} onAdd={vi.fn()} onClose={vi.fn()} />);
        for (const t of ['beans', 'deals', 'enterprise', 'decide', 'invite']) expect(screen.queryByTestId(`home-add-row-${t}`)).toBeNull();
        expect(screen.getByTestId('home-add-row-market')).toHaveTextContent('Near you');
    });

    it('Add on a type without settings adds it at once; a saved search asks its words first, then "Add to Home"', () => {
        const onAdd = vi.fn();
        const { groups, full } = pickerGroups(LOCAL, null, 'admin');
        render(<AddCardDialog groups={groups} full={full} onAdd={onAdd} onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add Your Beans to Home' }));
        expect(onAdd).toHaveBeenCalledWith('beans', undefined);
        fireEvent.click(screen.getByRole('button', { name: 'Add A saved search to Home' }));
        const settings = screen.getByRole('dialog', { name: 'A saved search' });
        expect(within(settings).getByTestId('home-settings-submit')).toBeDisabled();
        expect(settings).toHaveTextContent('Its listings show in a coming app update.');
        fireEvent.change(screen.getByTestId('home-settings-q'), { target: { value: '  eggs ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add to Home' }));
        expect(onAdd).toHaveBeenLastCalledWith('search', { q: 'eggs', kind: 'any' });
    });

    it('a full Home says so and offers no Add; Escape and Done close it', () => {
        const cards = Array.from({ length: 24 }, (_, i) => ({ id: `x-${i}`, type: `x${i}` }));
        const { groups, full } = pickerGroups(LOCAL, { ...defaultHomeLayout(), cards }, 'admin');
        const onClose = vi.fn();
        render(<AddCardDialog groups={groups} full={full} onAdd={vi.fn()} onClose={onClose} />);
        expect(screen.getByTestId('home-add-note')).toHaveTextContent(PICKER_FULL_NOTE);
        expect(screen.queryByRole('button', { name: /^Add .* to Home$/ })).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.click(screen.getByTestId('home-add-dialog-done'));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

describe('CardSettingsDialog', () => {
    it('Settings… on a saved search: its words, Save keeps its other settings', () => {
        const onSubmit = vi.fn();
        render(<CardSettingsDialog type="search" name="A saved search" mode="save" initial={{ q: 'eggs', kind: 'offer', km: 5 }} onSubmit={onSubmit} onClose={vi.fn()} />);
        expect(screen.getByTestId('home-settings-q')).toHaveValue('eggs');
        fireEvent.change(screen.getByTestId('home-settings-q'), { target: { value: 'duck eggs' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSubmit).toHaveBeenCalledWith({ q: 'duck eggs', kind: 'offer', km: 5 });
    });
});
