import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LocalCommunityAction, LocalCommunityStrip, LocalCommunitySheet } from './LocalCommunityMark';
import { StartCommunityScreen } from './StartCommunityScreen';

describe('Local community sheets focus trap & return', () => {
    it('WithSheet / LocalCommunitySheet: Tab loops inside, Shift+Tab loops backwards, Escape returns focus to marker', async () => {
        render(
            <div>
                <button data-testid="outside-button">Outside</button>
                <LocalCommunityAction
                    feature="beans"
                    label="Send Beans"
                    onNearYou={vi.fn()}
                    onGuide={vi.fn()}
                />
            </div>
        );

        const marker = screen.getByTestId('local-community-action');
        marker.focus();
        expect(document.activeElement).toBe(marker);

        fireEvent.click(marker);

        const sheet = await screen.findByTestId('local-community-sheet');
        expect(sheet).toBeInTheDocument();

        const closeBtn = within(sheet).getByRole('button', { name: 'Close' });
        expect(document.activeElement).toBe(closeBtn);

        // Buttons in sheet: Close, Start a community, Communities near you, How it works ›
        const buttons = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled])'));
        expect(buttons.length).toBeGreaterThan(1);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        expect(first).toBe(closeBtn);

        // Shift+Tab from first lands on last
        first.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);

        // Tab from last lands on first
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
        expect(document.activeElement).toBe(first);

        // Escape closes sheet and returns focus to the marker that opened it
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('local-community-sheet')).toBeNull();
        expect(document.activeElement).toBe(marker);
    });

    it('WithSheet -> StartCommunityScreen: Tab loops, Shift+Tab loops, Escape returns focus to marker', async () => {
        render(
            <div>
                <LocalCommunityAction
                    feature="beans"
                    label="Send Beans"
                    onNearYou={vi.fn()}
                />
            </div>
        );

        const marker = screen.getByTestId('local-community-action');
        marker.focus();
        fireEvent.click(marker);

        const sheet = await screen.findByTestId('local-community-sheet');
        const startBtn = within(sheet).getByTestId('local-community-start');
        fireEvent.click(startBtn);

        const startScreen = await screen.findByTestId('start-community-screen');
        expect(startScreen).toBeInTheDocument();

        const backBtn = within(startScreen).getByRole('button', { name: 'Back' });
        expect(document.activeElement).toBe(backBtn);

        const focusables = Array.from(startScreen.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ));
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        expect(first).toBe(backBtn);

        // Shift+Tab from first lands on last
        first.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);

        // Tab from last lands on first
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
        expect(document.activeElement).toBe(first);

        // Escape closes Start screen and returns focus to marker
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('start-community-screen')).toBeNull();
        expect(document.activeElement).toBe(marker);
    });

    it('StartCommunityScreen (standalone): Tab loops, Shift+Tab loops, and returns focus on close', async () => {
        const onClose = vi.fn();
        const { unmount } = render(
            <div>
                <button data-testid="opener-btn">Open Start</button>
                <StartCommunityScreen onClose={onClose} />
            </div>
        );

        const startScreen = screen.getByTestId('start-community-screen');
        const backBtn = within(startScreen).getByRole('button', { name: 'Back' });
        expect(document.activeElement).toBe(backBtn);

        const focusables = Array.from(startScreen.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ));
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        first.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);

        last.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
        expect(document.activeElement).toBe(first);

        unmount();
    });
});
