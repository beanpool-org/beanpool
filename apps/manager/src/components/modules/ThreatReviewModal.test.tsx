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

    it('dispatches freeze action and calls onFreezePubkeys and onDismiss', async () => {
        vi.useFakeTimers();
        const handleFreeze = vi.fn();
        const handleDismiss = vi.fn();
        const reportThreat: ThreatItem = {
            isReport: true,
            targetPubkey: 'wash1-1784649014864123',
            severity: 'warning',
            reason: 'User reported abuse',
        };

        render(
            <ThreatReviewModal
                threat={reportThreat}
                members={mockMembers}
                onClose={vi.fn()}
                onFreezePubkeys={handleFreeze}
                onDismiss={handleDismiss}
            />
        );

        expect(screen.getByText('USER REPORTED ABUSE')).toBeInTheDocument();

        fireEvent.click(screen.getByText('🛑 Freeze Accounts'));
        expect(handleFreeze).toHaveBeenCalledWith(['wash1-1784649014864123']);

        act(() => {
            vi.advanceTimersByTime(1200);
        });

        expect(handleDismiss).toHaveBeenCalledWith(reportThreat);
        vi.useRealTimers();
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
