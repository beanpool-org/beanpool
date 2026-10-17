/**
 * The sync chip at its dot alone (a mobile header too narrow for the tab's title beside its words): the state stays in the
 * chip's name and title, and the words are hidden from sight and from screen readers. Where the header goes to the dot,
 * and the dot's contrast, are e2e/tour-check.mjs's (a real layout); this is the tree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SyncChip } from './SyncChip';

afterEach(cleanup);

describe('SyncChip', () => {
    it('shows its words, with no title, when it has room', () => {
        render(<SyncChip mode="offline" ago="59m ago" pulsing={false} stacked />);
        const chip = screen.getByRole('status', { name: 'Network status: Offline, last synced 59m ago' });
        expect(chip.dataset.dotOnly).toBe('false');
        expect(chip.getAttribute('title')).toBeNull();
        const words = chip.querySelector<HTMLElement>('[data-chip-words]')!;
        expect(words.style.visibility).toBe('');
        expect(words.getAttribute('aria-hidden')).toBeNull();
        expect(words.textContent).toBe('Offline59m ago');
    });

    it.each([false, true])('with a note (dot alone: %s), the note is in its name and is its title', (dotOnly) => {
        const note = 'This community is in a private preview. Ask its owner for an invite.';
        render(<SyncChip mode="guest" ago={null} pulsing={false} stacked dotOnly={dotOnly} note={note} />);
        const chip = screen.getByRole('status', { name: `Network status: Guest. ${note}` });
        expect(chip.getAttribute('title')).toBe(note);
    });

    it.each([
        ['online', null, 'Online'],
        ['online', '5s ago', 'Online, last synced 5s ago'],
        ['offline', '59m ago', 'Offline, last synced 59m ago'],
        ['guest', null, 'Guest'],
    ] as const)('at its dot alone (%s %s) keeps "%s" as its name and its title', (mode, ago, name) => {
        render(<SyncChip mode={mode} ago={ago} pulsing={false} stacked dotOnly />);
        const chip = screen.getByRole('status', { name: 'Network status: ' + name });
        expect(chip.dataset.dotOnly).toBe('true');
        expect(chip.getAttribute('title')).toBe(name);
        // The words stay laid out (the header measures them to know when they fit again) but can't be seen or read out.
        const words = chip.querySelector<HTMLElement>('[data-chip-words]')!;
        expect(words.style.visibility).toBe('hidden');
        expect(words.style.position).toBe('absolute');
        expect(words.getAttribute('aria-hidden')).toBe('true');
        expect(chip.querySelector('[data-chip-dot]')).not.toBeNull();
    });
});
