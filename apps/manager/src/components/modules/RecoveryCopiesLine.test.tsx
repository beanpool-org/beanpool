import { render, screen, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RecoveryCopiesLine, useRecoveryCopies } from './RecoveryCopiesLine';
import { resolveNodeApiUrl } from '../../lib/node-client';

describe('useRecoveryCopies', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('fetches recoveryCopies from /api/community/info and returns parsed rule', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ recoveryCopies: 'vault' }),
        } as Response);

        const nodeUrl = 'https://node.example.com';
        const { result } = renderHook(() => useRecoveryCopies(nodeUrl));

        expect(result.current).toBeNull();

        await waitFor(() => {
            expect(result.current).toBe('vault');
        });

        expect(globalThis.fetch).toHaveBeenCalledWith(
            resolveNodeApiUrl(nodeUrl, '/api/community/info'),
            { headers: { Accept: 'application/json' } }
        );
    });

    it('returns null when response is not ok or json parsing fails', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ recoveryCopies: 'vault' }),
        } as Response);

        const { result } = renderHook(() => useRecoveryCopies('https://node.example.com'));

        await waitFor(() => {
            expect(globalThis.fetch).toHaveBeenCalled();
        });

        expect(result.current).toBeNull();
    });

    it('returns null when fetch rejects', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const { result } = renderHook(() => useRecoveryCopies('https://node.example.com'));

        await waitFor(() => {
            expect(globalThis.fetch).toHaveBeenCalled();
        });

        expect(result.current).toBeNull();
    });
});

describe('RecoveryCopiesLine', () => {
    it('renders nothing when rule is null', () => {
        const { container } = render(<RecoveryCopiesLine rule={null} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders choice information when rule is a valid choice (vault)', () => {
        render(<RecoveryCopiesLine rule="vault" />);

        expect(screen.getByTestId('recovery-copies-line')).toBeInTheDocument();
        expect(screen.getByText(/Where members' copies go: BeanPool's key vault/)).toBeInTheDocument();
        expect(screen.getByText(/How this community works → Ways back/)).toBeInTheDocument();
    });

    it('renders correctly for server choice', () => {
        render(<RecoveryCopiesLine rule="server" />);

        expect(screen.getByTestId('recovery-copies-line')).toBeInTheDocument();
        expect(screen.getByText(/Where members' copies go: This server/)).toBeInTheDocument();
    });

    it('renders correctly for none choice', () => {
        render(<RecoveryCopiesLine rule="none" />);

        expect(screen.getByTestId('recovery-copies-line')).toBeInTheDocument();
        expect(screen.getByText(/Where members' copies go: Nowhere/)).toBeInTheDocument();
    });
});
