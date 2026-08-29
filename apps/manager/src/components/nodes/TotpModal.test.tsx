import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TotpModal } from './TotpModal';

describe('TotpModal Component', () => {
    const defaultProps = {
        nodeName: 'Test Node Alpha',
        onClose: vi.fn(),
        onSubmit: vi.fn(),
    };

    it('renders correctly with node name', () => {
        render(<TotpModal {...defaultProps} />);

        expect(screen.getByRole('heading', { name: /two-factor auth required/i })).toBeInTheDocument();
        expect(screen.getByText('Test Node Alpha')).toBeInTheDocument();
        expect(screen.getByLabelText(/authenticator code/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /verify & connect/i })).toBeDisabled();
    });

    it('filters non-numeric characters and updates code value', () => {
        render(<TotpModal {...defaultProps} />);

        const input = screen.getByLabelText(/authenticator code/i) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '12abc345' } });

        expect(input.value).toBe('12345');
    });

    it('enables verify button when 6 digits are entered and submits correctly', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(<TotpModal {...defaultProps} onSubmit={onSubmit} />);

        const input = screen.getByLabelText(/authenticator code/i);
        const submitButton = screen.getByRole('button', { name: /verify & connect/i });

        expect(submitButton).toBeDisabled();

        fireEvent.change(input, { target: { value: '123456' } });
        expect(submitButton).not.toBeDisabled();

        fireEvent.click(submitButton);

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith('123456');
        });
    });

    it('displays error message when error prop is provided', () => {
        render(<TotpModal {...defaultProps} error="Invalid 2FA code provided" />);

        expect(screen.getByRole('alert')).toHaveTextContent('Invalid 2FA code provided');
    });

    it('calls onClose when Cancel button or Close button is clicked', () => {
        const onClose = vi.fn();
        render(<TotpModal {...defaultProps} onClose={onClose} />);

        const cancelButton = screen.getByRole('button', { name: /cancel/i });
        fireEvent.click(cancelButton);
        expect(onClose).toHaveBeenCalledTimes(1);

        const closeButton = screen.getByRole('button', { name: /close/i });
        fireEvent.click(closeButton);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('calls onClose when Escape key is pressed', () => {
        const onClose = vi.fn();
        const { container } = render(<TotpModal {...defaultProps} onClose={onClose} />);

        const overlay = container.firstChild as HTMLElement;
        fireEvent.keyDown(overlay, { key: 'Escape' });

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
