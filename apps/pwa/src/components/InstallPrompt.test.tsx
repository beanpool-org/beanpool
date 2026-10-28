import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { InstallPrompt, isInstalled, DesktopInstallSteps, useDeferredInstallPrompt, clearDeferredPrompt } from './InstallPrompt';

describe('InstallPrompt (front doors S4)', () => {
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

    it('banner is removed on phones and desktop, rendering null', () => {
        const { container } = render(<InstallPrompt />);
        expect(container.firstChild).toBeNull();

        act(() => {
            vi.advanceTimersByTime(5000);
        });

        expect(screen.queryByRole('region', { name: 'App installation prompt' })).toBeNull();
        expect(container.firstChild).toBeNull();
    });

    it('isInstalled detects standalone mode', () => {
        expect(isInstalled()).toBe(false);

        (window.matchMedia as any).mockImplementation((query: string) => ({
            matches: query === '(display-mode: standalone)',
            media: query,
        }));

        expect(isInstalled()).toBe(true);
    });

    it('DesktopInstallSteps renders instructions with icon part', () => {
        render(<DesktopInstallSteps />);
        expect(screen.getByTestId('desktop-install-steps')).toBeInTheDocument();
        expect(screen.getByText('install icon')).toBeInTheDocument();
    });

    it('useDeferredInstallPrompt captures beforeinstallprompt event', () => {
        function TestComponent() {
            const prompt = useDeferredInstallPrompt();
            return <div data-testid="prompt-status">{prompt ? 'has-prompt' : 'no-prompt'}</div>;
        }

        render(<TestComponent />);
        expect(screen.getByTestId('prompt-status')).toHaveTextContent('no-prompt');

        const mockEvent = new Event('beforeinstallprompt');
        act(() => {
            window.dispatchEvent(mockEvent);
        });

        expect(screen.getByTestId('prompt-status')).toHaveTextContent('has-prompt');
    });

    it('clearDeferredPrompt resets prompt and notifies subscribers', () => {
        function TestComponent() {
            const prompt = useDeferredInstallPrompt();
            return <div data-testid="prompt-status">{prompt ? 'has-prompt' : 'no-prompt'}</div>;
        }

        render(<TestComponent />);
        const mockEvent = new Event('beforeinstallprompt');
        act(() => {
            window.dispatchEvent(mockEvent);
        });
        expect(screen.getByTestId('prompt-status')).toHaveTextContent('has-prompt');

        act(() => {
            clearDeferredPrompt();
        });
        expect(screen.getByTestId('prompt-status')).toHaveTextContent('no-prompt');
    });
});
