import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeaderControls } from './HeaderControls';
import * as tourStore from '../lib/tour-store';

vi.mock('../lib/tour-store', () => ({
    openHelp: vi.fn(),
}));

describe('HeaderControls', () => {
    it('renders profile, help, and settings buttons with proper button types and accessibility attributes', () => {
        const setShowSettings = vi.fn();
        const onOpenProfile = vi.fn();

        render(
            <HeaderControls
                showSettings={false}
                setShowSettings={setShowSettings}
                identityPubkey="pubkey-123"
                onOpenProfile={onOpenProfile}
            />
        );

        const profileBtn = screen.getByRole('button', { name: 'My profile' });
        expect(profileBtn).toBeDefined();
        expect(profileBtn.getAttribute('type')).toBe('button');

        const helpBtn = screen.getByRole('button', { name: 'Help for this screen' });
        expect(helpBtn).toBeDefined();
        expect(helpBtn.getAttribute('type')).toBe('button');

        const settingsBtn = screen.getByRole('button', { name: 'Settings' });
        expect(settingsBtn).toBeDefined();
        expect(settingsBtn.getAttribute('type')).toBe('button');
        expect(settingsBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('triggers callbacks when buttons are clicked', () => {
        const setShowSettings = vi.fn();
        const onOpenProfile = vi.fn();

        render(
            <HeaderControls
                showSettings={true}
                setShowSettings={setShowSettings}
                identityPubkey="pubkey-456"
                onOpenProfile={onOpenProfile}
            />
        );

        const profileBtn = screen.getByRole('button', { name: 'My profile' });
        fireEvent.click(profileBtn);
        expect(onOpenProfile).toHaveBeenCalledWith('pubkey-456');

        const helpBtn = screen.getByRole('button', { name: 'Help for this screen' });
        fireEvent.click(helpBtn);
        expect(tourStore.openHelp).toHaveBeenCalled();

        const settingsBtn = screen.getByRole('button', { name: 'Settings' });
        expect(settingsBtn.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(settingsBtn);
        expect(setShowSettings).toHaveBeenCalledWith(false);
    });
});
