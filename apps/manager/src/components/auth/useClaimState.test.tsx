import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClaimState } from './useClaimState';
import * as nodeClaim from '../../lib/node-claim';

vi.mock('../../lib/node-claim', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-claim')>();
    return {
        ...actual,
        fetchClaimState: vi.fn(),
        fetchCommunityInfo: vi.fn(),
    };
});

describe('useClaimState hook', () => {
    const fetchClaimStateMock = vi.mocked(nodeClaim.fetchClaimState);
    const fetchCommunityInfoMock = vi.mocked(nodeClaim.fetchCommunityInfo);

    let hidden = false;

    beforeEach(() => {
        hidden = false;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('starts with { kind: "unknown" } and fetches claim state on mount', async () => {
        fetchClaimStateMock.mockResolvedValueOnce({ kind: 'claimed' });

        const { result } = renderHook(() => useClaimState('https://example.com/api/local/claim'));

        expect(result.current).toEqual({ kind: 'unknown' });

        await act(async () => {
            await Promise.resolve();
        });

        expect(fetchClaimStateMock).toHaveBeenCalledWith('https://example.com/api/local/claim', expect.any(AbortSignal));
        expect(result.current).toEqual({ kind: 'claimed' });
    });

    it('fetches community info when node is unclaimed and merges addresses', async () => {
        fetchClaimStateMock.mockResolvedValueOnce({
            kind: 'unclaimed',
            codeId: '12345678',
            communityName: 'Test Community',
            password: true,
            primaryAddress: null,
            address: null,
            addresses: [],
        });
        fetchCommunityInfoMock.mockResolvedValueOnce({
            primaryAddress: 'https://community.example.com',
            addresses: ['https://community.example.com', 'https://alt.example.com'],
        });

        const { result } = renderHook(() => useClaimState('https://example.com/api/local/claim'));

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchCommunityInfoMock).toHaveBeenCalledWith('https://example.com/api/community/info', expect.any(AbortSignal));
        expect(result.current).toEqual({
            kind: 'unclaimed',
            codeId: '12345678',
            communityName: 'Test Community',
            password: true,
            primaryAddress: 'https://community.example.com',
            address: 'https://community.example.com',
            addresses: ['https://community.example.com', 'https://alt.example.com'],
        });
    });

    it('polls periodically while the state is unclaimed and stops once claimed', async () => {
        vi.useFakeTimers();

        fetchClaimStateMock
            .mockResolvedValueOnce({
                kind: 'unclaimed',
                codeId: '12345678',
                communityName: 'Test',
                password: true,
                primaryAddress: null,
                address: null,
                addresses: [],
            })
            .mockResolvedValueOnce({
                kind: 'unclaimed',
                codeId: '12345678',
                communityName: 'Test',
                password: true,
                primaryAddress: null,
                address: null,
                addresses: [],
            })
            .mockResolvedValueOnce({ kind: 'claimed' });

        fetchCommunityInfoMock.mockResolvedValue({
            primaryAddress: null,
            addresses: [],
        });

        const { result } = renderHook(() => useClaimState('https://example.com/api/local/claim'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.kind).toBe('unclaimed');
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(nodeClaim.CLAIM_POLL_MS);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(2);
        expect(result.current.kind).toBe('unclaimed');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(nodeClaim.CLAIM_POLL_MS);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(3);
        expect(result.current.kind).toBe('claimed');

        // Further timer advancement should not trigger new calls because kind is claimed
        await act(async () => {
            await vi.advanceTimersByTimeAsync(nodeClaim.CLAIM_POLL_MS * 3);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(3);
    });

    it('pauses polling when document becomes hidden and resumes when document becomes visible', async () => {
        vi.useFakeTimers();

        fetchClaimStateMock.mockResolvedValue({
            kind: 'unclaimed',
            codeId: '12345678',
            communityName: 'Test',
            password: true,
            primaryAddress: null,
            address: null,
            addresses: [],
        });
        fetchCommunityInfoMock.mockResolvedValue({
            primaryAddress: null,
            addresses: [],
        });

        const { result } = renderHook(() => useClaimState('https://example.com/api/local/claim'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(1);

        // Hide document
        hidden = true;
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        // Timers advance while hidden -> no poll
        await act(async () => {
            await vi.advanceTimersByTimeAsync(nodeClaim.CLAIM_POLL_MS * 5);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(1);

        // Show document -> triggers immediate ask
        hidden = false;
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetchClaimStateMock).toHaveBeenCalledTimes(2);
    });

    it('aborts in-flight request and clears timers on unmount', async () => {
        vi.useFakeTimers();

        fetchClaimStateMock.mockImplementation(() => new Promise(() => {})); // Never resolves

        const { unmount } = renderHook(() => useClaimState('https://example.com/api/local/claim'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(fetchClaimStateMock).toHaveBeenCalledTimes(1);

        unmount();

        // Advancing time should do nothing and not crash
        await act(async () => {
            await vi.advanceTimersByTimeAsync(nodeClaim.CLAIM_POLL_MS * 5);
        });
    });
});
