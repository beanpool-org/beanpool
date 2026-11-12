import { act, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunityShapeModal } from './CommunityShapeModal';
import type { CommunityShapeFeatures } from '@beanpool/core';

describe('CommunityShapeModal', () => {
    const FULL_FEATURES: CommunityShapeFeatures = {
        door: 'members',
        knocks: true,
        privatePreview: true,
        beans: true,
        knownFloor: 100000,
        dmRequests: true,
        decisions: true,
        probation: true,
        autoHideReports: true,
        autoMute: true,
    };

    it('does not render when isOpen is false', () => {
        render(<CommunityShapeModal isOpen={false} onClose={vi.fn()} features={FULL_FEATURES} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders modal dialog with header, close button, bold lines, and guide button', () => {
        const onClose = vi.fn();
        const onOpenGuide = vi.fn();
        render(<CommunityShapeModal isOpen={true} onClose={onClose} features={FULL_FEATURES} onOpenGuide={onOpenGuide} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();

        // Check bold elements and content
        expect(screen.getByText('Joining:')).toBeInTheDocument();
        expect(screen.getByText('Private preview:')).toBeInTheDocument();
        expect(screen.getByText('Beans:')).toBeInTheDocument();
        expect(screen.getByText('Confirmed members')).toBeInTheDocument();
        expect(screen.getByText('Messages:')).toBeInTheDocument();
        expect(screen.getByText('Decisions:')).toBeInTheDocument();
        expect(screen.getByText('New accounts:')).toBeInTheDocument();
        expect(screen.getByText('Reported posts')).toBeInTheDocument();
        expect(screen.getByText('Repeat offenders')).toBeInTheDocument();

        // Close button touch target
        const closeBtn = screen.getByTestId('community-shape-close');
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');

        // Click Read more in guide
        const readMoreBtn = screen.getByTestId('community-shape-read-more');
        expect(readMoreBtn).toHaveTextContent('Read more in the guide');
        fireEvent.click(readMoreBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onOpenGuide).toHaveBeenCalledTimes(1);
    });

    it('handles Escape key press', () => {
        const onClose = vi.fn();
        render(<CommunityShapeModal isOpen={true} onClose={onClose} features={FULL_FEATURES} />);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    describe('the rule, on "How this community works"', () => {
        // Beans on: who sees each balance, then the admins' list (credit sight C1, core knownRuleLine).
        const SOURCE = "People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded. The admins also keep a list of confirmed members who owe more than half their credit line, or are in debit and haven't made a sale for 60 days.";
        const stubRule = (rule: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rule), { status: rule ? 200 : 404, headers: { 'Content-Type': 'application/json' } })));
        afterEach(() => vi.unstubAllGlobals());

        it('states it right under the floor, in the numbers features carries, with nothing to tap', async () => {
            stubRule({ known: true, knownFloor: 100000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null });
            render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{ ...FULL_FEATURES, debtLinePct: 50, quietDays: 60 }} />);
            const line = screen.getByText(SOURCE);
            expect(line.previousElementSibling?.textContent).toMatch(/\(the known floor\)/);
            expect(screen.getByRole('dialog').querySelector('input')).toBeNull();
            expect(screen.getAllByRole('button').map(b => b.getAttribute('data-testid'))).toEqual(['community-shape-close', 'community-shape-read-more']);
        });

        it('a tightened line says when it applies, from the public route', async () => {
            stubRule({ known: true, knownFloor: 100000, debtLinePct: 30, quietDays: 60, debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: null });
            render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{ ...FULL_FEATURES, debtLinePct: 30, quietDays: 60 }} />);
            expect(await screen.findByText('The line of 30% applies from 16 November.')).toBeInTheDocument();
        });

        it('an older node states no lines: the floor stays, no rule line, and nothing is asked', async () => {
            stubRule(null);
            render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{ door: 'members', beans: true }} />);
            await act(async () => { await new Promise(r => setTimeout(r, 20)); });
            expect(screen.queryByText(SOURCE)).toBeNull();
            expect(fetch).not.toHaveBeenCalled();
        });

        it('a node with the floor but no lines: the floor line alone, and an answer of 404 changes nothing', async () => {
            stubRule(null);
            render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={FULL_FEATURES} />);
            expect(await screen.findByText('Confirmed members')).toBeInTheDocument();
            await new Promise(r => setTimeout(r, 0));
            expect(screen.queryByText(/admins can see/)).toBeNull();
        });
    });

    it('says who decides a removal when a member\'s read carries the rule (removal jury J3), as the phone does', () => {
        const { unmount } = render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{ ...FULL_FEATURES, removalDecider: 'jury' }} />);
        expect(screen.getByText('Removals:')).toBeInTheDocument();
        expect(screen.getByRole('dialog').textContent).toContain('decided by a jury drawn at random; while fewer than 36 members could serve on one, by everyone who can vote');
        unmount();
        render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={FULL_FEATURES} />);
        expect(screen.queryByText('Removals:')).not.toBeInTheDocument();
    });

    it('handles old node that says nothing gracefully', () => {
        render(<CommunityShapeModal isOpen={true} onClose={vi.fn()} features={{}} />);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();
        expect(screen.getByTestId('community-shape-read-more')).toBeInTheDocument();
        expect(screen.queryByText('Joining:')).not.toBeInTheDocument();
    });
});
