import React from 'react';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
    NodeDataPagesContext,
    useNodeDataPages,
    LoadMoreRow,
    type NodeDataPagesValue,
} from './node-data-pages';
import { MEMBERS_PAGE_SIZE, POSTS_PAGE_SIZE } from './node-client';

describe('node-data-pages context and hook', () => {
    it('useNodeDataPages returns null when used outside of NodeDataPagesContext provider', () => {
        const { result } = renderHook(() => useNodeDataPages());
        expect(result.current).toBeNull();
    });

    it('useNodeDataPages returns value when rendered within NodeDataPagesContext provider', () => {
        const value: NodeDataPagesValue = {
            members: { loaded: 10, total: 100, more: true },
            posts: { loaded: 5, more: false },
            busy: { members: false, posts: false },
            error: { members: null, posts: null },
            loadMore: vi.fn(),
        };

        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <NodeDataPagesContext.Provider value={value}>
                {children}
            </NodeDataPagesContext.Provider>
        );

        const { result } = renderHook(() => useNodeDataPages(), { wrapper });
        expect(result.current).toBe(value);
    });
});

describe('LoadMoreRow component', () => {
    function defaultContextValue(overrides?: Partial<NodeDataPagesValue>): NodeDataPagesValue {
        return {
            members: { loaded: 200, total: 3500, more: true },
            posts: { loaded: 50, more: true },
            busy: { members: false, posts: false },
            error: { members: null, posts: null },
            loadMore: vi.fn(),
            ...overrides,
        };
    }

    it('renders null when context is not provided', () => {
        const { container } = render(<LoadMoreRow kind="members" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders null when more is false and error is null', () => {
        const value = defaultContextValue({
            members: { loaded: 100, total: 100, more: false },
        });
        const { container } = render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="members" />
            </NodeDataPagesContext.Provider>
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('renders members row with total count, oldest joined phrasing, and handles loadMore click', () => {
        const loadMore = vi.fn();
        const value = defaultContextValue({
            members: { loaded: 200, total: 3500, more: true },
            loadMore,
        });

        render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="members" />
            </NodeDataPagesContext.Provider>
        );

        const row = screen.getByTestId('load-more-members');
        expect(row).toBeInTheDocument();
        expect(row).toHaveAttribute('role', 'status');
        expect(row).toHaveTextContent('Showing 200 of 3,500 members, oldest joined first.');

        const button = screen.getByRole('button', { name: `Load ${MEMBERS_PAGE_SIZE} more` });
        expect(button).toBeEnabled();
        fireEvent.click(button);
        expect(loadMore).toHaveBeenCalledWith('members');
    });

    it('renders members row phrasing when total is null', () => {
        const value = defaultContextValue({
            members: { loaded: 50, total: null, more: true },
        });

        render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="members" />
            </NodeDataPagesContext.Provider>
        );

        expect(screen.getByTestId('load-more-members')).toHaveTextContent('Showing the first 50 members.');
    });

    it('displays searching note when searching is true and more is true', () => {
        const value = defaultContextValue({
            members: { loaded: 200, total: 1000, more: true },
            posts: { loaded: 30, more: true },
        });

        const { rerender } = render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="members" searching={true} />
            </NodeDataPagesContext.Provider>
        );

        expect(screen.getByTestId('load-more-members')).toHaveTextContent(
            'The search looks only at the members shown.'
        );

        rerender(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="posts" searching={true} />
            </NodeDataPagesContext.Provider>
        );

        expect(screen.getByTestId('load-more-posts')).toHaveTextContent(
            'The search looks only at the posts shown.'
        );
    });

    it('shows loading state and disables button when busy is true', () => {
        const value = defaultContextValue({
            posts: { loaded: 50, more: true },
            busy: { members: false, posts: true },
        });

        render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="posts" />
            </NodeDataPagesContext.Provider>
        );

        const button = screen.getByRole('button', { name: 'Loading…' });
        expect(button).toBeDisabled();
    });

    it('renders posts row phrasing and POSTS_PAGE_SIZE button label', () => {
        const value = defaultContextValue({
            posts: { loaded: 25, more: true },
        });

        render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="posts" />
            </NodeDataPagesContext.Provider>
        );

        expect(screen.getByTestId('load-more-posts')).toHaveTextContent(
            'Showing the 25 most recently changed posts.'
        );
        expect(
            screen.getByRole('button', { name: `Load ${POSTS_PAGE_SIZE} more` })
        ).toBeInTheDocument();
    });

    it('renders error message when error exists without more button when more is false', () => {
        const value = defaultContextValue({
            members: { loaded: 100, total: 100, more: false },
            error: { members: 'Network timeout', posts: null },
        });

        render(
            <NodeDataPagesContext.Provider value={value}>
                <LoadMoreRow kind="members" />
            </NodeDataPagesContext.Provider>
        );

        expect(screen.getByTestId('load-more-members')).toHaveTextContent(
            "Couldn't load more: Network timeout"
        );
        expect(screen.queryByRole('button')).toBeNull();
    });
});
