import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TopHeader } from './TopHeader';
import type { NodeProfile } from '../../lib/profiles';

describe('TopHeader Component', () => {
    const mockActiveNode: NodeProfile = {
        id: 'node-1',
        name: 'Primary Node',
        url: 'http://localhost:8080',
    };

    it('renders target node details correctly', () => {
        render(
            <TopHeader
                activeNode={mockActiveNode}
                adminPasswordInput=""
                onPasswordChange={vi.fn()}
                onAuthenticate={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
            />
        );

        expect(screen.getByText('Target Node:')).toBeInTheDocument();
        expect(screen.getByText('Primary Node')).toBeInTheDocument();
        expect(screen.getByText('http://localhost:8080')).toBeInTheDocument();
    });

    it('triggers onPasswordChange when typing into admin password input', () => {
        const onPasswordChange = vi.fn();
        render(
            <TopHeader
                activeNode={mockActiveNode}
                adminPasswordInput=""
                onPasswordChange={onPasswordChange}
                onAuthenticate={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
            />
        );

        const input = screen.getByPlaceholderText('Enter Admin Password');
        fireEvent.change(input, { target: { value: 'secret123' } });

        expect(onPasswordChange).toHaveBeenCalledWith('secret123');
    });

    it('triggers onAuthenticate when clicking the Authenticate button', () => {
        const onAuthenticate = vi.fn();
        render(
            <TopHeader
                activeNode={mockActiveNode}
                adminPasswordInput="secret"
                onPasswordChange={vi.fn()}
                onAuthenticate={onAuthenticate}
                onRefresh={vi.fn()}
                isLoading={false}
            />
        );

        const authButton = screen.getByRole('button', { name: /authenticate/i });
        fireEvent.click(authButton);

        expect(onAuthenticate).toHaveBeenCalledTimes(1);
    });

    it('triggers onRefresh when clicking Refresh button in non-loading state', () => {
        const onRefresh = vi.fn();
        render(
            <TopHeader
                activeNode={mockActiveNode}
                adminPasswordInput=""
                onPasswordChange={vi.fn()}
                onAuthenticate={vi.fn()}
                onRefresh={onRefresh}
                isLoading={false}
            />
        );

        const refreshButton = screen.getByRole('button', { name: /refresh/i });
        fireEvent.click(refreshButton);

        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(refreshButton).not.toBeDisabled();
    });

    it('disables Refresh button and shows Refreshing... text when isLoading is true', () => {
        render(
            <TopHeader
                activeNode={mockActiveNode}
                adminPasswordInput=""
                onPasswordChange={vi.fn()}
                onAuthenticate={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={true}
            />
        );

        const refreshButton = screen.getByRole('button', { name: /refreshing\.\.\./i });
        expect(refreshButton).toBeInTheDocument();
        expect(refreshButton).toBeDisabled();
    });
});
