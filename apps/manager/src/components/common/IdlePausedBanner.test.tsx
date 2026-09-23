import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IdlePausedBanner } from './IdlePausedBanner';
import { ActivityPauseProvider } from '../../lib/activity-pause';

describe('IdlePausedBanner', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('renders nothing when not paused', () => {
        const { container } = render(<IdlePausedBanner />);
        expect(container.firstChild).toBeNull();
    });

    it('renders the idle banner and handles resume button click within ActivityPauseProvider', () => {
        vi.useFakeTimers();

        render(
            <ActivityPauseProvider idleAfterMs={1000}>
                <IdlePausedBanner />
            </ActivityPauseProvider>
        );

        // Initially active, banner should not be rendered
        expect(screen.queryByRole('status')).toBeNull();

        // Advance timers beyond idle timeout
        act(() => {
            vi.advanceTimersByTime(1050);
        });

        // Banner should now be visible
        const banner = screen.getByRole('status');
        expect(banner).toBeInTheDocument();
        expect(screen.getByText(/Updates paused while you’re away/i)).toBeInTheDocument();

        // Click Resume button
        const resumeBtn = screen.getByRole('button', { name: /Resume/i });
        fireEvent.click(resumeBtn);

        // Banner should disappear after resuming
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('remains hidden when tab is hidden (reason === "hidden")', () => {
        vi.useFakeTimers();

        // Mock document.hidden to true
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

        render(
            <ActivityPauseProvider idleAfterMs={1000}>
                <IdlePausedBanner />
            </ActivityPauseProvider>
        );

        // Dispatch visibilitychange
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
            vi.advanceTimersByTime(1500);
        });

        // Reason is 'hidden', so banner should stay hidden
        expect(screen.queryByRole('status')).toBeNull();
    });
});
