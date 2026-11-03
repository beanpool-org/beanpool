// The welcome screen's "Get the Android app" (lights-out H3): drawn only when this community's server says, at
// /android/link, that it serves its APK to this request, which it does only straight off its local network
// (apps/server/src/test-apk-on-node.ts C3, C9, C11). Never on an iPhone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NodeApkLink, NODE_APK_PAGE } from './NodeApkLink';

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('NodeApkLink', () => {
    it('links to the node\'s Android page when the server answers the link (a phone on its local network)', async () => {
        const fetchMock = answer(200, { version: '1.2.93', versionCode: 315, href: '/android' });
        vi.stubGlobal('fetch', fetchMock);
        render(<NodeApkLink />);
        const link = await screen.findByTestId('node-apk-link');
        expect(link.getAttribute('href')).toBe(NODE_APK_PAGE);
        expect(link.textContent).toBe('Get the Android app');
        expect(fetchMock).toHaveBeenCalledWith('/android/link', expect.objectContaining({ cache: 'no-store' }));
    });

    it('draws nothing when the server answers 404 (the internet, the tunnel, a hidden link, no APK held)', async () => {
        const fetchMock = answer(404, {});
        vi.stubGlobal('fetch', fetchMock);
        const { container } = render(<NodeApkLink />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });

    it('draws nothing when the answer is not the link (a page, or another server\'s JSON)', async () => {
        const fetchMock = answer(200, { href: 'https://elsewhere.example/apk' });
        vi.stubGlobal('fetch', fetchMock);
        const { container } = render(<NodeApkLink />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });

    it('draws nothing when the server cannot be reached', async () => {
        const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
        vi.stubGlobal('fetch', fetchMock);
        const { container } = render(<NodeApkLink />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('never asks on an iPhone', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
        const fetchMock = answer(200, { href: '/android' });
        vi.stubGlobal('fetch', fetchMock);
        const { container } = render(<NodeApkLink />);
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(container.innerHTML).toBe('');
    });
});
