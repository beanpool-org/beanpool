import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHandoffFragment, startKeySession, sectionTarget } from './key-session';
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

describe('parseHandoffFragment', () => {
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
});

describe('startKeySession', () => {
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

    it('explains an expired or reused link and falls back to the password card', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'x', expired: true })));
        const r1 = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r1.kind).toBe('failed');
        expect(r1.kind === 'failed' && r1.message).toMatch(/expired/);
        vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'x', replay: true })));
        const r2 = await startKeySession(fakeWindow(`#handoff=${TOKEN}`).win);
        expect(r2.kind === 'failed' && r2.message).toMatch(/already used/);
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
