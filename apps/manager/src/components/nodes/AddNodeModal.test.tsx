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
        expect(screen.getByPlaceholderText('Node Admin Password')).toBeInTheDocument();
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

    it('toggles password visibility when toggle button is clicked', async () => {
        const handleClose = vi.fn();
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={handleClose} onAdd={handleAdd} />);

        const passwordInput = screen.getByPlaceholderText('Node Admin Password');
        expect(passwordInput).toHaveAttribute('type', 'password');

        const toggleBtn = screen.getByTitle('Show password');
        await userEvent.click(toggleBtn);
        expect(passwordInput).toHaveAttribute('type', 'text');

        const hideToggleBtn = screen.getByTitle('Hide password');
        await userEvent.click(hideToggleBtn);
        expect(passwordInput).toHaveAttribute('type', 'password');
    });

    it('submits form with normalized URL and trimmed password', async () => {
        const handleClose = vi.fn();
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={handleClose} onAdd={handleAdd} />);

        const nameInput = screen.getByPlaceholderText('e.g. Byron Community Node');
        const urlInput = screen.getByPlaceholderText('https://node2.beanpool.org or https://localhost:8443');
        const passwordInput = screen.getByPlaceholderText('Node Admin Password');

        await userEvent.type(nameInput, '  Test Node  ');
        await userEvent.type(urlInput, 'localhost:8443');
        await userEvent.type(passwordInput, ' secret123 ');

        const submitBtn = screen.getByText('Save Node Profile');
        await userEvent.click(submitBtn);

        expect(handleAdd).toHaveBeenCalledWith('Test Node', 'https://localhost:8443', 'secret123');
    });

    it('submits form with undefined password if password field is blank', async () => {
        const handleClose = vi.fn();
        const handleAdd = vi.fn();
        render(<AddNodeModal onClose={handleClose} onAdd={handleAdd} />);

        const nameInput = screen.getByPlaceholderText('e.g. Byron Community Node');
        const urlInput = screen.getByPlaceholderText('https://node2.beanpool.org or https://localhost:8443');

        await userEvent.type(nameInput, 'Test Node');
        await userEvent.type(urlInput, 'https://node1.beanpool.org');

        const submitBtn = screen.getByText('Save Node Profile');
        await userEvent.click(submitBtn);

        expect(handleAdd).toHaveBeenCalledWith('Test Node', 'https://node1.beanpool.org', undefined);
    });
});
