import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ModalBackdrop } from './ModalBackdrop';

/**
 * Every Settings modal sits in ModalBackdrop: the backdrop, Escape and the phone's Back button close it, as well as its
 * ✕. The real-browser check (e2e/phone-width.mjs) opens each modal; this covers the rules themselves.
 */

/**
 * jsdom runs a history traversal on a later task, and dropClosedModalEntries queues its `history.go` behind a timer,
 * so neither has happened when the call returns. Waiting a fixed few milliseconds for it is what made these flake on a
 * loaded runner: the wait ran out before the event arrived and the assertion read the entry that was still on top.
 * Wait for the event itself instead.
 */
async function awaitingPop(step: () => void) {
    await act(async () => {
        const landed = new Promise<void>(resolve => {
            window.addEventListener('popstate', () => resolve(), { once: true });
        });
        step();
        await landed;
    });
}

/** The phone's Back button. */
function back() {
    return awaitingPop(() => window.history.back());
}

/** Let a render's effects run; they push their history entries as they go. Nothing here waits on the clock. */
async function mounted() {
    await act(async () => {});
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
        await mounted();
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
        await mounted();
        expect(window.history.state.bpModal).toBe(1);

        // ✕ drops the modal's history entry (dropClosedModalEntries), so this click goes back one.
        await awaitingPop(() => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
        expect(screen.getByText('Member closed')).toBeInTheDocument();
        expect(window.history.state).toEqual({ bpSettings: { tab: 'people', sub: 'directory' } });
    });

    it('while it cannot be left, the backdrop, Escape and Back leave it open', async () => {
        render(<Modal name="Prune" busy />);
        await mounted();
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
