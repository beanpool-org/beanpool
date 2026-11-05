import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeaderControls, SidebarControls } from './HeaderControls';
import { LobbyHeader } from './LobbyHeader';

afterEach(cleanup);

describe('HeaderControls and SidebarControls: Invite friends button', () => {
    it('renders the Invite friends button for a member in the mobile header pill between Help and Settings', () => {
        const onNavigate = vi.fn();
        const setShowSettings = vi.fn();
        const onOpenProfile = vi.fn();

        render(
            <HeaderControls
                showSettings={false}
                setShowSettings={setShowSettings}
                identityPubkey="pubkey-123"
                onOpenProfile={onOpenProfile}
                onNavigate={onNavigate}
                isMember={true}
            />
        );

        const inviteBtn = screen.getByTestId('header-invite');
        expect(inviteBtn).toBeInTheDocument();
        expect(inviteBtn).toHaveAttribute('aria-label', 'Invite friends');
        expect(inviteBtn).toHaveAttribute('title', 'Invite friends');

        // Verify order: profile, help, invite, settings
        const pill = screen.getByTestId('header-pill');
        const buttons = Array.from(pill.querySelectorAll('button'));
        expect(buttons.map(b => b.dataset.testid)).toEqual([
            'header-profile',
            'header-help',
            'header-invite',
            'header-settings',
        ]);
    });

    it('renders the Invite friends button for a member in the sidebar controls between Help and Settings', () => {
        const onNavigate = vi.fn();
        const setShowSettings = vi.fn();

        render(
            <SidebarControls
                showSettings={false}
                setShowSettings={setShowSettings}
                onNavigate={onNavigate}
                isMember={true}
            />
        );

        const inviteBtn = screen.getByTestId('sidebar-invite');
        expect(inviteBtn).toBeInTheDocument();
        expect(inviteBtn).toHaveAttribute('aria-label', 'Invite friends');
        expect(inviteBtn).toHaveAttribute('title', 'Invite friends');

        // Verify order: help, invite, settings
        const helpBtn = screen.getByTestId('sidebar-help');
        const settingsBtn = screen.getByTestId('sidebar-settings');
        expect(helpBtn.compareDocumentPosition(inviteBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(inviteBtn.compareDocumentPosition(settingsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('does not render the Invite friends button for a visitor / not-joined state', () => {
        const onNavigate = vi.fn();
        const setShowSettings = vi.fn();

        const { rerender } = render(
            <HeaderControls
                showSettings={false}
                setShowSettings={setShowSettings}
                onOpenProfile={vi.fn()}
                onNavigate={onNavigate}
                isMember={false}
            />
        );

        expect(screen.queryByTestId('header-invite')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Invite friends' })).toBeNull();

        rerender(
            <SidebarControls
                showSettings={false}
                setShowSettings={setShowSettings}
                onNavigate={onNavigate}
                isMember={false}
            />
        );

        expect(screen.queryByTestId('sidebar-invite')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Invite friends' })).toBeNull();

        // Also check LobbyHeader (the visitor/guest header)
        rerender(
            <LobbyHeader
                tab="home"
                title="Market"
                onHelp={vi.fn()}
                onJoin={vi.fn()}
                joinDisabled={false}
            />
        );

        expect(screen.queryByTestId('header-invite')).toBeNull();
        expect(screen.queryByTestId('sidebar-invite')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Invite friends' })).toBeNull();
    });

    it('clicking the button opens People on Invites and closes settings if open', () => {
        const onNavigate = vi.fn();
        const setShowSettings = vi.fn();

        const { rerender } = render(
            <HeaderControls
                showSettings={true}
                setShowSettings={setShowSettings}
                identityPubkey="pubkey-123"
                onOpenProfile={vi.fn()}
                onNavigate={onNavigate}
                isMember={true}
            />
        );

        const mobileInviteBtn = screen.getByTestId('header-invite');
        fireEvent.click(mobileInviteBtn);

        expect(setShowSettings).toHaveBeenCalledWith(false);
        expect(onNavigate).toHaveBeenCalledWith('people-invites');

        onNavigate.mockClear();
        setShowSettings.mockClear();

        rerender(
            <SidebarControls
                showSettings={true}
                setShowSettings={setShowSettings}
                onNavigate={onNavigate}
                isMember={true}
            />
        );

        const sidebarInviteBtn = screen.getByTestId('sidebar-invite');
        fireEvent.click(sidebarInviteBtn);

        expect(setShowSettings).toHaveBeenCalledWith(false);
        expect(onNavigate).toHaveBeenCalledWith('people-invites');
    });
});
