import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ThreatReviewModal, ThreatItem, MemberItem } from './ThreatReviewModal';

describe('ThreatReviewModal', () => {
    const mockThreat: ThreatItem = {
        id: 'threat-1',
        type: 'CIRCULAR_VOUCH_RING',
        severity: 'critical',
        description: 'Detected 0.85 insularity with reciprocal flow ratio 0.45 gross: 1200.00 and 2 cohort component of 5 members for wash1-1784649014864123',
    };

    const mockMembers: MemberItem[] = [
        {
            publicKey: 'wash1-1784649014864123',
            displayName: 'Alice Wash',
        },
        {
            publicKey: 'ring0-1784649014864567',
            displayName: 'Bob Ring',
        },
    ];

    it('renders threat details and parsed telemetry metrics', () => {
        render(
            <ThreatReviewModal
                threat={mockThreat}
                members={mockMembers}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('CIRCULAR_VOUCH_RING')).toBeInTheDocument();
        expect(screen.getByText('critical')).toBeInTheDocument();
        expect(screen.getByText('Reciprocal Flow Ratio')).toBeInTheDocument();
        expect(screen.getByText('0.45')).toBeInTheDocument();
        expect(screen.getByText('Gross Volume')).toBeInTheDocument();
        expect(screen.getByText('1200.00 BP')).toBeInTheDocument();
    });

    it('calls onClose when close button is clicked', async () => {
        const handleClose = vi.fn();
        render(
            <ThreatReviewModal
                threat={mockThreat}
                onClose={handleClose}
            />
        );

        await userEvent.click(screen.getByText('✕'));
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    // This test used to expect onDismiss after freezing a report. That was the bug: freezing is not an
    // outcome for a report, and onDismiss made the Manager treat it as handled with no server call.
    it('freezing a reported member closes the modal without dismissing the report', async () => {
        vi.useFakeTimers();
        const handleFreeze = vi.fn().mockResolvedValue(undefined);
        const handleDismiss = vi.fn();
        const handleClose = vi.fn();
        const reportThreat: ThreatItem = {
            isReport: true,
            targetPubkey: 'wash1-1784649014864123',
            severity: 'warning',
            reason: 'User reported abuse',
        };

        try {
            render(
                <ThreatReviewModal
                    threat={reportThreat}
                    members={mockMembers}
                    onClose={handleClose}
                    onFreezePubkeys={handleFreeze}
                    onDismiss={handleDismiss}
                />
            );

            expect(screen.getByText('USER REPORTED ABUSE')).toBeInTheDocument();

            await act(async () => {
                fireEvent.click(screen.getByText('🛑 Freeze Accounts'));
            });
            expect(handleFreeze).toHaveBeenCalledWith(['wash1-1784649014864123']);

            act(() => {
                vi.advanceTimersByTime(1200);
            });

            expect(handleClose).toHaveBeenCalledTimes(1);
            expect(handleDismiss).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a failed freeze shows the error, stays open and neither closes nor dismisses', async () => {
        vi.useFakeTimers();
        const handleFreeze = vi.fn().mockRejectedValue(new Error('HTTP 500: Internal Server Error'));
        const handleDismiss = vi.fn();
        const handleClose = vi.fn();
        try {
            render(
                <ThreatReviewModal
                    threat={{ id: 'r1', isReport: true, targetPubkey: 'wash1-1784649014864123', reason: 'spam' }}
                    members={mockMembers}
                    onClose={handleClose}
                    onFreezePubkeys={handleFreeze}
                    onDismiss={handleDismiss}
                />
            );
            await act(async () => {
                fireEvent.click(screen.getByText('🛑 Freeze Accounts'));
            });
            expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
            expect(screen.queryByText(/Member access rights frozen/)).not.toBeInTheDocument();
            act(() => {
                vi.advanceTimersByTime(5000);
            });
            expect(handleClose).not.toHaveBeenCalled();
            expect(handleDismiss).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('freezing for a security alert (not a report) still dismisses the alert', async () => {
        vi.useFakeTimers();
        const handleDismiss = vi.fn();
        const alert: ThreatItem = { type: 'WASH TRADING', description: 'Suspicious activity for wash1-1784649014864123' };
        try {
            render(
                <ThreatReviewModal
                    threat={alert}
                    members={mockMembers}
                    onClose={vi.fn()}
                    onFreezePubkeys={vi.fn().mockResolvedValue(undefined)}
                    onDismiss={handleDismiss}
                />
            );
            await act(async () => {
                fireEvent.click(screen.getByText('🛑 Freeze Accounts'));
            });
            act(() => {
                vi.advanceTimersByTime(1200);
            });
            expect(handleDismiss).toHaveBeenCalledWith(alert);
        } finally {
            vi.useRealTimers();
        }
    });

    it('triggers onInspectMember when clicking a targeted member', async () => {
        const handleInspect = vi.fn();
        const threatWithKeys: ThreatItem = {
            description: 'Suspicious activity for wash1-1784649014864123',
        };

        render(
            <ThreatReviewModal
                threat={threatWithKeys}
                members={mockMembers}
                onClose={vi.fn()}
                onInspectMember={handleInspect}
            />
        );

        await userEvent.click(screen.getByText('Alice Wash'));
        expect(handleInspect).toHaveBeenCalledWith(mockMembers[0]);
    });

    it('exports evidence packet to clipboard when Export Evidence is clicked', async () => {
        vi.useFakeTimers();
        const writeTextMock = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: writeTextMock },
            writable: true,
            configurable: true,
        });

        render(
            <ThreatReviewModal
                threat={mockThreat}
                members={mockMembers}
                onClose={vi.fn()}
            />
        );

        act(() => {
            fireEvent.click(screen.getByText('📄 Export Evidence'));
        });

        expect(writeTextMock).toHaveBeenCalled();
        expect(screen.getByText('📋 Copied!')).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        vi.useRealTimers();
    });
});
