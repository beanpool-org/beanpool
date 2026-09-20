import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposeDecisionModal } from './ProposeDecisionModal';

vi.mock('../lib/api', () => ({
    createDecision: vi.fn(),
    getBalance: vi.fn().mockResolvedValue({ balance: 10 }),
}));

describe('ProposeDecisionModal Accessibility & UX', () => {
    const mockIdentity = {
        publicKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        privateKey: '0x5678',
        boxPublicKey: '0x1234',
        secretKey: '0x5678',
        callsign: 'Alice',
        createdAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when isOpen is false', () => {
        render(
            <ProposeDecisionModal
                isOpen={false}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders dialog with modal attributes and title linking', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'propose-modal-title');
        expect(screen.getByText('Propose a Community Decision')).toBeInTheDocument();
    });

    it('renders close button with explicit type="button", aria-label, and min touch target', () => {
        const onClose = vi.fn();
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={onClose}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );
        const closeBtn = screen.getByRole('button', { name: 'Close modal' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn).toHaveAttribute('type', 'button');
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
        expect(closeBtn.className).toContain('focus-visible:ring-2');

        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders touch option buttons with aria-pressed state and min touch target height', () => {
        render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );

        const memberBtn = screen.getByRole('button', { name: /Member/i });
        const poolBtn = screen.getByRole('button', { name: /Commons Pool/i });

        expect(memberBtn).toHaveAttribute('aria-pressed', 'true');
        expect(poolBtn).toHaveAttribute('aria-pressed', 'false');
        expect(memberBtn.className).toContain('min-h-[44px]');
        expect(poolBtn.className).toContain('min-h-[44px]');

        fireEvent.click(poolBtn);
        expect(memberBtn).toHaveAttribute('aria-pressed', 'false');
        expect(poolBtn).toHaveAttribute('aria-pressed', 'true');
    });

    it('hides decorative emojis from screen readers with aria-hidden="true"', () => {
        const { container } = render(
            <ProposeDecisionModal
                isOpen={true}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                identity={mockIdentity}
                commonsBalance={100}
            />
        );

        const hiddenEmojis = container.querySelectorAll('span[aria-hidden="true"]');
        expect(hiddenEmojis.length).toBeGreaterThan(0);
    });
});
