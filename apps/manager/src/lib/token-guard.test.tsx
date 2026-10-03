/**
 * Node sign-in step 7b-1: what a token can't do is said before the request (no request reaches the node), and a 403 a
 * token met on the node says the same, so a route the client's list missed still degrades to the phone message.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { guardTokenFetch, tokenCannotReach, OWNER_PHONE_EVENT, OWNER_PHONE_MESSAGE, TOKEN_REPLACE_ADVICE } from './token-guard';
import { forgetStandby, freezeNodeUser, fetchNodeData, buildAdminHeaders } from './node-client';
import { OwnerPhoneBanner } from '../components/auth/OwnerPhoneBanner';

const NODE = 'https://node.example';
const TOKEN = `bp_${'b2'.repeat(6)}_${'0e'.repeat(32)}`;
const PASSWORD = 'correct-horse-battery-staple';

let inner: ReturnType<typeof vi.fn>;
let events: CustomEvent[];
const onEvent = (e: Event) => events.push(e as CustomEvent);

beforeEach(() => {
    events = [];
    window.addEventListener(OWNER_PHONE_EVENT, onEvent);
    inner = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', guardTokenFetch(inner as unknown as typeof fetch));
});
afterEach(() => {
    window.removeEventListener(OWNER_PHONE_EVENT, onEvent);
    vi.unstubAllGlobals();
});

describe('an owner-only action with a token', () => {
    it('says an owner\'s phone is needed and sends nothing to the node', async () => {
        await expect(forgetStandby(NODE, 'standby-1', TOKEN)).rejects.toThrow(OWNER_PHONE_MESSAGE);
        expect(inner).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
    });

    it('covers the routes refused to every token and the owner-only ones', () => {
        for (const p of ['/api/local/admin/auth/password', '/api/local/admin/automation-tokens', '/api/local/admin/2fa/setup',
            '/api/local/admin/ws-ticket', '/api/local/admin/csrf-token', '/api/local/admin/public-address/claim',
            '/api/local/admin/takeover/open', '/api/local/admin/stranded-escrows/e1/write-off', '/api/local/reset',
            '/api/local/change-password', '/api/local/admin/offbox-backups/settings',
            '/api/local/admin/takeover/recovery-code', '/api/local/admin/takeover/recovery-code/check',
            '/api/local/admin/takeover/confirm', '/api/local/admin/takeover/cancel',
            '/api/local/admin/takeover/phone/start', '/api/local/admin/takeover/phone/wait',
            '/proxy/https/node.example/api/local/admin/takeover/open']) {
            expect(tokenCannotReach(p), p).toBe(true);
        }
        // A backups token's own routes go to the node, which decides by the token's scope; so do ordinary admin routes.
        for (const p of ['/api/local/admin/offbox-backups/run', '/api/local/admin/offbox-backups/status', '/api/local/admin/backup',
            '/api/local/admin/snapshots/list', '/api/local/admin/users/abc/freeze', '/api/local/admin/node-data',
            '/proxy/https/node.example/api/local/admin/offbox-backups/run',
            // Measured on a real node (deciding review of #1549): an admin token gets 200 on each of these. They are
            // checkAdminAuth only (takeover status, words-checks, progress; backup-config's cadence), or owner-only
            // only when the body changes something (snapshots/config), which the node's 403 relay covers.
            '/api/local/admin/takeover/status', '/api/local/admin/takeover/words-checks', '/api/local/admin/takeover/progress',
            '/api/local/admin/backup-config', '/api/local/admin/snapshots/config',
            '/proxy/https/node.example/api/local/admin/takeover/status']) {
            expect(tokenCannotReach(p), p).toBe(false);
        }
    });

    it('a password request to the same route goes to the node untouched', async () => {
        await forgetStandby(NODE, 'standby-1', PASSWORD);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(0);
    });
});

describe('a token never goes to the dashboard\'s own origin', () => {
    it('a request with a token to /api/manager is not sent', async () => {
        for (const url of ['/api/manager/backups/status', `${window.location.origin}/api/manager/backups/download-db?nodeId=n1`]) {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
            expect(res.ok, url).toBe(false);
        }
        expect(inner).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
    });
});

describe('a 401 the node gives a token (revoked, expired or wrong)', () => {
    const NODE_WORDS = 'Invalid, revoked or expired automation token';

    it('says the node\'s own words and to make a new token from the phone, never a password', async () => {
        inner.mockResolvedValueOnce(new Response(JSON.stringify({ error: NODE_WORDS }), { status: 401, statusText: 'Unauthorized' }));
        const res = await fetch(`${NODE}/api/local/admin/diagnostics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        expect(res.status).toBe(401);
        expect(res.statusText).toBe(NODE_WORDS);
        const body = await res.json() as { error: string };
        expect(body.error).toContain(NODE_WORDS);
        expect(body.error).toContain(TOKEN_REPLACE_ADVICE);
        expect(TOKEN_REPLACE_ADVICE).toBe('Make a new token from your phone (Settings → Automation tokens)');
        expect(JSON.stringify(body)).not.toMatch(/password/i);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(0);
    });

    it('a caller that shows the status line shows the node\'s words, not "Unauthorized"', async () => {
        inner.mockResolvedValueOnce(new Response(JSON.stringify({ error: NODE_WORDS }), { status: 401, statusText: 'Unauthorized' }));
        await expect(fetchNodeData(NODE, TOKEN)).rejects.toThrow(NODE_WORDS);
    });

    it('a password\'s 401 is left as the node said it', async () => {
        inner.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, statusText: 'Unauthorized' }));
        const res = await fetch(`${NODE}/api/local/admin/diagnostics`, { headers: buildAdminHeaders(PASSWORD) });
        expect(res.statusText).toBe('Unauthorized');
    });
});

describe('a 403 the node gives a token', () => {
    it('shows the same message', async () => {
        inner.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This token can only read', code: 'token_not_allowed', scope: 'read' }), { status: 403 }));
        await expect(freezeNodeUser(NODE, 'abc', true, TOKEN)).rejects.toThrow(OWNER_PHONE_MESSAGE);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(1);
    });

    it('a 403 that is not a token refusal is left as the node said it', async () => {
        inner.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Something else' }), { status: 403 }));
        await expect(fetchNodeData(NODE, TOKEN)).rejects.toThrow(/Something else|403/);
        expect(events).toHaveLength(0);
    });

    it('a token request that succeeds carries the bearer and no password', async () => {
        await fetchNodeData(NODE, TOKEN);
        const init = inner.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.stringify(init.headers)).not.toContain('X-Admin-Password');
        expect(String(init.body ?? '')).not.toContain(TOKEN);
        expect(buildAdminHeaders(TOKEN).Authorization).toBe(`Bearer ${TOKEN}`);
    });
});

describe('the banner', () => {
    it('appears on the event with the phone sign-in on the node\'s own Settings', () => {
        render(<OwnerPhoneBanner nodeUrl={NODE} />);
        expect(screen.queryByRole('alert')).toBeNull();
        act(() => { window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT)); });
        expect(screen.getByRole('alert').textContent).toContain(OWNER_PHONE_MESSAGE);
        expect(screen.getByRole('link', { name: 'Sign in with your phone' }).getAttribute('href')).toBe(`${NODE}/settings/`);
    });
});
