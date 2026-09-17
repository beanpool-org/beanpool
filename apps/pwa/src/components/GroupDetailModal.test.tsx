import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GroupDetailModal } from './GroupDetailModal';
import type { Group } from '../lib/api';

vi.mock('../lib/api', () => ({
    getGroup: vi.fn().mockResolvedValue({
        id: 'group-1',
        name: 'Local Food Co-op',
        category: 'working_group',
        joinPolicy: 'open',
        description: 'A community food sharing group',
        memberCount: 5,
        viewerStatus: 'none',
        viewerRole: 'member'
    }),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    joinGroup: vi.fn(),
    removeGroupMember: vi.fn(),
    approveGroupMember: vi.fn(),
    setGroupMemberRole: vi.fn(),
    updateGroup: vi.fn()
}));

describe('GroupDetailModal Accessibility', () => {
    const mockGroup: Group = {
        id: 'group-1',
        name: 'Local Food Co-op',
        slug: 'local-food-co-op',
        category: 'working_group',
        joinPolicy: 'open',
        description: 'A community food sharing group',
        memberCount: 5,
        createdBy: 'pk-1',
        createdAt: '2026-01-01T00:00:00Z'
    };

    it('renders modal dialog with aria-labelledby linked to group title ID', () => {
        render(
            <GroupDetailModal
                group={mockGroup}
                isOpen={true}
                onClose={() => {}}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-labelledby', 'group-detail-title');

        const title = screen.getByRole('heading', { name: 'Local Food Co-op' });
        expect(title).toHaveAttribute('id', 'group-detail-title');
    });

    it('renders close button with type="button" and focus ring classes', () => {
        render(
            <GroupDetailModal
                group={mockGroup}
                isOpen={true}
                onClose={() => {}}
            />
        );

        const closeBtn = screen.getByRole('button', { name: 'Close' });
        expect(closeBtn).toHaveAttribute('type', 'button');
        expect(closeBtn.className).toContain('focus-visible:ring-2');
    });
});
