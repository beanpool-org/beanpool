/**
 * The "Beans accepted here" signs on the web (BeansSignButtons, lib/beans-sign.ts): a heading and two buttons, A4 for a window and A6 for a
 * stall, that print core's page from the hidden frame the recovery kit uses. The browser's print is a stand-in; the sign's own page is
 * read from what the frame was given.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WEB_INK_GROUNDS, brandColours, contrastRatio } from '@beanpool/core';
import { BeansSignButtons } from './BeansSignButtons';
import { pageLogoDataUri, signCommunityAddress, type SignDeps } from '../lib/beans-sign';
import { removeKitFrame } from '../lib/recovery-kit';

const ADDRESS = 'https://mullum.example.org';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

afterEach(() => {
    cleanup();
    removeKitFrame();
    vi.useRealTimers();
});

function setup(over: Partial<SignDeps> = {}) {
    const seen: string[] = [];
    const print = vi.fn((w: Window) => {
        seen.push(w.document.documentElement.outerHTML);
        w.dispatchEvent(new Event('afterprint'));
    });
    const deps: SignDeps = {
        print,
        address: ADDRESS,
        communityName: async () => 'Mullumbimby Community',
        logo: async () => `data:image/png;base64,${PNG_B64}`,
        ...over,
    };
    render(<BeansSignButtons deps={deps} />);
    return { print, seen, deps };
}

describe('BeansSignButtons', () => {
    it('is a heading and two buttons, said in the app\'s words', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'A sign for your window or stall' })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Make a window sign \(A4\)/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Make a stall card \(A6\)/ })).toBeTruthy();
    });

    it('A4: prints the window sign on A4 paper with the community, its address and a code, from a frame that is gone afterwards', async () => {
        const { print, seen } = setup();
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        const html = seen[0];
        expect(html).toContain('Beans accepted here');
        expect(html).toContain('Mullumbimby Community');
        expect(html).toContain('mullum.example.org');
        expect(html).toContain('size: 210mm 297mm');
        expect(html).toContain('<svg');
        expect(html).toContain(`data:image/png;base64,${PNG_B64}`);
        expect(html).not.toMatch(/beanpool\.org/i);
        await waitFor(() => expect(document.querySelector('iframe')).toBeNull());
        expect(screen.queryByTestId('beans-sign-failed')).toBeNull();
        expect(screen.queryByText(/printed|saved|success/i)).toBeNull();
    });

    it('A6: prints the stall card on A6 paper', async () => {
        const { print, seen } = setup();
        fireEvent.click(screen.getByTestId('beans-sign-a6'));
        await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        expect(seen[0]).toContain('size: 105mm 148mm');
        expect(seen[0]).toContain('Beans accepted here');
    });

    it('draws the code from the community\'s own address at its root, made in the browser (core\'s encoder, as the page would load it)', async () => {
        const asked: string[] = [];
        const { qrMatrix } = await import('@beanpool/core/qr-matrix');
        const { print } = setup({ qrMatrix: (text) => { asked.push(text); return qrMatrix(text); } });
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await waitFor(() => expect(print).toHaveBeenCalled());
        expect(asked).toEqual(['https://mullum.example.org/']);
    });

    it('loads the encoder itself when none is handed in (the page\'s own lazy import resolves)', async () => {
        const { print, seen } = setup();
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        expect(seen[0]).toMatch(/<rect x="\d+" y="\d+" width="\d+" height="1"/);
    });

    it('with no name from the community, names its address; with no mark, still says BeanPool', async () => {
        const { print, seen } = setup({ communityName: async () => undefined, logo: async () => undefined });
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        expect(seen[0]).toContain('<bdi>mullum.example.org</bdi>');
        expect(seen[0]).not.toContain('<img');
        expect(seen[0]).toContain('>BeanPool<');
    });

    it('points at the node the web app talks to (bp_node_url), whatever its domain, not the page\'s own address', async () => {
        localStorage.setItem('bp_node_url', 'https://shop.example.org/');
        try {
            const { print, seen } = setup({ address: undefined });
            fireEvent.click(screen.getByTestId('beans-sign-a4'));
            await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
            expect(seen[0]).toContain('shop.example.org');
            expect(seen[0]).not.toContain(window.location.host);
        } finally {
            localStorage.removeItem('bp_node_url');
        }
    });

    it('when the code cannot be made: nothing prints, no frame is left, and the failure line shows', async () => {
        const { print } = setup({ qrMatrix: () => { throw new Error('too long'); } });
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        expect(await screen.findByText('The sign couldn’t be made. Try again.')).toBeTruthy();
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(print).not.toHaveBeenCalled();
        expect(document.querySelector('iframe')).toBeNull();
    });

    it('when the browser\'s print throws: the frame is still removed, and the failure line shows', async () => {
        setup({ print: () => { throw new Error('no print here'); } });
        fireEvent.click(screen.getByTestId('beans-sign-a6'));
        expect(await screen.findByText('The sign couldn’t be made. Try again.')).toBeTruthy();
        expect(document.querySelector('iframe')).toBeNull();
    });

    it('the failure line goes when the next sign is made', async () => {
        const { qrMatrix } = await import('@beanpool/core/qr-matrix');
        let tries = 0;
        const { print } = setup({ qrMatrix: (text) => { if (tries++ === 0) throw new Error('first time'); return qrMatrix(text); } });
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await screen.findByTestId('beans-sign-failed');
        fireEvent.click(screen.getByTestId('beans-sign-a4'));
        await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('beans-sign-failed')).toBeNull();
    });
});

describe('where the page points and what mark it carries', () => {
    it('signCommunityAddress: the detached node when one is set, else the page\'s own origin', () => {
        expect(signCommunityAddress({ origin: 'https://page.example.org' }, '')).toBe('https://page.example.org');
        expect(signCommunityAddress({ origin: 'https://page.example.org' }, 'http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
    });

    it('pageLogoDataUri: a PNG becomes a data URI; anything else, or no answer, is nothing', async () => {
        const png = new Blob([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], { type: 'image/png' });
        expect(await pageLogoDataUri((async () => ({ ok: true, blob: async () => png })) as unknown as typeof fetch)).toBe(`data:image/png;base64,${PNG_B64}`);
        const html = new Blob(['<html>'], { type: 'text/html' });
        expect(await pageLogoDataUri((async () => ({ ok: true, blob: async () => html })) as unknown as typeof fetch)).toBeUndefined();
        expect(await pageLogoDataUri((async () => ({ ok: false })) as unknown as typeof fetch)).toBeUndefined();
        expect(await pageLogoDataUri((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeUndefined();
    });
});

describe('colours and size', () => {
    const src = readFileSync(resolve(__dirname, 'BeansSignButtons.tsx'), 'utf8');

    it('the buttons are 48 px targets that wrap rather than clip, in the library\'s sage ink', () => {
        expect(src).toContain('min-h-[48px]');
        expect(src).toContain('break-words');
        expect(src).toContain('text-bp-ink-accent');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    });

    it.each(['light', 'dark'] as const)('%s: the accent ink is readable (4.5:1) on every ground the web draws its inks on', (theme) => {
        const ink = brandColours(theme).ink.accent;
        for (const ground of WEB_INK_GROUNDS[theme]) expect(contrastRatio(ink, ground), `${theme} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    });
});

describe('where the buttons are', () => {
    const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

    it('Settings (anyone) and an enterprise\'s Manage tab (its keepers) draw them', () => {
        expect(src('../pages/SettingsPage.tsx')).toContain('<BeansSignButtons />');
        expect(src('../pages/TreasuryDetailPage.tsx')).toMatch(/\{!isEffectivePreview && faceOpen && isKeeperOfThis && \(\s*<div[^>]*>\s*<BeansSignButtons \/>/);
    });
});
