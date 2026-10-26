import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ChatPhotoViewer } from './ChatPhotoViewer';

afterEach(cleanup);

// Deciding review on bc7fba47: a node alert (SystemAlerts, z-index 9999) is drawn ABOVE the viewer but sits BEFORE the
// viewer's portal in the DOM, so "the last dialog" is always the viewer. With focus inside the alert, its keys are the alert's.
describe('the photo viewer under an alert dialog', () => {
    it("Escape and Tab inside an alert drawn over the viewer are the alert's, not the photo's", () => {
        const onClose = vi.fn();
        render(
            <>
                <div role="alertdialog" aria-modal="true" aria-label="Node alert">
                    <button type="button">Acknowledge</button>
                    <button type="button">Close all</button>
                </div>
                <ChatPhotoViewer uri="data:image/jpeg;base64,xyz" onClose={onClose} />
            </>,
        );
        const ack = screen.getByRole('button', { name: 'Acknowledge' });
        ack.focus();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        window.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(false);
    });

    it('with focus in the viewer, Escape still closes the photo', () => {
        const onClose = vi.fn();
        render(<ChatPhotoViewer uri="data:image/jpeg;base64,xyz" onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
