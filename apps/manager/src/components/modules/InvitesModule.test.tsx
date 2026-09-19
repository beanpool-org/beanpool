import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvitesModule } from './InvitesModule';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        generateNodeInvite: vi.fn(),
    };
});

describe('InvitesModule', () => {
    const mockNode: NodeProfile = {
        id: 'node-1',
        name: 'Test Node',
        url: 'https://test-node.beanpool.org',
        adminPassword: 'secretpassword',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(navigator, {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(undefined),
            },
        });
        vi.spyOn(window, 'open').mockImplementation(() => ({
            document: {
                write: vi.fn(),
                close: vi.fn(),
            },
        } as unknown as Window));
    });

    it('renders initial form state and empty pass state', () => {
        render(<InvitesModule activeNode={mockNode} />);

        expect(screen.getByText('🎟️ Sovereign Node Invite Generator')).toBeInTheDocument();
        expect(screen.getByText('Test Node')).toBeInTheDocument();
        expect(screen.getByText('No Passes Generated Yet')).toBeInTheDocument();
        expect(screen.getByText('Generate 5 Passes')).toBeInTheDocument();
    });

    it('generates invite passes successfully via node API', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-API-PASS-1',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const generateBtn = screen.getByRole('button', { name: /Generate 5 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (5)')).toBeInTheDocument();
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(5);
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            'https://test-node.beanpool.org',
            'secretpassword',
            'standard',
            undefined
        );
        expect(screen.getAllByText('INV-API-PASS-1').length).toBeGreaterThan(0);
    });

    // This used to assert that a made-up INV-XXXX-XXXX code appeared when the node refused. Owners printed those
    // codes on cards and they never worked. A refusal must show the node's reason and no code at all.
    it('shows the node\'s reason and no code, QR or print button when the node refuses', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error('Invalid password'));

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('No invites were made');
        expect(alert).toHaveTextContent('Invalid password');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

        expect(screen.queryByText(/Generated Passes/)).not.toBeInTheDocument();
        expect(screen.queryByText(/INV-/)).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /QR Code/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Print/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Copy/i })).not.toBeInTheDocument();
    });

    it('retry after a refusal shows only the codes the node issued', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockRejectedValueOnce(new Error('Only an owner or admin of this node can issue invites'))
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-RETRY', type: 'standard' });

        render(<InvitesModule activeNode={mockNode} />);

        await userEvent.click(screen.getByRole('button', { name: '1' }));
        await userEvent.click(screen.getByRole('button', { name: /Generate 1 Pass/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Only an owner or admin of this node can issue invites');

        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });
        expect(screen.getAllByText('INV-REAL-RETRY').length).toBeGreaterThan(0);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a refusal part-way keeps the real passes, says how many were made, and retries only the rest', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-1', type: 'standard' })
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-2', type: 'standard' })
            .mockRejectedValueOnce(new Error('Too many requests'))
            .mockResolvedValue({ success: true, code: 'INV-REAL-LATER', type: 'standard' });

        render(<InvitesModule activeNode={mockNode} />);

        await userEvent.click(screen.getByRole('button', { name: /Generate 5 Passes/i }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Only 2 of 5 invites were made');
        expect(alert).toHaveTextContent('Too many requests');
        expect(screen.getByText('Generated Passes (2)')).toBeInTheDocument();
        // Stopped at the refusal: no further calls, nothing invented for the other three.
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(3);

        await userEvent.click(screen.getByRole('button', { name: 'Try again for the other 3' }));

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (5)')).toBeInTheDocument();
        });
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(6);
        expect(screen.getAllByText('INV-REAL-1').length).toBeGreaterThan(0);
        expect(screen.getAllByText('INV-REAL-LATER').length).toBe(3);
    });

    it('allows changing quantity and tier options', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-TIER-TEST',
            type: 'trusted',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const select = screen.getByRole('combobox');
        await userEvent.selectOptions(select, 'trusted');

        const count10Btn = screen.getByRole('button', { name: '10' });
        await userEvent.click(count10Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 10 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (10)')).toBeInTheDocument();
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            'https://test-node.beanpool.org',
            'secretpassword',
            'trusted',
            undefined
        );
        expect(screen.getAllByText('🏠 Resident').length).toBeGreaterThan(0);
    });

    it('handles copy operations and enlarged QR preview modal', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-COPY-TEST',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });

        const copyLinkBtn = screen.getByRole('button', { name: 'Copy Link' });
        await userEvent.click(copyLinkBtn);

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            'https://test-node.beanpool.org/?invite=INV-COPY-TEST'
        );
        expect(screen.getByText('✓ Copied')).toBeInTheDocument();

        const enlargeBtn = screen.getByRole('button', { name: 'Enlarge' });
        await userEvent.click(enlargeBtn);

        expect(screen.getByText('SINGLE-USE ONBOARDING PASS')).toBeInTheDocument();

        const closeBtn = screen.getAllByRole('button', { name: 'Close' })[0]; // the ✕ (the footer has a Close button too)
        await userEvent.click(closeBtn);

        expect(screen.queryByText('SINGLE-USE ONBOARDING PASS')).not.toBeInTheDocument();
    });

    it('generates custom N invites with offline SVG QR codes', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-CUSTOM-N',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const customInput = screen.getByLabelText(/custom quantity/i);
        fireEvent.change(customInput, { target: { value: '3' } });

        const generateBtn = screen.getByRole('button', { name: /Generate 3 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (3)')).toBeInTheDocument();
        });

        // Verify images use offline data:image/svg+xml and never external server
        const images = screen.getAllByRole('img', { name: /QR Code for INV-CUSTOM-N/i });
        expect(images.length).toBe(3);
        images.forEach((img) => {
            expect((img as HTMLImageElement).src).toContain('data:image/svg+xml');
            expect((img as HTMLImageElement).src).not.toContain('api.qrserver.com');
        });
    });

    it('renders printable QR sheet modal and triggers print cards window', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-PRINT-1',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });

        // Test on-screen printable sheet modal
        const viewSheetBtn = screen.getByRole('button', { name: /View Printable Sheet/i });
        await userEvent.click(viewSheetBtn);

        expect(screen.getByText(/Printable QR Onboarding Sheet \(1 Passes\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Face-to-face dinner onboarding/i)).toBeInTheDocument();

        // Test print window trigger
        const printBtn = screen.getAllByRole('button', { name: /Print Sheet/i })[0];
        await userEvent.click(printBtn);
        expect(window.open).toHaveBeenCalled();
    });
});

