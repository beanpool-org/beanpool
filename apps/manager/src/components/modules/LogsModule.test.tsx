import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { LogsModule, LogEntry } from './LogsModule';

describe('LogsModule', () => {
    const mockLogs: LogEntry[] = [
        {
            timestamp: '2026-08-25T10:00:00Z',
            level: 'INFO',
            message: 'System started successfully',
        },
        {
            timestamp: '2026-08-25T10:05:00Z',
            level: 'WARN',
            message: 'High memory usage detected',
        },
        {
            timestamp: '2026-08-25T10:10:00Z',
            level: 'ERROR',
            message: 'Failed to connect to peer node',
        },
    ];

    it('renders empty logs state when no logs are provided', () => {
        render(<LogsModule logs={[]} onRefresh={vi.fn()} />);

        expect(screen.getByText('No log entries captured yet')).toBeInTheDocument();
        expect(
            screen.getByText(/There are no log records recorded on this node/i)
        ).toBeInTheDocument();
    });

    it('renders log entries with level badges and timestamps', () => {
        render(<LogsModule logs={mockLogs} onRefresh={vi.fn()} />);

        expect(screen.getByText('System started successfully')).toBeInTheDocument();
        expect(screen.getByText('High memory usage detected')).toBeInTheDocument();
        expect(screen.getByText('Failed to connect to peer node')).toBeInTheDocument();

        expect(screen.getAllByText('INFO').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('WARN').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('ERROR').length).toBeGreaterThanOrEqual(1);
    });

    it('calls onRefresh when Refresh Stream button is clicked', async () => {
        const handleRefresh = vi.fn();
        render(<LogsModule logs={mockLogs} onRefresh={handleRefresh} />);

        const refreshBtn = screen.getByRole('button', { name: /Refresh Stream/i });
        await userEvent.click(refreshBtn);

        expect(handleRefresh).toHaveBeenCalledTimes(1);
    });

    it('filters logs by selected level', async () => {
        render(<LogsModule logs={mockLogs} onRefresh={vi.fn()} />);

        const levelSelect = screen.getByRole('combobox');
        fireEvent.change(levelSelect, { target: { value: 'ERROR' } });

        expect(screen.getByText('Failed to connect to peer node')).toBeInTheDocument();
        expect(screen.queryByText('System started successfully')).not.toBeInTheDocument();
        expect(screen.queryByText('High memory usage detected')).not.toBeInTheDocument();
    });

    it('filters logs by search query input', async () => {
        render(<LogsModule logs={mockLogs} onRefresh={vi.fn()} />);

        const searchInput = screen.getByPlaceholderText('Search log messages...');
        await userEvent.type(searchInput, 'memory');

        expect(screen.getByText('High memory usage detected')).toBeInTheDocument();
        expect(screen.queryByText('System started successfully')).not.toBeInTheDocument();
        expect(screen.queryByText('Failed to connect to peer node')).not.toBeInTheDocument();
    });

    it('shows message when no logs match applied filter criteria', async () => {
        render(<LogsModule logs={mockLogs} onRefresh={vi.fn()} />);

        const searchInput = screen.getByPlaceholderText('Search log messages...');
        await userEvent.type(searchInput, 'nonexistent string');

        expect(
            screen.getByText('No log records match current filters.')
        ).toBeInTheDocument();
    });
});
