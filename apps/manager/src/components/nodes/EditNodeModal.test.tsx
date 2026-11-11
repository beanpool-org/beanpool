import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { EditNodeModal } from './EditNodeModal';
import * as nodeClient from '../../lib/node-client';

const sampleNode = {
    id: 'node-1',
    name: 'Primary Node',
    url: 'https://primary.beanpool.org',
    status: 'online' as const,
};

/** An owner automation token (bp_ + 12 hex + _ + 64 hex): a profile's one credential. */
const TOKEN = `bp_${'c3'.repeat(6)}_${'9d'.repeat(32)}`;

describe('EditNodeModal', () => {
    it('renders input fields pre-populated with node profile data', () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        expect(screen.getByText('Configure Node Credentials')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Primary Node')).toBeInTheDocument();
        expect(screen.getByDisplayValue('https://primary.beanpool.org')).toBeInTheDocument();
        // There is no field to type a password into: a profile's credential is its token.
        expect(screen.queryByText(/Admin Password/i)).toBeNull();
        expect(screen.queryByPlaceholderText(/password/i)).toBeNull();
        expect(screen.getByLabelText('Automation token')).toBeInTheDocument();
        expect(screen.getByLabelText('Automation token')).toHaveDisplayValue('');
    });

    it('calls onClose when close icon or cancel button is clicked', async () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        await userEvent.click(screen.getByText('✕'));
        expect(handleClose).toHaveBeenCalledTimes(1);

        await userEvent.click(screen.getByText('Cancel'));
        expect(handleClose).toHaveBeenCalledTimes(2);
    });

    it('submits updated values when save button is clicked, with no token when none was typed', async () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        const nameInput = screen.getByDisplayValue('Primary Node');
        const urlInput = screen.getByDisplayValue('https://primary.beanpool.org');

        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Updated Node Name');
        await userEvent.clear(urlInput);
        await userEvent.type(urlInput, 'https://node2.beanpool.org');

        await userEvent.click(screen.getByText('Save Settings'));

        expect(handleSave).toHaveBeenCalledWith('node-1', {
            name: 'Updated Node Name',
            url: 'https://node2.beanpool.org',
            automationToken: undefined,
        });
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('tests connection successfully when test button is clicked, sending the profile\'s token', async () => {
        const fetchDiagSpy = vi.spyOn(nodeClient, 'fetchDiagnostics').mockResolvedValueOnce({
            status: 'ok',
            communityName: 'Test Community',
        } as any);

        render(<EditNodeModal node={{ ...sampleNode, automationToken: TOKEN }} onClose={vi.fn()} onSave={vi.fn()} />);

        await userEvent.click(screen.getByText('⚡ Test Connection'));

        expect(fetchDiagSpy).toHaveBeenCalledWith('https://primary.beanpool.org', TOKEN);
        expect(await screen.findByText(/✅ Connection OK! Status: OK \(Test Community\)/)).toBeInTheDocument();
    });

    it('tests connection with no credential when the profile has no token, whatever else the object carries', async () => {
        const fetchDiagSpy = vi.spyOn(nodeClient, 'fetchDiagnostics').mockResolvedValueOnce({
            status: 'ok',
            communityName: 'Test Community',
        } as any);

        // A profile object from before the password was removed may still carry one; it is never taken as a credential.
        render(<EditNodeModal node={{ ...sampleNode, adminPassword: 'pass123' } as never} onClose={vi.fn()} onSave={vi.fn()} />);

        await userEvent.click(screen.getByText('⚡ Test Connection'));

        expect(fetchDiagSpy).toHaveBeenCalledWith('https://primary.beanpool.org', undefined);
        expect(await screen.findByText(/✅ Connection OK!/)).toBeInTheDocument();
    });

    it('displays error status when test connection fails', async () => {
        vi.spyOn(nodeClient, 'fetchDiagnostics').mockRejectedValueOnce(new Error('Network request failed'));

        render(<EditNodeModal node={sampleNode} onClose={vi.fn()} onSave={vi.fn()} />);

        await userEvent.click(screen.getByText('⚡ Test Connection'));

        expect(await screen.findByText(/❌ Connection Error: Network request failed/)).toBeInTheDocument();
    });
});
