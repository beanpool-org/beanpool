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
    adminPassword: 'pass123',
    status: 'online' as const,
};

describe('EditNodeModal', () => {
    it('renders input fields pre-populated with node profile data', () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        expect(screen.getByText('Configure Node Credentials')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Primary Node')).toBeInTheDocument();
        expect(screen.getByDisplayValue('https://primary.beanpool.org')).toBeInTheDocument();
        expect(screen.getByDisplayValue('pass123')).toBeInTheDocument();
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

    it('toggles password visibility when eye button is clicked', async () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        const passwordInput = screen.getByDisplayValue('pass123');
        expect(passwordInput).toHaveAttribute('type', 'password');

        await userEvent.click(screen.getByTitle('Show password'));
        expect(passwordInput).toHaveAttribute('type', 'text');

        await userEvent.click(screen.getByTitle('Hide password'));
        expect(passwordInput).toHaveAttribute('type', 'password');
    });

    it('submits updated values when save button is clicked', async () => {
        const handleClose = vi.fn();
        const handleSave = vi.fn();
        render(<EditNodeModal node={sampleNode} onClose={handleClose} onSave={handleSave} />);

        const nameInput = screen.getByDisplayValue('Primary Node');
        const urlInput = screen.getByDisplayValue('https://primary.beanpool.org');
        const passwordInput = screen.getByDisplayValue('pass123');

        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, 'Updated Node Name');
        await userEvent.clear(urlInput);
        await userEvent.type(urlInput, 'https://node2.beanpool.org');
        await userEvent.clear(passwordInput);
        await userEvent.type(passwordInput, 'newpassword');

        await userEvent.click(screen.getByText('Save Settings'));

        expect(handleSave).toHaveBeenCalledWith('node-1', {
            name: 'Updated Node Name',
            url: 'https://node2.beanpool.org',
            adminPassword: 'newpassword',
        });
        expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('tests connection successfully when test button is clicked', async () => {
        const fetchDiagSpy = vi.spyOn(nodeClient, 'fetchDiagnostics').mockResolvedValueOnce({
            status: 'ok',
            communityName: 'Test Community',
        } as any);

        render(<EditNodeModal node={sampleNode} onClose={vi.fn()} onSave={vi.fn()} />);

        await userEvent.click(screen.getByText('⚡ Test Connection'));

        expect(fetchDiagSpy).toHaveBeenCalledWith('https://primary.beanpool.org', 'pass123');
        expect(await screen.findByText(/✅ Connection OK! Status: OK \(Test Community\)/)).toBeInTheDocument();
    });

    it('displays error status when test connection fails', async () => {
        vi.spyOn(nodeClient, 'fetchDiagnostics').mockRejectedValueOnce(new Error('Network request failed'));

        render(<EditNodeModal node={sampleNode} onClose={vi.fn()} onSave={vi.fn()} />);

        await userEvent.click(screen.getByText('⚡ Test Connection'));

        expect(await screen.findByText(/❌ Connection Error: Network request failed/)).toBeInTheDocument();
    });
});
