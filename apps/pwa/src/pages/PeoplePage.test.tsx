import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('./InvitePage', () => ({
    InvitePage: () => <div>Invite codes</div>,
}));

const identity: BeanPoolIdentity = {
    publicKey: 'me-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Me',
    createdAt: '2026-09-17T00:00:00.000Z',
};

// #674: the sub-nav said role=tab but had no tabpanel, no aria-controls and no arrow keys.
describe('PeoplePage tabs follow the WAI-ARIA tabs pattern (#674)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getFriends').mockResolvedValue([]);
        vi.spyOn(api, 'getMembers').mockResolvedValue([
            { publicKey: 'bob-pubkey', callsign: 'Bob', joinedAt: '2026-01-01', invitedBy: '', inviteCode: '' },
        ]);
    });

    it('links every tab to a real tabpanel, and every panel back to its tab', () => {
        render(<PeoplePage identity={identity} />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3);
        for (const tab of tabs) {
            const panelId = tab.getAttribute('aria-controls');
            expect(panelId).toBeTruthy();
            const panel = document.getElementById(panelId!);
            expect(panel).not.toBeNull();
            expect(panel).toHaveAttribute('role', 'tabpanel');
            expect(panel).toHaveAttribute('aria-labelledby', tab.id);
        }
        // Only the selected tab's panel is shown, and it is named by its tab.
        expect(screen.getByRole('tabpanel', { name: /Friends/ })).toBeVisible();
        expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    });

    it('keeps only the selected tab in the Tab order', () => {
        render(<PeoplePage identity={identity} />);
        const [friends, community, invites] = screen.getAllByRole('tab');
        expect(friends).toHaveAttribute('aria-selected', 'true');
        expect(friends).toHaveAttribute('tabindex', '0');
        expect(community).toHaveAttribute('tabindex', '-1');
        expect(invites).toHaveAttribute('tabindex', '-1');
    });

    it('moves focus and selection with Left/Right (wrapping) and Home/End', async () => {
        render(<PeoplePage identity={identity} />);
        const [friends, community, invites] = screen.getAllByRole('tab');
        friends.focus();

        fireEvent.keyDown(friends, { key: 'ArrowRight' });
        expect(community).toHaveFocus();
        expect(community).toHaveAttribute('aria-selected', 'true');
        expect(community).toHaveAttribute('tabindex', '0');
        expect(friends).toHaveAttribute('tabindex', '-1');
        expect(await screen.findByText('Bob')).toBeInTheDocument();
        expect(screen.getByRole('tabpanel', { name: /Community/ })).toBeVisible();

        fireEvent.keyDown(community, { key: 'ArrowRight' });
        expect(invites).toHaveFocus();
        expect(screen.getByText('Invite codes')).toBeInTheDocument();

        fireEvent.keyDown(invites, { key: 'ArrowRight' });
        expect(friends).toHaveFocus();
        expect(friends).toHaveAttribute('aria-selected', 'true');

        fireEvent.keyDown(friends, { key: 'ArrowLeft' });
        expect(invites).toHaveFocus();

        fireEvent.keyDown(invites, { key: 'Home' });
        expect(friends).toHaveFocus();

        fireEvent.keyDown(friends, { key: 'End' });
        expect(invites).toHaveFocus();
        expect(invites).toHaveAttribute('aria-selected', 'true');
    });

    it('does not load Community members until that tab is opened', async () => {
        render(<PeoplePage identity={identity} />);
        await waitFor(() => expect(api.getFriends).toHaveBeenCalled());
        expect(api.getMembers).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
        await waitFor(() => expect(api.getMembers).toHaveBeenCalled());
    });
});
