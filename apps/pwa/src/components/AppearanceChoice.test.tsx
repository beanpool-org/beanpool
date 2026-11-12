/**
 * Settings -> Appearance on the web (components/AppearanceChoice.tsx): one list of four rows -- Same as device, Classic,
 * Light, Dark -- a radio group a keyboard and a screen reader can use. The rule that turns a row into a look is core's
 * (look.ts), held in its own test; this holds the list: its order, what is chosen, what a tap and the arrow keys do, what a
 * screen reader hears, and that each row's dots come from the colour library.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandSwatch } from '@beanpool/core';
import { AppearanceChoice } from './AppearanceChoice';
import { type ThemePreference } from '../lib/useTheme';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

afterEach(() => { cleanup(); backToEnglish(); });

const rows = () => screen.getAllByRole('radio');
const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('the list', () => {
    it('is a radio group of exactly four rows: Same as device, Classic, Light, Dark -- each with its line as its description', () => {
        render(<AppearanceChoice value="dark" onChange={() => {}} />);
        expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument();
        expect(rows().map(r => r.textContent?.replace('✓', ''))).toEqual([
            'Same as deviceLight when your device is light, Classic when it is dark',
            'ClassicDark with olive green',
            'LightPale and warm',
            'DarkCharcoal and blue',
        ]);
        // A screen reader hears the name, then the line as the description.
        screen.getByRole('radio', { name: 'Same as device', description: 'Light when your device is light, Classic when it is dark' });
        screen.getByRole('radio', { name: 'Classic', description: 'Dark with olive green' });
        screen.getByRole('radio', { name: 'Light', description: 'Pale and warm' });
        screen.getByRole('radio', { name: 'Dark', description: 'Charcoal and blue' });
    });

    it.each([
        ['system', 'Same as device'],
        ['dark', 'Classic'],
        ['light', 'Light'],
        ['night', 'Dark'],
    ] as const)('stored %s is the row called %s, the only one chosen, with a tick', (value, name) => {
        render(<AppearanceChoice value={value} onChange={() => {}} />);
        const checked = rows().filter(r => r.getAttribute('aria-checked') === 'true');
        expect(checked).toHaveLength(1);
        expect(within(checked[0]).getByText(name)).toBeInTheDocument();
        // The choice does not rest on colour alone: a tick, and a border in the heading's ink.
        expect(checked[0].textContent).toContain('✓');
        expect(checked[0].className).toMatch(/border-nature-900/);
        for (const other of rows().filter(r => r !== checked[0])) {
            expect(other.textContent).not.toContain('✓');
            expect(other.className).not.toMatch(/border-nature-900/);
        }
    });

    it('every row is at least 48 px tall and full width, and its words wrap', () => {
        render(<AppearanceChoice value="dark" onChange={() => {}} />);
        for (const r of rows()) {
            expect(r.className).toMatch(/min-h-\[48px\]/);
            expect(r.className).toMatch(/\bw-full\b/);
            expect(r.querySelector('.break-words')).not.toBeNull();
        }
    });
});

describe('a tap', () => {
    it.each([
        ['Same as device', 'system'],
        ['Classic', 'dark'],
        ['Light', 'light'],
        ['Dark', 'night'],
    ] as const)('on %s chooses %s at once: no Save', (name, value) => {
        const onChange = vi.fn();
        render(<AppearanceChoice value="dark" onChange={onChange} />);
        fireEvent.click(screen.getByRole('radio', { name }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(value);
    });
});

describe('the keyboard', () => {
    function Harness({ start }: { start: ThemePreference }) {
        const [value, setValue] = useState<ThemePreference>(start);
        return <AppearanceChoice value={value} onChange={setValue} />;
    }
    const chosen = () => rows().filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)?.textContent);

    it('the group is one tab stop, on the chosen row', () => {
        render(<AppearanceChoice value="light" onChange={() => {}} />);
        expect(rows().map(r => r.tabIndex)).toEqual([-1, -1, 0, -1]);
    });

    it('the arrow keys move to the next and previous row and choose it, wrapping at both ends', () => {
        render(<Harness start="dark" />);
        const group = screen.getByRole('radiogroup');
        fireEvent.keyDown(group, { key: 'ArrowDown' });
        expect(chosen()).toEqual(['Light']);
        fireEvent.keyDown(group, { key: 'ArrowRight' });
        expect(chosen()).toEqual(['Dark']);
        fireEvent.keyDown(group, { key: 'ArrowDown' });
        expect(chosen()).toEqual(['Same as device']);
        fireEvent.keyDown(group, { key: 'ArrowUp' });
        expect(chosen()).toEqual(['Dark']);
        fireEvent.keyDown(group, { key: 'ArrowLeft' });
        expect(chosen()).toEqual(['Light']);
    });

    it('Home and End go to the first and last row, and focus follows the choice', () => {
        render(<Harness start="dark" />);
        const group = screen.getByRole('radiogroup');
        fireEvent.keyDown(group, { key: 'End' });
        expect(chosen()).toEqual(['Dark']);
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Dark' }));
        fireEvent.keyDown(group, { key: 'Home' });
        expect(chosen()).toEqual(['Same as device']);
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Same as device' }));
    });

    it('a key that is not the list\'s is left alone', () => {
        const onChange = vi.fn();
        render(<AppearanceChoice value="dark" onChange={onChange} />);
        const go = fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'a' });
        expect(go).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe('the dots come from the colour library', () => {
    const dotsOf = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLElement>('[data-testid="appearance-dots"] > span')).map(d => d.style.backgroundColor);

    it('a look shows its page, card and accent; Same as device shows the Light page and the Classic page', () => {
        render(<AppearanceChoice value="dark" onChange={() => {}} />);
        const byName = (name: string) => screen.getByRole('radio', { name });
        const want = (set: 'light' | 'dark' | 'night') => { const s = brandSwatch(set, 'web'); return [s.page, s.card, s.accent].map(rgb); };
        expect(dotsOf(byName('Classic'))).toEqual(want('dark'));
        expect(dotsOf(byName('Light'))).toEqual(want('light'));
        expect(dotsOf(byName('Dark'))).toEqual(want('night'));
        expect(dotsOf(byName('Same as device'))).toEqual([rgb(brandSwatch('light', 'web').page), rgb(brandSwatch('dark', 'web').page)]);
    });

    it('the dots are decoration: hidden from a screen reader, and the three looks do not share a colour set', () => {
        render(<AppearanceChoice value="dark" onChange={() => {}} />);
        for (const r of rows()) expect(r.querySelector('[data-testid="appearance-dots"]')?.getAttribute('aria-hidden')).toBe('true');
        const classic = dotsOf(screen.getByRole('radio', { name: 'Classic' }));
        const dark = dotsOf(screen.getByRole('radio', { name: 'Dark' }));
        expect(classic).not.toEqual(dark);
    });
});

describe('in the pseudo-locale (every sentence came through t())', () => {
    beforeEach(async () => { await showIn('xx'); });

    it('every word on the list is bracketed: none bypassed t()', () => {
        render(<AppearanceChoice value="light" onChange={() => {}} />);
        expect(bypassing(document.body)).toEqual([]);
        expect(screen.getByRole('radiogroup', { name: xx('Appearance') })).toBeInTheDocument();
        // Each row's name and its line, both bracketed: eight sentences' worth of text on four rows.
        for (const name of ['Same as device', 'Classic', 'Light', 'Dark']) {
            const row = screen.getByRole('radio', { name: xx(name) });
            expect(bracketed(row)).toBeGreaterThanOrEqual(2);
        }
    });
});
