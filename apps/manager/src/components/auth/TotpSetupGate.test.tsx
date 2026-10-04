import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TotpSetupGate, TOTP_GATE_SENTENCE } from './TotpSetupGate';
import { resolveNodeApiUrl } from '../../lib/node-client';

describe('TotpSetupGate', () => {
    const nodeUrl = 'https://test-node.beanpool.org';
    let onDone: ReturnType<typeof vi.fn>;
    let onSignOut: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        onDone = vi.fn();
        onSignOut = vi.fn();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders initial setup gate with notice and start button', () => {
        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        expect(screen.getByRole('heading', { name: 'Two-factor sign-in' })).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent(TOTP_GATE_SENTENCE);
        expect(screen.getByRole('button', { name: 'Set up two-factor sign-in' })).toBeInTheDocument();
    });

    it('calls onSignOut when sign out button is clicked', async () => {
        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        const signOutBtn = screen.getByRole('button', { name: 'Sign out' });
        await userEvent.click(signOutBtn);

        expect(onSignOut).toHaveBeenCalledTimes(1);
    });

    it('fetches 2FA setup details and displays QR code, secret, and backup codes', async () => {
        const mockFetch = vi.mocked(globalThis.fetch);
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    secret: 'JBSWY3DPEHPK3PXP',
                    formattedSecret: 'JBSW Y3DP EHPK 3PXP',
                    qrDataUrl: 'data:image/png;base64,fakeqr',
                    backupCodes: ['1234-5678', '8765-4321'],
                }),
                { status: 200 }
            )
        );

        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        const startBtn = screen.getByRole('button', { name: 'Set up two-factor sign-in' });
        await userEvent.click(startBtn);

        expect(mockFetch).toHaveBeenCalledWith(
            resolveNodeApiUrl(nodeUrl, '/api/local/admin/2fa/setup'),
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
            })
        );

        await waitFor(() => {
            expect(screen.getByAltText('2FA setup QR code')).toHaveAttribute('src', 'data:image/png;base64,fakeqr');
        });

        expect(screen.getByTestId('totp-gate-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
        expect(screen.getByTestId('totp-gate-backup-codes')).toHaveTextContent('1234-5678');
        expect(screen.getByTestId('totp-gate-backup-codes')).toHaveTextContent('8765-4321');
        expect(screen.getByLabelText(/Type the 6-digit code/i)).toBeInTheDocument();
    });

    it('displays error when setup fetch returns failure', async () => {
        const mockFetch = vi.mocked(globalThis.fetch);
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'Failed to generate 2FA secret' }),
                { status: 400 }
            )
        );

        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        const startBtn = screen.getByRole('button', { name: 'Set up two-factor sign-in' });
        await userEvent.click(startBtn);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Failed to generate 2FA secret');
        });
    });

    it('submits verification code and calls onDone on success', async () => {
        const mockFetch = vi.mocked(globalThis.fetch);
        // First fetch for setup
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    secret: 'JBSWY3DPEHPK3PXP',
                    formattedSecret: 'JBSW Y3DP EHPK 3PXP',
                    backupCodes: [],
                }),
                { status: 200 }
            )
        );

        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        await userEvent.click(screen.getByRole('button', { name: 'Set up two-factor sign-in' }));

        await waitFor(() => {
            expect(screen.getByTestId('totp-gate-secret')).toBeInTheDocument();
        });

        // Second fetch for verification
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ success: true, totpEnabled: true }),
                { status: 200 }
            )
        );

        const codeInput = screen.getByLabelText(/Type the 6-digit code/i);
        await userEvent.type(codeInput, '123456');

        const confirmBtn = screen.getByRole('button', { name: 'Confirm and open Settings' });
        await userEvent.click(confirmBtn);

        expect(mockFetch).toHaveBeenLastCalledWith(
            resolveNodeApiUrl(nodeUrl, '/api/local/admin/2fa/verify'),
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                body: JSON.stringify({ code: '123456' }),
            })
        );

        await waitFor(() => {
            expect(onDone).toHaveBeenCalledTimes(1);
        });
    });

    it('displays error alert when verification code fails', async () => {
        const mockFetch = vi.mocked(globalThis.fetch);
        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    secret: 'JBSWY3DPEHPK3PXP',
                    formattedSecret: 'JBSW Y3DP EHPK 3PXP',
                    backupCodes: [],
                }),
                { status: 200 }
            )
        );

        render(<TotpSetupGate nodeUrl={nodeUrl} onDone={onDone} onSignOut={onSignOut} />);

        await userEvent.click(screen.getByRole('button', { name: 'Set up two-factor sign-in' }));

        await waitFor(() => {
            expect(screen.getByTestId('totp-gate-secret')).toBeInTheDocument();
        });

        mockFetch.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'Invalid authenticator code' }),
                { status: 400 }
            )
        );

        const codeInput = screen.getByLabelText(/Type the 6-digit code/i);
        await userEvent.type(codeInput, '000000');

        const confirmBtn = screen.getByRole('button', { name: 'Confirm and open Settings' });
        await userEvent.click(confirmBtn);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Invalid authenticator code');
        });
        expect(onDone).not.toHaveBeenCalled();
    });
});
