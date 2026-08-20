import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrivacyBadge } from './PrivacyBadge';

describe('PrivacyBadge', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('renders default Ghost tier when no saved state exists', () => {
        render(<PrivacyBadge />);

        const button = screen.getByRole('button');
        expect(button).toHaveTextContent('Ghost');
        expect(button).toHaveAttribute('title', 'Privacy: Ghost — Invisible. No location shared.');
    });

    it('renders saved tier state from localStorage', () => {
        localStorage.setItem('beanpool-privacy-tier', '2');

        render(<PrivacyBadge />);

        const button = screen.getByRole('button');
        expect(button).toHaveTextContent('Zone');
        expect(button).toHaveAttribute('title', 'Privacy: Zone — Fuzzed ±2km neighborhood.');
    });

    it('cycles through privacy tiers on click and updates localStorage', () => {
        render(<PrivacyBadge />);

        const button = screen.getByRole('button');

        // Initial: Ghost (0)
        expect(button).toHaveTextContent('Ghost');

        // Click 1: Post-Only (1)
        fireEvent.click(button);
        expect(button).toHaveTextContent('Post-Only');
        expect(button).toHaveAttribute('title', 'Privacy: Post-Only — Location at time of posting only.');
        expect(localStorage.getItem('beanpool-privacy-tier')).toBe('1');

        // Click 2: Zone (2)
        fireEvent.click(button);
        expect(button).toHaveTextContent('Zone');
        expect(button).toHaveAttribute('title', 'Privacy: Zone — Fuzzed ±2km neighborhood.');
        expect(localStorage.getItem('beanpool-privacy-tier')).toBe('2');

        // Click 3: Live (3)
        fireEvent.click(button);
        expect(button).toHaveTextContent('Live');
        expect(button).toHaveAttribute('title', 'Privacy: Live — Real-time (foreground only).');
        expect(localStorage.getItem('beanpool-privacy-tier')).toBe('3');

        // Click 4: Ghost (0)
        fireEvent.click(button);
        expect(button).toHaveTextContent('Ghost');
        expect(button).toHaveAttribute('title', 'Privacy: Ghost — Invisible. No location shared.');
        expect(localStorage.getItem('beanpool-privacy-tier')).toBe('0');
    });

    it('triggers haptic feedback when navigator.vibrate is available', () => {
        const vibrateMock = vi.fn();
        Object.defineProperty(navigator, 'vibrate', {
            configurable: true,
            writable: true,
            value: vibrateMock,
        });

        render(<PrivacyBadge />);
        const button = screen.getByRole('button');

        // Transition from Ghost (0) to Post-Only (1)
        fireEvent.click(button);
        expect(vibrateMock).toHaveBeenCalledWith([50]);

        // Transition to Zone (2)
        fireEvent.click(button);
        expect(vibrateMock).toHaveBeenCalledWith([50]);

        // Transition to Live (3)
        fireEvent.click(button);
        expect(vibrateMock).toHaveBeenCalledWith([50]);

        // Transition to Ghost (0) - wrap around
        fireEvent.click(button);
        expect(vibrateMock).toHaveBeenCalledWith([100, 50, 100]);
    });
});
