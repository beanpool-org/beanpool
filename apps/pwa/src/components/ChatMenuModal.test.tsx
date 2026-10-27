import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMenuModal } from './ChatMenuModal';

describe('ChatMenuModal', () => {
    const defaultProps = {
        isOpen: true,
        muteOpen: false,
        isMuted: false,
        isConvenor: true,
        onClose: vi.fn(),
        onOpenMute: vi.fn(),
        onPickMute: vi.fn(),
        onSearch: vi.fn(),
        onGroupInfo: vi.fn(),
        onInvite: vi.fn(),
    };

    it('renders dialog with proper accessibility attributes and touch target sizes', () => {
        render(<ChatMenuModal {...defaultProps} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'chat-menu-title');

        const closeBtn = screen.getByRole('button', { name: 'Close menu' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');
        expect(closeBtn.className).toContain('focus-visible:ring-2');

        const inviteBtn = screen.getByRole('button', { name: 'Invite people' });
        expect(inviteBtn.className).toContain('min-h-[44px]');
    });

    it('handles button callbacks and closing', () => {
        const onClose = vi.fn();
        const onSearch = vi.fn();
        render(<ChatMenuModal {...defaultProps} onClose={onClose} onSearch={onSearch} />);

        const searchBtn = screen.getByRole('button', { name: 'Search this chat' });
        fireEvent.click(searchBtn);

        expect(onClose).toHaveBeenCalled();
        expect(onSearch).toHaveBeenCalled();
    });

    it('renders mute duration options when muteOpen is true', () => {
        render(<ChatMenuModal {...defaultProps} muteOpen={true} />);

        expect(screen.getByText('Mute notifications')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'For 8 hours' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'For a week' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Always' })).toBeInTheDocument();
    });
});
