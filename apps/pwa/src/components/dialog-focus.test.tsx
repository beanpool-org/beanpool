import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDialogFocus } from './dialog-focus';

function Dialog() {
    const box = useRef<HTMLDivElement>(null);
    useDialogFocus(box, () => {});
    return (
        <div ref={box} role="dialog" aria-modal="true" aria-labelledby="t">
            <h2 id="t" tabIndex={-1}>Settings</h2>
            <input aria-label="Words" />
            <select aria-label="Category"><option>All</option></select>
            <button type="button">Save</button>
        </div>
    );
}

describe('useDialogFocus Tab keys', () => {
    it('Shift+Tab from the heading focused on open goes to the last control, Tab to the first', () => {
        render(<Dialog />);
        const heading = screen.getByRole('heading', { name: 'Settings' });
        expect(document.activeElement).toBe(heading);
        fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
        heading.focus();
        fireEvent.keyDown(window, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Words' }));
    });

    it('a select in the middle is a Tab stop: Tab and Shift+Tab from it are left to the browser', () => {
        render(<Dialog />);
        const select = screen.getByRole('combobox', { name: 'Category' });
        select.focus();
        // fireEvent returns false when the handler called preventDefault.
        expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(true);
        expect(document.activeElement).toBe(select);
        expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(true);
        expect(document.activeElement).toBe(select);
    });
});
