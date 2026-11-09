/**
 * Waiting to be let in (DESIGN-shared-listing-door-fable.md §2.1, slice A1): a browser that asked this community from the
 * shared post's page or its card holds the key it made at Send, marked as the knock's (lib/knock-key.ts). The whole App:
 *   - shows the waiting page, never the member app, and a reload keeps waiting;
 *   - makes no member read with that key (the 401 sweep): every request is a public read or the request's own status,
 *     and nothing registers the key (the member app's first-load register would let it in without anyone's yes);
 *   - a yes: Join {name} hands the invite to the welcome page, for the held key.
 * The node is a stubbed fetch; the welcome page stands in.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const info = vi.hoisted(() => ({ features: { shareOutside: true } as Record<string, unknown> }));
vi.mock('./lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: info.features })),
    joinInFlight: vi.fn(async () => false),
}));
vi.mock('./components/GuestLobby', () => ({ GuestLobby: () => <div data-testid="guest-lobby" /> }));
vi.mock('./lib/sync', () => ({
    connectToAnchor: vi.fn(),
    reconnectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}),
    onSyncChange: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
    getSyncState: vi.fn(() => ({ connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 })),
}));
vi.mock('./lib/api', async (orig) => ({
    ...(await orig<typeof import('./lib/api')>()),
    getNodeApiUrl: vi.fn(() => 'https://castlemaine.beanpool.org'),
}));
vi.mock('./components/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('./components/FormerAddressBanner', () => ({ FormerAddressBanner: () => null }));
const welcomeProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('./pages/WelcomePage', () => ({
    WelcomePage: (props: Record<string, unknown>) => { welcomeProps.last = props; return <div data-testid="welcome-page" />; },
}));

import { App } from './App';
import { commitKnockKey, draftKnockKey } from './lib/knock-key';
import { rememberKnock } from './lib/knock';
import { memoryIndexedDB } from './lib/memory-indexeddb';
import type { BeanPoolIdentity } from './lib/identity';

const CARD = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 9, area: null, joining: 'requests',
    askUrl: 'https://castlemaine.beanpool.org/app?door=ask', globalUrl: 'https://global.beanpool.org',
};
/** What a stranger's browser may ask a community: its public reads, and the request's own status. */
const PUBLIC = [/\/api\/community\/(card|info|health)$/, /\/api\/join\/knock\/status$/, /\/api\/node\/config$/, /\/api\/community\/known-rule$/, /\/api\/i18n/, /\/api\/directory/];

type Call = { path: string; signer: string | null; status: number };
let calls: Call[];
let knockStatus: unknown;
let held: BeanPoolIdentity;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/app');
    calls = [];
    knockStatus = { status: 'pending' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = new URL(String(input), 'https://castlemaine.beanpool.org').pathname;
        const signer = (init.headers as Record<string, string> | undefined)?.['X-Public-Key'] ?? null;
        let res: Response;
        if (path.endsWith('/api/join/knock/status')) res = json(200, knockStatus);
        else if (path.endsWith('/api/community/card')) res = json(200, CARD);
        else if (PUBLIC.some(r => r.test(path))) res = json(200, {});
        else res = json(401, { error: 'Sign in first', code: 'read_auth' });
        calls.push({ path, signer, status: res.status });
        return res;
    }));
    held = await commitKnockKey(await draftKnockKey(), 'Sam');
    await rememberKnock(held.publicKey, { url: 'https://castlemaine.beanpool.org', name: 'Castlemaine BeanPool' }, new Date('2026-11-09T01:00:00Z'));
    welcomeProps.last = null;
    info.features = { shareOutside: true };
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
});

describe('/app?door=ask', () => {
    it("a community that shows visitors its listings still opens the welcome page's form, never its lobby", async () => {
        const { forgetKnockKey } = await import('./lib/knock-key');
        await forgetKnockKey(held.publicKey);
        info.features = { shareOutside: true, guestListingsOnly: true };
        window.history.replaceState(null, '', '/app');
        render(<App />);
        await screen.findByTestId('guest-lobby');
        cleanup();
        window.history.replaceState(null, '', '/app?door=ask');
        render(<App />);
        await screen.findByTestId('welcome-page');
        expect(screen.queryByTestId('guest-lobby')).toBeNull();
        expect(typeof welcomeProps.last?.onAsked).toBe('function');
    });
});

describe('a browser waiting to be let in', () => {
    it('shows the waiting page, makes no member read (401 sweep), and a reload keeps waiting', async () => {
        for (let load = 0; load < 2; load++) {
            cleanup();
            render(<App />);
            await screen.findByTestId('knock-waiting');
            await waitFor(() => expect(screen.getByTestId('knock-waiting-line').textContent).toBe('Your request arrived.'));
            expect(screen.getByTestId('knock-waiting-sent').textContent).toMatch(/^You asked to join Castlemaine BeanPool on .*2026\.$/);
        }
        expect(screen.queryByTestId('welcome-page')).toBeNull();
        const refused = calls.filter(c => c.status === 401);
        expect(refused.map(c => c.path)).toEqual([]);
        // What the key signed: the request's own status and the public reads (the web's request helper signs every read with
        // the key stored; the node answers a non-member signer as it answers anyone). Nothing a member reads.
        const signed = calls.filter(c => c.signer === held.publicKey).map(c => c.path);
        expect(signed.filter(p => !PUBLIC.some(r => r.test(p)))).toEqual([]);
        expect(signed.some(p => p.endsWith('/api/join/knock/status'))).toBe(true);
        expect(calls.some(c => /register|membership|\/api\/members|\/api\/profile/.test(c.path))).toBe(false);
        expect(calls.filter(c => c.path.endsWith('/api/join/knock/status')).length).toBeGreaterThanOrEqual(2);
    });

    // Was "every 5 minutes while open" (a setInterval): Damo, 9 Nov 2026, had to reload to see the yes. The page now asks by
    // itself about every 20 s at first (pages/KnockWaitingPage.watch.test.tsx has the whole schedule, with fake timers).
    it('reads the status again by itself while open: the first wait is about 20 s, not 5 minutes', async () => {
        // A jitter draw of 0.123 makes that first wait 16,984 ms: a number nothing else on the page waits.
        vi.spyOn(Math, 'random').mockReturnValue(0.123);
        const wait = vi.spyOn(globalThis, 'setTimeout');
        try {
            render(<App />);
            await screen.findByTestId('knock-waiting');
            await waitFor(() => expect(wait.mock.calls.some(([, ms]) => ms === 16_984)).toBe(true));
            expect(wait.mock.calls.some(([, ms]) => ms === 5 * 60_000)).toBe(false);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('a yes: "🎉 {name} said yes." and Join {name} hands the invite to the welcome page, for the held key', async () => {
        knockStatus = { status: 'approved', invite: 'BP-YES1-YES2', expiresAt: null };
        render(<App />);
        expect((await screen.findByTestId('knock-waiting-yes')).textContent).toBe('🎉 Castlemaine BeanPool said yes.');
        fireEvent.click(screen.getByTestId('knock-waiting-join'));
        await screen.findByTestId('welcome-page');
        expect(welcomeProps.last?.knockYes).toEqual({ invite: 'BP-YES1-YES2', name: 'Castlemaine BeanPool' });
        expect(calls.filter(c => c.status === 401)).toEqual([]);
    });

    it('a lapsed request: today\'s words, and Forget this request wipes the key no community accepted', async () => {
        knockStatus = { status: 'none' };
        render(<App />);
        await waitFor(() => expect(screen.getByTestId('knock-waiting-line').textContent).toBe('This request is no longer open. You can ask again.'));
        fireEvent.click(screen.getByTestId('knock-waiting-forget'));
        await screen.findByTestId('welcome-page');
        const { loadIdentity } = await import('./lib/identity');
        expect(await loadIdentity()).toBeNull();
    });
});

describe('a marked key handed back to the root opens the waiting page only (review 4508428601)', () => {
    const openFromWelcome = (key: BeanPoolIdentity) =>
        act(() => { (welcomeProps.last!.onComplete as (identity: BeanPoolIdentity) => void)(key); });
    /** Nothing a member's app does with a key: no register, no membership read, no member read refused. */
    const noMemberApp = () => {
        expect(calls.some(c => /register|membership|\/api\/members|\/api\/profile/.test(c.path))).toBe(false);
        expect(calls.filter(c => c.status === 401)).toEqual([]);
    };

    it('I have an invite, then the held screen hands back the waiting key: the waiting page again, never the member app', async () => {
        render(<App />);
        await screen.findByTestId('knock-waiting');
        fireEvent.click(screen.getByTestId('knock-waiting-invite'));
        await screen.findByTestId('welcome-page');
        // "Already a member or switching devices?" → 12 words refused for the waiting key → the held screen's button.
        openFromWelcome(held);
        await screen.findByTestId('knock-waiting');
        expect(screen.queryByTestId('welcome-page')).toBeNull();
        noMemberApp();
    });

    it("after a Send that didn't reach the community (no waiting page yet): the held screen's key waits, never the member app", async () => {
        const { forgetKnockKey } = await import('./lib/knock-key');
        await forgetKnockKey(held.publicKey);
        render(<App />);
        await screen.findByTestId('welcome-page');
        // The card's form saved and marked its key at Send, and the knock never arrived: App was told nothing.
        const unsent = await commitKnockKey(await draftKnockKey(), 'Sam');
        openFromWelcome(unsent);
        await screen.findByTestId('knock-waiting');
        noMemberApp();
    });
});
