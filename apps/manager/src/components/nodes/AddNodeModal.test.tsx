import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AddNodeModal } from './AddNodeModal';

describe('AddNodeModal', () => {
    it('renders input fields and buttons', () => {
        const handleClose = vi.fn();
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={handleClose} onAdd={handleAdd} />);

        expect(screen.getByText('Connect Sovereign Node')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g. Byron Community Node')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('https://node2.beanpool.org or https://localhost:8443')).toBeInTheDocument();
        expect(screen.getByLabelText('Automation token')).toBeInTheDocument();
    });

    it('calls onClose when close button or cancel button is clicked', async () => {
        const handleClose = vi.fn();
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={handleClose} onAdd={handleAdd} />);

        const closeIconBtn = screen.getByText('✕');
        await userEvent.click(closeIconBtn);
        expect(handleClose).toHaveBeenCalledTimes(1);

        const cancelBtn = screen.getByText('Cancel');
        await userEvent.click(cancelBtn);
        expect(handleClose).toHaveBeenCalledTimes(2);
    });

    it('has no password field: a node is connected with an automation token made from an owner\'s phone', () => {
        render(<AddNodeModal onClose={vi.fn()} onAdd={vi.fn()} />);

        expect(screen.getByLabelText('Automation token')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Node Admin Password')).toBeNull();
        expect(screen.queryByText(/Admin Password/i)).toBeNull();
        expect(screen.queryByTitle('Show password')).toBeNull();
    });

    it('submits form with normalized URL, and the trimmed name', async () => {
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={vi.fn()} onAdd={handleAdd} />);

        await userEvent.type(screen.getByPlaceholderText('e.g. Byron Community Node'), '  Test Node  ');
        await userEvent.type(screen.getByPlaceholderText('https://node2.beanpool.org or https://localhost:8443'), 'localhost:8443');
        await userEvent.click(screen.getByText('Save Node Profile'));

        expect(handleAdd).toHaveBeenCalledWith('Test Node', 'https://localhost:8443', undefined);
    });

    it('submits with no token when the token field is blank', async () => {
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={vi.fn()} onAdd={handleAdd} />);

        await userEvent.type(screen.getByPlaceholderText('e.g. Byron Community Node'), 'Test Node');
        await userEvent.type(screen.getByPlaceholderText('https://node2.beanpool.org or https://localhost:8443'), 'https://node1.beanpool.org');
        await userEvent.click(screen.getByText('Save Node Profile'));

        expect(handleAdd).toHaveBeenCalledWith('Test Node', 'https://node1.beanpool.org', undefined);
    });
});
