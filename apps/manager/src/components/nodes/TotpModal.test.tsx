import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TotpModal } from './TotpModal';

describe('TotpModal Component', () => {
    it('renders modal content with node name and input label', () => {
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={vi.fn()}
                onSubmit={vi.fn()}
            />
        );

        expect(screen.getByText('Two-Factor Auth Required')).toBeInTheDocument();
        expect(screen.getByText('Node Alpha')).toBeInTheDocument();
        expect(screen.getByLabelText('Authenticator Code')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /verify & connect/i })).toBeDisabled();
    });

    it('renders error message when error prop is provided', () => {
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={vi.fn()}
                onSubmit={vi.fn()}
                error="Invalid authenticator code"
            />
        );

        const alert = screen.getByRole('alert');
        expect(alert).toBeInTheDocument();
        expect(alert).toHaveTextContent('Invalid authenticator code');
    });

    it('disables submit button for invalid code and enables for 6-digit numeric code', () => {
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={vi.fn()}
                onSubmit={vi.fn()}
            />
        );

        const input = screen.getByLabelText('Authenticator Code');
        const submitButton = screen.getByRole('button', { name: /verify & connect/i });

        fireEvent.change(input, { target: { value: '123' } });
        expect(submitButton).toBeDisabled();

        fireEvent.change(input, { target: { value: '123456' } });
        expect(submitButton).not.toBeDisabled();
    });

    it('calls onSubmit with cleaned 6-digit code when form is submitted', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={vi.fn()}
                onSubmit={onSubmit}
            />
        );

        const input = screen.getByLabelText('Authenticator Code');
        const submitButton = screen.getByRole('button', { name: /verify & connect/i });

        fireEvent.change(input, { target: { value: '654321' } });
        await act(async () => {
            fireEvent.click(submitButton);
        });

        expect(onSubmit).toHaveBeenCalledWith('654321');
    });

    it('calls onClose when clicking Cancel button', () => {
        const onClose = vi.fn();
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={onClose}
                onSubmit={vi.fn()}
            />
        );

        const cancelButton = screen.getByRole('button', { name: /cancel/i });
        fireEvent.click(cancelButton);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when clicking Close icon button', () => {
        const onClose = vi.fn();
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={onClose}
                onSubmit={vi.fn()}
            />
        );

        const closeIconButton = screen.getByRole('button', { name: /close/i });
        fireEvent.click(closeIconButton);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when pressing Escape key', () => {
        const onClose = vi.fn();
        render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={onClose}
                onSubmit={vi.fn()}
            />
        );

        const title = screen.getByText('Two-Factor Auth Required');
        fireEvent.keyDown(title.parentElement!.parentElement!.parentElement!, { key: 'Escape' });

        expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when clicking outer backdrop container', () => {
        const onClose = vi.fn();
        const { container } = render(
            <TotpModal
                nodeName="Node Alpha"
                onClose={onClose}
                onSubmit={vi.fn()}
            />
        );

        const overlay = container.firstChild as HTMLElement;
        fireEvent.click(overlay);

        expect(onClose).toHaveBeenCalled();
    });
});
