import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminLoginCard } from './AdminLoginCard';

// These tests are about the password form on a node that has an owner. The claim check (useClaimState) answers that
// without a request, so each test's fetch mock sees only the password sign-in. AdminLoginCard.claim.test.tsx covers
// the check itself.
vi.mock('../../lib/node-claim', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/node-claim')>()),
    fetchClaimState: vi.fn(async () => ({ kind: 'claimed' })),
}));

describe('AdminLoginCard component', () => {
    const mockOnPasswordSession = vi.fn();
    const nodeUrl = 'http://localhost:3000';

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        localStorage.clear();
    });

    /** Every key and value this origin's web storage holds. */
    function storedText(): string {
        const out: string[] = [];
        for (const store of [sessionStorage, localStorage]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i)!;
                out.push(`${key}=${store.getItem(key)}`);
            }
        }
        return out.join('\n');
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders admin password input and unlock button', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        expect(screen.getByText('Node Settings')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Unlock Settings/i })).toBeInTheDocument();
    });

    it('shows error if submitted with empty password', async () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        const form = screen.getByRole('button', { name: /Unlock Settings/i }).closest('form')!;
        fireEvent.submit(form);
        expect(await screen.findByText('Please enter the admin password')).toBeInTheDocument();
        expect(mockOnPasswordSession).not.toHaveBeenCalled();
    });

    it('toggles password field visibility when Show/Hide is clicked', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        const passwordInput = screen.getByPlaceholderText('Password') as HTMLInputElement;
        const toggleBtn = screen.getByRole('button', { name: 'Show' });

        expect(passwordInput.type).toBe('password');
        fireEvent.click(toggleBtn);
        expect(passwordInput.type).toBe('text');
        expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    });

    it('keeps the Show/Hide button beside the password input rather than drawn over it', () => {
        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        const field = screen.getByTestId('admin-password-field');
        const passwordInput = screen.getByPlaceholderText('Password');
        const toggleBtn = screen.getByRole('button', { name: 'Show' });

        // Siblings in one flex row: the input shrinks, the button keeps its own space.
        expect(field).toHaveClass('flex');
        expect(passwordInput.parentElement).toBe(field);
        expect(toggleBtn.parentElement).toBe(field);
        expect(passwordInput).toHaveClass('flex-1', 'min-w-0');
        expect(toggleBtn).toHaveClass('shrink-0');
        expect(toggleBtn.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    });

    it('exchanges the password for the node\'s session cookie and keeps no copy of it anywhere in web storage', async () => {
        // Until 2026-10-01 this test asserted the opposite: the password and its 2FA session in sessionStorage, on the
        // origin the members' web app shares (Fable's web review, M1).
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, role: 'owner', csrfToken: 'csrf-xyz' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        fireEvent.change(screen.getByPlaceholderText('Password'), {
            target: { value: 'correct-password' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        await waitFor(() => {
            expect(mockOnPasswordSession).toHaveBeenCalledWith('csrf-xyz', false);
        });
        // One request, to the session sign-in, carrying the password in its body and nowhere else.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(String(url)).toMatch(/\/api\/local\/admin\/auth\/password$/);
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(JSON.parse(init.body)).toEqual({ password: 'correct-password' });
        expect(JSON.stringify(init.headers)).not.toContain('correct-password');
        // Nothing of it is left on the origin.
        expect(storedText()).not.toContain('correct-password');
        expect(sessionStorage.getItem('bp-admin-token')).toBeNull();
        expect(sessionStorage.getItem('bp-2fa-session')).toBeNull();
        // And the form no longer holds it either.
        expect(mockOnPasswordSession.mock.calls[0]).not.toContain('correct-password');
    });

    it('prompts for 2FA TOTP code when server returns 401 with totpRequired', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: async () => ({ error: '2FA code required', totpRequired: true }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ success: true, role: 'owner', csrfToken: 'csrf-after-totp' }),
            });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        fireEvent.change(screen.getByPlaceholderText('Password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByText('2FA is enabled. Please enter your 6-digit TOTP code.')).toBeInTheDocument();
        const totpInput = screen.getByPlaceholderText('6-digit code (e.g. 123456)');
        expect(totpInput).toBeInTheDocument();

        fireEvent.change(totpInput, { target: { value: '654321' } });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        await waitFor(() => {
            expect(mockOnPasswordSession).toHaveBeenCalledWith('csrf-after-totp', false);
        });
        expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ password: 'password123', totpCode: '654321' });
        expect(storedText()).not.toContain('password123');
    });

    it('displays error message when server returns an authentication failure', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Invalid admin credentials' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        render(<AdminLoginCard nodeUrl={nodeUrl} onPasswordSession={mockOnPasswordSession} />);
        fireEvent.change(screen.getByPlaceholderText('Password'), {
            target: { value: 'wrong-pass' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Unlock Settings/i }));

        expect(await screen.findByText('Invalid admin credentials')).toBeInTheDocument();
        expect(mockOnPasswordSession).not.toHaveBeenCalled();
    });
});
