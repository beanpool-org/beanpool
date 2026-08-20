import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CommonsInfoModal } from './CommonsInfoModal';

describe('CommonsInfoModal', () => {
    it('renders null when isOpen is false', () => {
        const { container } = render(
            <CommonsInfoModal isOpen={false} onClose={vi.fn()} />
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders modal header and default tab content when isOpen is true', () => {
        render(<CommonsInfoModal isOpen={true} onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { name: /Community Commons/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Close information modal/i })).toBeInTheDocument();
        expect(screen.getByText(/The Community Commons is a self-sustaining fund/i)).toBeInTheDocument();
        expect(screen.getByText(/100% Community-Owned/i)).toBeInTheDocument();
    });

    it('renders commons balance when provided', () => {
        render(
            <CommonsInfoModal isOpen={true} onClose={vi.fn()} commonsBalance={123.456} />
        );

        expect(screen.getByText('Current Commons Balance')).toBeInTheDocument();
        expect(screen.getByText('123.46 🫘')).toBeInTheDocument();
    });

    it('does not render commons balance section when commonsBalance is undefined', () => {
        render(<CommonsInfoModal isOpen={true} onClose={vi.fn()} />);

        expect(screen.queryByText('Current Commons Balance')).not.toBeInTheDocument();
    });

    it('switches to Circulation Fees tab and renders bracket information', () => {
        render(<CommonsInfoModal isOpen={true} onClose={vi.fn()} />);

        const bracketsTabButton = screen.getByRole('button', { name: /Circulation Fees/i });
        fireEvent.click(bracketsTabButton);

        expect(screen.getByText(/progressive monthly contribution/i)).toBeInTheDocument();
        expect(screen.getByText(/0–200 🫘/)).toBeInTheDocument();
        expect(screen.getByText(/2000\+ 🫘/)).toBeInTheDocument();
        expect(screen.getByText(/4\.5 🫘\/month/)).toBeInTheDocument();
    });

    it('switches to Voting tab and renders Quadratic Voting information', () => {
        render(<CommonsInfoModal isOpen={true} onClose={vi.fn()} />);

        const qvTabButton = screen.getByRole('button', { name: /Voting/i });
        fireEvent.click(qvTabButton);

        expect(screen.getByText(/Quadratic Voting/i)).toBeInTheDocument();
        expect(screen.getByText('Cost = Votes²')).toBeInTheDocument();
        expect(screen.getByText((_content, element) => element?.tagName.toLowerCase() === 'span' && element.textContent === '5 votes')).toBeInTheDocument();
        expect(screen.getByText('25 credits')).toBeInTheDocument();
    });

    it('calls onClose when close button or backdrop is clicked', () => {
        const onCloseMock = vi.fn();
        render(<CommonsInfoModal isOpen={true} onClose={onCloseMock} />);

        const closeBtn = screen.getByRole('button', { name: /Close information modal/i });
        fireEvent.click(closeBtn);
        expect(onCloseMock).toHaveBeenCalledTimes(1);

        const heading = screen.getByRole('heading', { name: /Community Commons/i });
        const backdrop = heading.closest('.fixed');
        expect(backdrop).not.toBeNull();
        if (backdrop) {
            fireEvent.click(backdrop);
            expect(onCloseMock).toHaveBeenCalledTimes(2);
        }
    });

    it('does not trigger onClose when modal body content is clicked', () => {
        const onCloseMock = vi.fn();
        render(<CommonsInfoModal isOpen={true} onClose={onCloseMock} />);

        const heading = screen.getByRole('heading', { name: /Community Commons/i });
        const modalContainer = heading.closest('.relative');
        expect(modalContainer).not.toBeNull();
        if (modalContainer) {
            fireEvent.click(modalContainer);
            expect(onCloseMock).not.toHaveBeenCalled();
        }
    });
});
