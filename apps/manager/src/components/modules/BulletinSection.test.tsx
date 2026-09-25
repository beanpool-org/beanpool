import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulletinSection } from './BulletinSection';
import type { NodeProfile } from '../../lib/profiles';

describe('BulletinSection', () => {
    const mockActiveNode: NodeProfile = {
        id: 'node-1',
        name: 'Alpha Node',
        url: 'https://alpha.beanpool.org',
        adminPassword: 'secretpassword',
    };

    const mockOnRefresh = vi.fn();
    const mockOnSubTabChange = vi.fn();

    const mockChannels = [
        {
            id: 'chan-1',
            title: 'Permaculture Gazette',
            feedUrl: 'https://example.org/permaculture.xml',
            description: 'Local gardening updates',
        },
        {
            id: 'chan-2',
            title: 'Village News',
            url: 'https://example.org/news.xml',
            description: 'Town hall announcements',
        },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn());
        vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
        vi.stubGlobal('alert', vi.fn());
    });

    it('renders heading and loads pulse channels on mount', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ channels: mockChannels }), { status: 200 })
        );

        render(
            <BulletinSection
                activeNode={mockActiveNode}
                onRefresh={mockOnRefresh}
                onSubTabChange={mockOnSubTabChange}
            />
        );

        expect(screen.getByRole('heading', { name: /Bulletin & News/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Announcements' })).toBeInTheDocument();

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Pulse Channels (2)' })).toBeInTheDocument();
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/https/alpha.beanpool.org/api/local/admin/pulse/channels',
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Admin-Password': 'secretpassword',
                }),
            })
        );
    });

    it('switches subtabs when clicking tab buttons', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ channels: mockChannels }), { status: 200 })
        );

        function TestWrapper() {
            const [tab, setTab] = React.useState<'announcements' | 'pulse'>('announcements');
            return (
                <BulletinSection
                    activeNode={mockActiveNode}
                    onRefresh={mockOnRefresh}
                    initialSubTab={tab}
                    onSubTabChange={(newTab) => {
                        setTab(newTab);
                        mockOnSubTabChange(newTab);
                    }}
                />
            );
        }

        render(<TestWrapper />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Pulse Channels (2)' })).toBeInTheDocument();
        });

        // Switch to Pulse tab
        await userEvent.click(screen.getByRole('button', { name: 'Pulse Channels (2)' }));
        expect(mockOnSubTabChange).toHaveBeenCalledWith('pulse');
        expect(screen.getByRole('heading', { name: 'Curated Pulse RSS Channels' })).toBeInTheDocument();
        expect(screen.getByText('Permaculture Gazette')).toBeInTheDocument();
        expect(screen.getByText('Village News')).toBeInTheDocument();

        // Switch back to Announcements
        await userEvent.click(screen.getByRole('button', { name: 'Announcements' }));
        expect(mockOnSubTabChange).toHaveBeenCalledWith('announcements');
        expect(screen.getByRole('heading', { name: /Broadcast Announcement/i })).toBeInTheDocument();
    });

    it('broadcasts an announcement successfully', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ channels: [] }), { status: 200 })
        );

        render(
            <BulletinSection
                activeNode={mockActiveNode}
                onRefresh={mockOnRefresh}
            />
        );

        // Fill out form
        const titleInput = screen.getByPlaceholderText('e.g. Village Market Time Change');
        const bodyInput = screen.getByPlaceholderText('Write the announcement message details here...');

        await userEvent.type(titleInput, 'Emergency Water Notice');
        await userEvent.type(bodyInput, 'Water shutoff today at 3pm.');

        // Toggle severity to warning alert
        const warningBtn = screen.getByRole('button', { name: /Warning Alert/i });
        await userEvent.click(warningBtn);

        // Mock fetch for announcement broadcast
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), { status: 200 })
        );

        const broadcastBtn = screen.getByRole('button', { name: 'Broadcast to Community' });
        await userEvent.click(broadcastBtn);

        await waitFor(() => {
            expect(screen.getByText('Announcement broadcasted to community feed!')).toBeInTheDocument();
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/https/alpha.beanpool.org/api/local/admin/announcements',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    title: 'Emergency Water Notice',
                    body: 'Water shutoff today at 3pm.',
                    severity: 'alert',
                }),
            })
        );

        expect(mockOnRefresh).toHaveBeenCalled();
        expect(titleInput).toHaveValue('');
        expect(bodyInput).toHaveValue('');
    });

    it('adds a pulse channel using modal', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ channels: [] }), { status: 200 })
        );

        render(
            <BulletinSection
                activeNode={mockActiveNode}
                onRefresh={mockOnRefresh}
                initialSubTab="pulse"
            />
        );

        await waitFor(() => {
            expect(screen.getByRole('heading', { name: 'Curated Pulse RSS Channels' })).toBeInTheDocument();
        });

        expect(screen.getByText('No channels added yet')).toBeInTheDocument();

        // Open add channel modal
        const addBtn = screen.getByRole('button', { name: /Add Feed Channel/i });
        await userEvent.click(addBtn);

        expect(screen.getByRole('heading', { name: /Add Curated Pulse Feed/i })).toBeInTheDocument();

        const titleInput = screen.getByPlaceholderText('e.g. Local Permaculture Gazette');
        const urlInput = screen.getByPlaceholderText('https://example.org/feed.xml');
        const descInput = screen.getByPlaceholderText('Brief summary of feed contents');

        await userEvent.type(titleInput, 'Permaculture Gazette');
        await userEvent.type(urlInput, 'https://example.org/permaculture.xml');
        await userEvent.type(descInput, 'Local updates');

        // Mock fetch for adding channel + re-fetching channels list
        vi.mocked(globalThis.fetch)
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ channels: [mockChannels[0]] }), { status: 200 })
            );

        const submitBtn = screen.getByRole('button', { name: 'Add Channel' });
        await userEvent.click(submitBtn);

        await waitFor(() => {
            expect(screen.queryByRole('heading', { name: /Add Curated Pulse Feed/i })).not.toBeInTheDocument();
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/https/alpha.beanpool.org/api/local/admin/pulse/channels',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    url: 'https://example.org/permaculture.xml',
                    category: 'learn',
                }),
            })
        );

        expect(screen.getByText('Permaculture Gazette')).toBeInTheDocument();
    });

    it('removes a pulse channel after confirmation', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ channels: mockChannels }), { status: 200 })
        );

        render(
            <BulletinSection
                activeNode={mockActiveNode}
                onRefresh={mockOnRefresh}
                initialSubTab="pulse"
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Permaculture Gazette')).toBeInTheDocument();
        });

        const removeBtns = screen.getAllByRole('button', { name: 'Remove' });
        expect(removeBtns).toHaveLength(2);

        // Mock fetch for removing channel + re-fetching channel list
        vi.mocked(globalThis.fetch)
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ channels: [mockChannels[1]] }), { status: 200 })
            );

        await userEvent.click(removeBtns[0]);

        expect(globalThis.confirm).toHaveBeenCalledWith('Remove this Pulse feed channel?');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/https/alpha.beanpool.org/api/local/admin/pulse/channels/remove',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ id: 'chan-1' }),
            })
        );

        await waitFor(() => {
            expect(screen.queryByText('Permaculture Gazette')).not.toBeInTheDocument();
        });
        expect(screen.getByText('Village News')).toBeInTheDocument();
    });
});
