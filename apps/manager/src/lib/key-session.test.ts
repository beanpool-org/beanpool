import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseHandoffFragment,
    startKeySession,
    sectionTarget,
    isModeratorSession,
    sectionTargetFor,
    endKeySession,
    carriesHandoff,
    handoffRefusedMessage,
    handoffResumedMessage,
    otherSessionMessage,
    HANDOFF_SECTIONS,
} from './key-session';
import { buildAdminHeaders, setKeySessionCsrfToken } from './node-client';

const TOKEN = 'a'.repeat(64);

function fakeWindow(hash: string) {
    const replaceState = vi.fn();
    return {
        win: { location: { hash, pathname: '/settings', search: '' } as Location, history: { replaceState } as unknown as History },
        replaceState,
    };
}

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
    vi.restoreAllMocks();
    setKeySessionCsrfToken(null);
});

describe('parseHandoffFragment and handoff helpers', () => {
    it('reads the token and a known section', () => {
        expect(parseHandoffFragment(`#handoff=${TOKEN}&section=moderation`)).toEqual({ token: TOKEN, section: 'moderation' });
    });
    it('ignores a malformed token and an unknown section', () => {
        expect(parseHandoffFragment('#handoff=<script>&section=javascript:alert(1)')).toEqual({ token: null, section: null });
        expect(parseHandoffFragment('')).toEqual({ token: null, section: null });
    });
    it('maps sections to the tab that handles them', () => {
        expect(sectionTarget('moderation')).toEqual({ tab: 'people', subTab: 'moderation' });
        expect(sectionTarget('disputes')).toEqual({ tab: 'economy', subTab: 'disputes' });
        expect(sectionTarget('decisions')).toEqual({ tab: 'economy', subTab: 'decisions' });
        expect(sectionTarget('home')).toEqual({ tab: 'home' });
    });
    it('defines expected HANDOFF_SECTIONS matching server admin sections', () => {
        expect(HANDOFF_SECTIONS).toEqual(['home', 'moderation', 'disputes', 'decisions']);
    });
    it('carriesHandoff checks whether the fragment carries the app handoff parameter', () => {
        expect(carriesHandoff('#handoff=abc')).toBe(true);
        expect(carriesHandoff('#section=moderation&handoff=abc')).toBe(true);
        expect(carriesHandoff('handoff=abc')).toBe(true);
        expect(carriesHandoff('#section=moderation')).toBe(false);
        expect(carriesHandoff('#some_other_handoff=abc')).toBe(false);
        expect(carriesHandoff('')).toBe(false);
    });
    it('handoffRefusedMessage formats honest explanations for each refusal reason', () => {
        expect(handoffRefusedMessage('expired')).toContain('expired (they last 60 seconds)');
        expect(handoffRefusedMessage('replay')).toContain('was already used');
        expect(handoffRefusedMessage('damaged')).toContain('arrived cut short or damaged');
        expect(handoffRefusedMessage('unreachable')).toContain('Could not reach the node');
        expect(handoffRefusedMessage('refused')).toContain('was not accepted');
        expect(handoffRefusedMessage('unknown' as any)).toContain('was not accepted');
    });
    it('handoffResumedMessage formats resumed explanations when same key session is carried on', () => {
        expect(handoffResumedMessage('expired')).toContain('had expired');
        expect(handoffResumedMessage('replay')).toContain('was already used');
        expect(handoffResumedMessage('refused')).toContain("couldn't be used");
    });
    it('otherSessionMessage formats notice when another account is still signed in', () => {
        expect(otherSessionMessage({ callsign: 'Alice' }, true)).toBe(
            "You're still signed in here as Alice — not the account your phone just sent. Sign out, then tap Manage again."
        );
        expect(otherSessionMessage({ callsign: null }, false)).toBe(
            "You're still signed in here as another account — maybe not the account your phone just sent. Sign out, then tap Manage again."
        );
    });
});

describe('isModeratorSession and sectionTargetFor', () => {
    it('isModeratorSession returns true only for moderator sessions', () => {
        expect(isModeratorSession({ role: 'moderator', memberPubkey: 'ab' })).toBe(true);
        expect(isModeratorSession({ role: 'admin', memberPubkey: 'ab' })).toBe(false);
        expect(isModeratorSession({ role: 'owner', memberPubkey: 'ab' })).toBe(false);
        expect(isModeratorSession(null)).toBe(false);
        expect(isModeratorSession(undefined)).toBe(false);
    });

    it('sectionTargetFor forces moderation tab for moderators, or returns section target for other roles', () => {
        expect(sectionTargetFor('moderator', 'disputes')).toEqual({ tab: 'people', subTab: 'moderation' });
        expect(sectionTargetFor('moderator', null)).toEqual({ tab: 'people', subTab: 'moderation' });
        expect(sectionTargetFor('admin', 'disputes')).toEqual({ tab: 'economy', subTab: 'disputes' });
        expect(sectionTargetFor('owner', 'home')).toEqual({ tab: 'home' });
        expect(sectionTargetFor('owner', null)).toBeNull();
        expect(sectionTargetFor(null, 'disputes')).toEqual({ tab: 'economy', subTab: 'disputes' });
    });
});

describe('endKeySession', () => {
    it('posts to logout with CSRF token header when present', async () => {
        const fetchMock = vi.fn(async () => reply(200, { success: true }));
        vi.stubGlobal('fetch', fetchMock);
        await endKeySession('csrf-123');
        expect(fetchMock).toHaveBeenCalledWith('/api/local/admin/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-123' },
            body: '{}',
        });
    });

    it('posts to logout without CSRF token header when token is null, and handles errors gracefully', async () => {
        const fetchMock = vi.fn(async () => { throw new Error('Network error'); });
        vi.stubGlobal('fetch', fetchMock);
        await expect(endKeySession(null)).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith('/api/local/admin/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
    });
});

describe('startKeySession', () => {
    it('takes the link out of the address bar but keeps the entry\'s state: the open modals\' mark and the screen (opus-2028 B3)', async () => {
        const replaceState = vi.fn();
        const state = { bpSettings: { tab: 'people', sub: 'directory' }, bpModal: 2 };
        const win = { location: { hash: `#handoff=${TOKEN}`, pathname: '/settings', search: '' } as Location, history: { replaceState, state } as unknown as History };
        vi.stubGlobal('fetch', vi.fn(async () => reply(200, { success: true, memberPubkey: 'ab'.repeat(32), role: 'owner', csrfToken: 'csrf1' })));
        await startKeySession(win);
        expect(replaceState).toHaveBeenCalledWith(state, '', '/settings');
    });

    it('wipes the token from the address bar BEFORE posting it, then exchanges it once', async () => {
        const { win, replaceState } = fakeWindow(`#handoff=${TOKEN}&section=disputes`);
        const order: string[] = [];
        replaceState.mockImplementation(() => order.push('replaceState'));
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            order.push(`fetch ${url}`);
            expect(init?.method).toBe('POST');
            expect(JSON.parse(init!.body as string)).toEqual({ token: TOKEN });
            return reply(200, { success: true, memberPubkey: 'ab'.repeat(32), role: 'admin', csrfToken: 'csrf1' });
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await startKeySession(win);
        expect(order).toEqual(['replaceState', 'fetch /api/local/admin/auth/exchange']);
        expect(replaceState).toHaveBeenCalledWith(null, '', '/settings');
        expect(res).toEqual({ kind: 'session', session: { memberPubkey: 'ab'.repeat(32), role: 'admin' }, csrfToken: 'csrf1', section: 'disputes' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('explains an expired or reused link and falls back to the sign-in screen', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'x', expired: true })));
        const r1 = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r1.kind).toBe('failed');
        expect(r1.kind === 'failed' && r1.message).toMatch(/expired/);
        vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'x', replay: true })));
        const r2 = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r2.kind === 'failed' && r2.message).toMatch(/already used/);
    });

    it('says the phone link is spent and to tap Manage again, in plain words', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/exchange')
            ? reply(401, { error: 'x', expired: true })
            : reply(200, { authenticated: false })));
        const r = await startKeySession(fakeWindow(`#handoff=${TOKEN}&section=home&from=app`).win);
        expect(r.kind === 'failed' && r.message).toMatch(/sign-in link from your phone has expired/);
        expect(r.kind === 'failed' && r.message).toMatch(/Tap Manage again/);
    });

    it('a damaged link (not a token) is said, never a silent sign-in screen', async () => {
        const fetchMock = vi.fn(async (_url: string) => reply(200, { authenticated: false }));
        vi.stubGlobal('fetch', fetchMock);
        const { win, replaceState } = fakeWindow('#handoff=abc&from=app');
        const r = await startKeySession(win);
        expect(r.kind).toBe('failed');
        expect(r.kind === 'failed' && r.message).toMatch(/cut short or damaged.*Tap Manage again/);
        expect(replaceState).toHaveBeenCalledWith(null, '', '/settings');
        // Nothing was posted as a token.
        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['/api/local/admin/auth/session']);
    });

    it('a refused link with a live session cookie FOR THE SAME KEY resumes it, and says the link was not used (a page loaded twice)', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/exchange')
            ? reply(401, { error: 'x', replay: true, mintedFor: 'cd'.repeat(32) })
            : url.endsWith('/auth/session')
                ? reply(200, { authenticated: true, isKeySession: true, role: 'owner', memberPubkey: 'cd'.repeat(32), callsign: 'Ada' })
                : reply(200, { csrfToken: 'csrf3' })));
        const r = await startKeySession(fakeWindow(`#handoff=${TOKEN}&section=home`).win);
        expect(r).toMatchObject({ kind: 'session', session: { memberPubkey: 'cd'.repeat(32), role: 'owner' }, csrfToken: 'csrf3', section: 'home' });
        expect(r.kind === 'session' && r.notice).toMatch(/link from your phone was already used.*earlier sign-in.*same account/i);
    });

    it('a refused link with a live session cookie for ANOTHER key does not resume it: it names who is signed in and asks to sign out', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/exchange')
            ? reply(401, { error: 'x', expired: true, mintedFor: 'ef'.repeat(32) })
            : url.endsWith('/auth/session')
                ? reply(200, { authenticated: true, isKeySession: true, role: 'admin', memberPubkey: 'cd'.repeat(32), callsign: 'Ada' })
                : reply(200, { csrfToken: 'csrf4' })));
        const r = await startKeySession(fakeWindow(`#handoff=${TOKEN}&section=home`).win);
        expect(r).toEqual({
            kind: 'other-session',
            message: "You're still signed in here as Ada — not the account your phone just sent. Sign out, then tap Manage again.",
            csrfToken: 'csrf4',
            section: 'home',
        });
    });

    it('a refused link that names no key, with a live key session, does not resume it either', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/exchange')
            ? reply(401, { error: 'Invalid handshake token' })
            : url.endsWith('/auth/session')
                ? reply(200, { authenticated: true, isKeySession: true, role: 'owner', memberPubkey: 'cd'.repeat(32), callsign: 'Ada' })
                : reply(200, { csrfToken: 'csrf5' })));
        const r = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r.kind).toBe('other-session');
        expect(r.kind === 'other-session' && r.message).toBe("You're still signed in here as Ada — maybe not the account your phone just sent. Sign out, then tap Manage again.");
    });

    it('a refused link with a live session that is not a key session (an old password one) is never resumed or named: the link is just said to have failed', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/exchange')
            ? reply(401, { error: 'x', replay: true, mintedFor: 'cd'.repeat(32) })
            : url.endsWith('/auth/session')
                ? reply(200, { authenticated: true, isKeySession: false, isPasswordSession: true, role: 'owner', memberPubkey: null })
                : reply(200, { csrfToken: 'csrf6' })));
        const r = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r.kind).toBe('failed');
        expect(r.kind === 'failed' && r.message).toMatch(/already used.*Tap Manage again/);
        expect(r.kind === 'failed' && r.message).not.toMatch(/password/i);
    });

    it('never treats a password-authenticated answer as a key session', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(200, { authenticated: true, isKeySession: false, role: 'owner', memberPubkey: null })));
        expect((await startKeySession(fakeWindow('').win)).kind).toBe('none');
    });

    it('a reload with a live cookie resumes the session and fetches a fresh CSRF token', async () => {
        const fetchMock = vi.fn(async (url: string) => url.endsWith('/auth/session')
            ? reply(200, { authenticated: true, isKeySession: true, role: 'owner', memberPubkey: 'cd'.repeat(32) })
            : reply(200, { csrfToken: 'csrf2' }));
        vi.stubGlobal('fetch', fetchMock);
        const { win, replaceState } = fakeWindow('');
        const res = await startKeySession(win);
        expect(res).toEqual({ kind: 'session', session: { memberPubkey: 'cd'.repeat(32), role: 'owner' }, csrfToken: 'csrf2', section: null });
        expect(replaceState).not.toHaveBeenCalled();
    });

    it('a reload with a cookie that is not a key session (an old password one) starts at the sign-in screen', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/session')
            ? reply(200, { authenticated: true, isKeySession: false, isPasswordSession: true, role: 'owner', memberPubkey: null })
            : reply(200, { csrfToken: 'csrf-pw' })));
        expect((await startKeySession(fakeWindow('').win)).kind).toBe('none');
    });
});

describe('buildAdminHeaders under a key session', () => {
    it('adds the CSRF token only while a key session is active', () => {
        expect(buildAdminHeaders()['X-CSRF-Token']).toBeUndefined();
        setKeySessionCsrfToken('csrf3');
        expect(buildAdminHeaders()).toMatchObject({ 'X-CSRF-Token': 'csrf3' });
        expect(buildAdminHeaders()['X-Admin-Password']).toBeUndefined();
        setKeySessionCsrfToken(null);
        expect(buildAdminHeaders('pw')['X-CSRF-Token']).toBeUndefined();
    });
});
