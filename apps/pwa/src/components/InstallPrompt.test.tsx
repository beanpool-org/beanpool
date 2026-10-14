import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { InstallPrompt } from './InstallPrompt';

describe('InstallPrompt', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders after delay when not installed and not dismissed', () => {
        render(<InstallPrompt />);
        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();

        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const prompt = screen.getByRole('region', { name: 'App installation prompt' });
        expect(prompt).toBeInTheDocument();

        const closeBtn = screen.getByRole('button', { name: 'Dismiss install prompt' });
        expect(closeBtn.style.minWidth).toBe('44px');
        expect(closeBtn.style.minHeight).toBe('44px');

        const howBtn = screen.getByRole('button', { name: 'How?' });
        expect(howBtn.style.minWidth).toBe('44px');
        expect(howBtn.style.minHeight).toBe('44px');

        const neverBtn = screen.getByRole('button', { name: /Don’t show this again|Don't show this again/ });
        expect(neverBtn.style.minHeight).toBe('44px');
    });

    it('toggles steps visibility when How? button is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const howBtn = screen.getByRole('button', { name: 'How?' });
        expect(screen.queryByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeNull();

        fireEvent.click(howBtn);
        expect(screen.getByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeInTheDocument();

        fireEvent.click(howBtn);
        expect(screen.queryByText(/iPhone \/ iPad:|Android:|Desktop:/)).toBeNull();
    });

    it('dismisses when close button is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const closeBtn = screen.getByRole('button', { name: 'Dismiss install prompt' });
        fireEvent.click(closeBtn);

        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();
        expect(localStorage.getItem('beanpool-install-dismissed')).toBeTruthy();
    });

    it('dismisses forever when "Don\'t show this again" is clicked', () => {
        render(<InstallPrompt />);
        act(() => {
            vi.advanceTimersByTime(2000);
        });

        const neverBtn = screen.getByRole('button', { name: /Don’t show this again|Don't show this again/ });
        fireEvent.click(neverBtn);

        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();
        expect(localStorage.getItem('beanpool-install-dismissed-forever')).toBe('1');
    });
});
