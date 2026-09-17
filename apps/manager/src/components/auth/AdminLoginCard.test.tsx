import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminLoginCard } from './AdminLoginCard';

describe('AdminLoginCard component', () => {
    const mockOnAuthenticated = vi.fn();
    const nodeUrl = 'http://localhost:3000';

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders admin password input and unlock button', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        expect(screen.getByText('Node Settings')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Enter node admin password')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
    });

    it('shows error if submitted with empty password', async () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        const form = screen.getByRole('button', { name: /Unlock Settings/i }).closest('form')!;
        fireEvent.submit(form);
        expect(await screen.findByText('Please enter the admin password')).toBeInTheDocument();
        expect(mockOnAuthenticated).not.toHaveBeenCalled();
    });

    it('toggles password field visibility when Show/Hide is clicked', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        const passwordInput = screen.getByPlaceholderText('Enter node admin password') as HTMLInputElement;
        const toggleBtn = screen.getByRole('button', { name: 'Show' });

        expect(passwordInput.type).toBe('password');
        fireEvent.click(toggleBtn);
        expect(passwordInput.type).toBe('text');
        expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    });

    it('keeps the Show/Hide button beside the password input rather than drawn over it', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        const field = screen.getByTestId('admin-password-field');
        const passwordInput = screen.getByPlaceholderText('Enter node admin password');
        const toggleBtn = screen.getByRole('button', { name: 'Show' });

        // Siblings in one flex row: the input shrinks, the button keeps its own space.
        expect(field).toHaveClass('flex');
        expect(passwordInput.parentElement).toBe(field);
        expect(toggleBtn.parentElement).toBe(field);
        expect(passwordInput).toHaveClass('flex-1', 'min-w-0');
        expect(toggleBtn).toHaveClass('shrink-0');
        expect(toggleBtn.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    });

    it('handles successful authentication without 2FA', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ sessionToken: 'session-xyz' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        fireEvent.change(screen.getByPlaceholderText('Enter node admin password'), {
            target: { value: 'correct-password' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        await waitFor(() => {
            expect(mockOnAuthenticated).toHaveBeenCalledWith('correct-password', 'session-xyz');
        });
        expect(sessionStorage.getItem('bp-admin-token')).toBe('correct-password');
        expect(sessionStorage.getItem('bp-2fa-session')).toBe('session-xyz');
    });

    it('prompts for 2FA TOTP code when server returns 401 with totpRequired', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: async () => ({ totpRequired: true }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ sessionToken: 'totp-session-123' }),
            });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        fireEvent.change(screen.getByPlaceholderText('Enter node admin password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByText('2FA is enabled. Please enter your 6-digit TOTP code.')).toBeInTheDocument();
        const totpInput = screen.getByPlaceholderText('6-digit code (e.g. 123456)');
        expect(totpInput).toBeInTheDocument();

        fireEvent.change(totpInput, { target: { value: '654321' } });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        await waitFor(() => {
            expect(mockOnAuthenticated).toHaveBeenCalledWith('password123', 'totp-session-123');
        });
    });

    it('displays error message when server returns an authentication failure', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Invalid admin credentials' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onAuthenticated={mockOnAuthenticated} />);
        fireEvent.change(screen.getByPlaceholderText('Enter node admin password'), {
            target: { value: 'wrong-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByText('Invalid admin credentials')).toBeInTheDocument();
        expect(mockOnAuthenticated).not.toHaveBeenCalled();
    });
});
