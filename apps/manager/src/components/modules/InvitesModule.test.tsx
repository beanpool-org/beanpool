import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
            'standard'
        );
        expect(screen.getAllByText('INV-API-PASS-1').length).toBeGreaterThan(0);
    });

    it('falls back to local invite code generation when API fails or returns no code', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error('Network error'));

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });

        const codeElement = screen.getByText(/^INV-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        expect(codeElement).toBeInTheDocument();
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
            'trusted'
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

        const closeBtn = screen.getByRole('button', { name: '✕' });
        await userEvent.click(closeBtn);

        expect(screen.queryByText('SINGLE-USE ONBOARDING PASS')).not.toBeInTheDocument();
    });
});
