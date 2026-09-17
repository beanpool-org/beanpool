import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PostModerationPanel, type PostModerationItem } from './PostModerationPanel';
import type { NodeProfile } from '../../lib/profiles';

describe('PostModerationPanel Component (Bucket 2 Item 2)', () => {
    const mockNode: NodeProfile = {
        id: 'node-test-1',
        name: 'Mullum Node',
        url: 'https://mullum.example.com',
        adminPassword: 'test-admin-secret',
    };

    const mockPosts: PostModerationItem[] = [
        {
            id: 'post-101',
            title: 'Fresh Organic Sourdough',
            description: 'Baked this morning using local flour',
            type: 'offer',
            category: 'food',
            authorCallsign: 'BakerBob',
            authorPublicKey: 'pk-baker-12345678',
            price: 5,
            createdAt: '2026-09-10T08:00:00.000Z',
        },
        {
            id: 'post-102',
            title: 'Need Garden Tiller for Weekend',
            description: 'Looking to borrow a rotary tiller',
            type: 'need',
            category: 'tools',
            authorCallsign: 'GreenThumb',
            authorPublicKey: 'pk-gardener-87654321',
            price: 15,
            createdAt: '2026-09-12T10:30:00.000Z',
        },
        {
            id: 'post-103',
            title: 'Solar Panel Inverter Repair',
            description: 'Can fix off-grid 24V and 48V solar inverters',
            type: 'offer',
            category: 'energy',
            authorCallsign: 'SparkySam',
            authorPublicKey: 'pk-sparky-11223344',
            price: 40,
            createdAt: '2026-09-14T14:00:00.000Z',
        },
    ];

    it('renders with a real payload, supports search, category, and type filtering', async () => {
        const handleRefresh = vi.fn();
        const handleDeletePost = vi.fn().mockResolvedValue(undefined);

        render(
            <PostModerationPanel
                posts={mockPosts}
                activeNode={mockNode}
                onRefresh={handleRefresh}
                onDeletePost={handleDeletePost}
            />
        );

        // Header & count label
        expect(screen.getByText('Marketplace Post Search & Moderation')).toBeInTheDocument();
        expect(screen.getByText('3 of 3 posts')).toBeInTheDocument();

        // All 3 posts visible
        expect(screen.getByText('Fresh Organic Sourdough')).toBeInTheDocument();
        expect(screen.getByText('Need Garden Tiller for Weekend')).toBeInTheDocument();
        expect(screen.getByText('Solar Panel Inverter Repair')).toBeInTheDocument();

        // 1. Filter by search query
        const searchInput = screen.getByPlaceholderText(/Search title, description, author/i);
        await userEvent.type(searchInput, 'Sourdough');
        expect(screen.getByText('1 of 3 posts')).toBeInTheDocument();
        expect(screen.getByText('Fresh Organic Sourdough')).toBeInTheDocument();
        expect(screen.queryByText('Need Garden Tiller for Weekend')).not.toBeInTheDocument();

        // Clear search
        await userEvent.clear(searchInput);
        expect(screen.getByText('3 of 3 posts')).toBeInTheDocument();

        // 2. Filter by Type (Need)
        const typeSelect = screen.getByLabelText(/Type Filter/i);
        await userEvent.selectOptions(typeSelect, 'need');
        expect(screen.getByText('1 of 3 posts')).toBeInTheDocument();
        expect(screen.getByText('Need Garden Tiller for Weekend')).toBeInTheDocument();
        expect(screen.queryByText('Fresh Organic Sourdough')).not.toBeInTheDocument();

        // Reset type to all
        await userEvent.selectOptions(typeSelect, 'all');

        // 3. Filter by Category (Energy)
        const catSelect = screen.getByLabelText(/Category Filter/i);
        await userEvent.selectOptions(catSelect, 'energy');
        expect(screen.getByText('1 of 3 posts')).toBeInTheDocument();
        expect(screen.getByText('Solar Panel Inverter Repair')).toBeInTheDocument();
        expect(screen.queryByText('Fresh Organic Sourdough')).not.toBeInTheDocument();
    });

    it('handles single-post deletion confirmation step and executes deletion', async () => {
        const handleRefresh = vi.fn();
        const handleDeletePost = vi.fn().mockResolvedValue(undefined);

        render(
            <PostModerationPanel
                posts={mockPosts}
                activeNode={mockNode}
                onRefresh={handleRefresh}
                onDeletePost={handleDeletePost}
            />
        );

        // Click delete on first post
        const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
        await userEvent.click(deleteButtons[0]);

        // Confirmation modal appears
        const dialog = screen.getByRole('dialog');
        expect(screen.getByText('Confirm Post Deletion')).toBeInTheDocument();
        expect(screen.getByText(/Permanently delete this listing\?/i)).toBeInTheDocument();
        expect(within(dialog).getByText('Fresh Organic Sourdough')).toBeInTheDocument();

        // Click confirm delete
        const confirmBtn = screen.getByRole('button', { name: /Confirm Delete/i });
        await userEvent.click(confirmBtn);

        expect(handleDeletePost).toHaveBeenCalledWith('post-101');
        await waitFor(() => {
            expect(handleRefresh).toHaveBeenCalled();
        });
    });

    it('renders safely with an empty payload', () => {
        const handleRefresh = vi.fn();

        render(
            <PostModerationPanel
                posts={[]}
                activeNode={mockNode}
                onRefresh={handleRefresh}
            />
        );

        expect(screen.getByText('0 of 0 posts')).toBeInTheDocument();
        expect(screen.getByText(/No marketplace posts match your search/i)).toBeInTheDocument();
    });

    it('renders safely with null and wrong-typed fields', () => {
        const handleRefresh = vi.fn();
        const malformedPosts = [
            {
                id: 12345 as any,
                title: null as any,
                description: undefined,
                type: 99 as any,
                category: false as any,
                price: 'not-a-number' as any,
            },
        ];

        render(
            <PostModerationPanel
                posts={malformedPosts as any}
                activeNode={mockNode}
                onRefresh={handleRefresh}
            />
        );

        expect(screen.getByText('1 of 1 posts')).toBeInTheDocument();
        expect(screen.getByText('Untitled Listing')).toBeInTheDocument();
    });

    it('allows cancelling the delete confirmation dialog', async () => {
        render(
            <PostModerationPanel
                posts={mockPosts}
                activeNode={mockNode}
                onRefresh={vi.fn()}
            />
        );

        const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
        await userEvent.click(deleteButtons[0]);

        expect(screen.getByText('Confirm Post Deletion')).toBeInTheDocument();

        // Click Cancel
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByText('Confirm Post Deletion')).not.toBeInTheDocument();
    });

    it('dismisses delete confirmation dialog when Escape key is pressed', async () => {
        render(
            <PostModerationPanel
                posts={mockPosts}
                activeNode={mockNode}
                onRefresh={vi.fn()}
            />
        );

        const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
        await userEvent.click(deleteButtons[0]);

        expect(screen.getByText('Confirm Post Deletion')).toBeInTheDocument();

        await userEvent.keyboard('{Escape}');
        expect(screen.queryByText('Confirm Post Deletion')).not.toBeInTheDocument();
    });

    it('guards against Escape key and close dismissal while deletion is in flight', async () => {
        let resolveDelete: () => void = () => {};
        const pendingDelete = new Promise<void>((resolve) => {
            resolveDelete = resolve;
        });
        const handleDeletePost = vi.fn().mockReturnValue(pendingDelete);

        render(
            <PostModerationPanel
                posts={mockPosts}
                activeNode={mockNode}
                onRefresh={vi.fn()}
                onDeletePost={handleDeletePost}
            />
        );

        const deleteButtons = screen.getAllByRole('button', { name: /Delete/i });
        await userEvent.click(deleteButtons[0]);

        const confirmBtn = screen.getByRole('button', { name: /Confirm Delete/i });
        await userEvent.click(confirmBtn);

        // Deleting is in flight
        expect(screen.getByText('Deleting...')).toBeInTheDocument();

        // Try to press Escape while in flight
        await userEvent.keyboard('{Escape}');
        expect(screen.getByText('Confirm Post Deletion')).toBeInTheDocument();

        // Close button should be disabled
        const closeBtn = screen.getByRole('button', { name: /Close delete confirmation/i });
        expect(closeBtn).toBeDisabled();

        // Resolve pending delete
        resolveDelete();
        await waitFor(() => {
            expect(screen.queryByText('Confirm Post Deletion')).not.toBeInTheDocument();
        });
    });
});

