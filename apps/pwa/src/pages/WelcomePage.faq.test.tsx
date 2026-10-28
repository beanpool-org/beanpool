import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const LOCAL = {
    memberCount: 3,
    postCount: 0,
    transactionCount: 0,
    commonsBalance: 0,
    profile: 'local',
    features: { openJoin: false },
};

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/community/info') return json(200, LOCAL);
        return json(200, {});
    }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('WelcomePage FAQ (front doors S4)', () => {
    it('FAQ "Can I use this on my phone?" directs phones to the app and keeps browser install for desktop', async () => {
        render(<WelcomePage onComplete={vi.fn()} />);

        const question = await screen.findByText('Can I use this on my phone?');
        fireEvent.click(question);

        const answer = await screen.findByText(/On a phone, get the app from Google Play/i);
        expect(answer).toBeInTheDocument();
        expect(answer.textContent).toContain('beanpool.org/android');
        expect(answer.textContent).toContain('On a computer');
        expect(answer.textContent).toContain('Install');
        expect(answer.textContent).toContain('Add to Dock');
        // A computer has no "Add to Home Screen" (review of #2561, WelcomePage.tsx:118).
        expect(answer.textContent).not.toContain('Add to Home Screen');
        expect(answer.textContent).not.toContain('works on Android, iOS, and desktop');
    });
});
