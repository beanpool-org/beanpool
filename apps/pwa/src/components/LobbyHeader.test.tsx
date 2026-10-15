import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LobbyHeader, LobbyHelpButton, LobbyJoin } from './LobbyHeader';

describe('LobbyHeader components', () => {
    describe('LobbyHelpButton', () => {
        it('renders help button with aria-label and triggers onClick', () => {
            const handleClick = vi.fn();
            render(<LobbyHelpButton onClick={handleClick} className="test-class" />);

            const button = screen.getByRole('button', { name: 'Help for this screen' });
            expect(button).toBeInTheDocument();
            expect(button.className).toContain('focus-visible:ring-2');

            fireEvent.click(button);
            expect(handleClick).toHaveBeenCalledTimes(1);
        });
    });

    describe('LobbyJoin', () => {
        it('renders join button with focus ring classes and triggers onClick when enabled', () => {
            const handleClick = vi.fn();
            render(<LobbyJoin onClick={handleClick} disabled={false} className="custom-join" />);

            const button = screen.getByRole('button', { name: 'Join' });
            expect(button).toBeInTheDocument();
            expect(button).not.toBeDisabled();
            expect(button.className).toContain('focus-visible:ring-2');
            expect(button.className).toContain('focus-visible:ring-blue-400');

            fireEvent.click(button);
            expect(handleClick).toHaveBeenCalledTimes(1);
        });

        it('disables join button when disabled prop is true', () => {
            const handleClick = vi.fn();
            render(<LobbyJoin onClick={handleClick} disabled={true} className="custom-join" />);

            const button = screen.getByRole('button', { name: 'Join' });
            expect(button).toBeDisabled();
        });
    });

    describe('LobbyHeader', () => {
        it('renders mobile lobby header with title and action controls', () => {
            const handleHelp = vi.fn();
            const handleJoin = vi.fn();

            render(
                <LobbyHeader
                    tab="home"
                    title="Market"
                    onHelp={handleHelp}
                    onJoin={handleJoin}
                    joinDisabled={false}
                />
            );

            expect(screen.getByTestId('lobby-header')).toBeInTheDocument();
            expect(screen.getByTestId('lobby-title')).toHaveTextContent('Market');

            const helpButton = screen.getByRole('button', { name: 'Help for this screen' });
            fireEvent.click(helpButton);
            expect(handleHelp).toHaveBeenCalledTimes(1);

            const joinButton = screen.getByRole('button', { name: 'Join' });
            fireEvent.click(joinButton);
            expect(handleJoin).toHaveBeenCalledTimes(1);
        });
    });
});
