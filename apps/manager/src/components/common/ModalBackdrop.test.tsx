import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ModalBackdrop } from './ModalBackdrop';

/**
 * Every Settings modal sits in ModalBackdrop: the backdrop, Escape and the phone's Back button close it, as well as its
 * ✕. The real-browser check (e2e/phone-width.mjs) opens each modal; this covers the rules themselves.
 */

async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}

async function back() {
    await act(async () => { window.history.back(); });
    await settle();
}

function Modal({ name, busy = false, children }: { name: string; busy?: boolean; children?: React.ReactNode }) {
    const [open, setOpen] = useState(true);
    if (!open) return <p>{name} closed</p>;
    return (
        <ModalBackdrop onClose={() => setOpen(false)} dismissable={!busy} className="fixed inset-0" data-testid={`${name}-backdrop`}>
            <div>
                <h3>{name}</h3>
                <input aria-label={`${name} field`} />
                <button aria-label="Close" onClick={() => setOpen(false)}>✕</button>
                {children}
            </div>
        </ModalBackdrop>
    );
}

describe('ModalBackdrop', () => {
    beforeEach(() => {
        window.history.replaceState({ bpSettings: { tab: 'people', sub: 'directory' } }, '');
    });

    it('a tap on the backdrop closes it; a press that starts in the card does not', async () => {
        render(<Modal name="Member" />);
        const backdrop = screen.getByTestId('Member-backdrop');

        // Selecting text in the field and letting go over the backdrop.
        fireEvent.mouseDown(screen.getByLabelText('Member field'));
        fireEvent.click(backdrop);
        expect(screen.getByText('Member')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Member'));
        expect(screen.getByText('Member')).toBeInTheDocument();

        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(screen.getByText('Member closed')).toBeInTheDocument();
    });

    it('Escape closes only the top modal', async () => {
        render(<Modal name="Member"><Modal name="Offboard" /></Modal>);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByText('Offboard closed')).toBeInTheDocument();
        expect(screen.getByText('Member')).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.getByText('Member closed')).toBeInTheDocument();
    });

    it('Back closes the top modal and stays on the screen', async () => {
        render(<Modal name="Member"><Modal name="Offboard" /></Modal>);
        await settle();
        expect(window.history.state.bpModal).toBe(2);

        await back();
        expect(screen.getByText('Offboard closed')).toBeInTheDocument();
        expect(screen.getByText('Member')).toBeInTheDocument();
        await back();
        expect(screen.getByText('Member closed')).toBeInTheDocument();
        expect(window.history.state).toEqual({ bpSettings: { tab: 'people', sub: 'directory' } });
    });

    it('closing with the ✕ drops its history entry, so the next Back is not spent on it', async () => {
        render(<Modal name="Member" />);
        await settle();
        expect(window.history.state.bpModal).toBe(1);

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        await settle();
        expect(screen.getByText('Member closed')).toBeInTheDocument();
        expect(window.history.state).toEqual({ bpSettings: { tab: 'people', sub: 'directory' } });
    });

    it('while it cannot be left, the backdrop, Escape and Back leave it open', async () => {
        render(<Modal name="Prune" busy />);
        await settle();
        const backdrop = screen.getByTestId('Prune-backdrop');
        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        fireEvent.keyDown(window, { key: 'Escape' });
        await back();
        expect(screen.getByText('Prune')).toBeInTheDocument();
        // Back put its entry back, so the next Back is still the modal's.
        expect(window.history.state.bpModal).toBe(1);
    });
});
