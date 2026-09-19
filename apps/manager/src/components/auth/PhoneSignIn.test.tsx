import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { parseSettingsSigninQr } from '@beanpool/core';
import { PhoneSignIn, AUTO_RENEWALS } from './PhoneSignIn';
import { AdminLoginCard } from './AdminLoginCard';
import { PHONE_SIGNIN_MESSAGES, formatCountdown, formatShortCode, waitForPhone } from '../../lib/phone-signin';

const ID1 = 'a'.repeat(64);
const ID2 = 'b'.repeat(64);
const CODES = ['K7F3QX', 'M4P9WZ', 'R8T2HN', 'B3C5DE', 'G6J7KA', 'N9P2QS'];

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A fake node: each POST /pairing hands out the next id; each /wait answers from the script for that id.
 * A script entry that is `'hang'` never answers (a long-poll still waiting) until the request is aborted.
 */
function fakeNode(scripts: Record<string, Array<unknown | 'hang'>>, ids = [ID1, ID2, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)]) {
    const calls: string[] = [];
    let next = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || 'GET'} ${url}`);
        if (url === '/api/local/admin/auth/pairing') {
            const id = ids[next++];
            return json(200, { pairingId: id, shortCode: CODES[(next - 1) % CODES.length], expiresAt: Date.now() + 120_000, ttlMs: 120_000 });
        }
        const m = url.match(/pairing\/([0-9a-f]{64})\/wait$/);
        if (m) {
            const script = scripts[m[1]] || [];
            const step = script.length ? script.shift() : 'hang';
            if (step === 'hang') {
                return new Promise<Response>((_, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                });
            }
            const s = step as { status?: number; body: unknown };
            return json(s.status ?? 200, s.body);
        }
        return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
}

describe('PhoneSignIn — the QR card', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows a QR for this node with the pairing and short code, the code in two groups, and a countdown', async () => {
        fakeNode({ [ID1]: ['hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        const qr = await screen.findByTestId('phone-signin-qr');
        const code = screen.getByTestId('phone-signin-code').textContent!;
        expect(code).toMatch(/^[A-Z2-9]{3} [A-Z2-9]{3}$/);
        expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
        expect(qr.getAttribute('alt')).toContain(code);
        expect(screen.getByTestId('phone-signin-status').textContent).toMatch(/Waiting for your phone… code changes in [12]:\d\d/);
        expect(screen.getByRole('button', { name: 'New code' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Use the password' })).toBeInTheDocument();
    });

    it('signs in when the phone approves: hands the key session and CSRF token up', async () => {
        fakeNode({ [ID1]: [{ body: { status: 'waiting' } }, { body: { status: 'signed-in', role: 'owner', memberPubkey: 'f'.repeat(64), csrfToken: 'csrf-1' } }] });
        const onSignedIn = vi.fn();
        render(<PhoneSignIn onSignedIn={onSignedIn} onUsePassword={vi.fn()} />);
        // A "waiting" answered at once is followed by a 1 s pause before the next poll (no tight loop).
        await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1), { timeout: 3000 });
        expect(onSignedIn).toHaveBeenCalledWith({ memberPubkey: 'f'.repeat(64), role: 'owner' }, 'csrf-1');
        expect(await screen.findByText(/Signed in/)).toBeInTheDocument();
    });

    it('keeps waiting but says so when a phone without owner/admin scanned', async () => {
        fakeNode({ [ID1]: [{ body: { status: 'waiting', notice: 'not-admin' } }, 'hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(PHONE_SIGNIN_MESSAGES.notAdmin);
        expect(screen.getByTestId('phone-signin-qr')).toBeInTheDocument();
    });

    it('gets a new code by itself when one expires', async () => {
        const { calls } = fakeNode({ [ID1]: [{ status: 410, body: { status: 'expired' } }], [ID2]: ['hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        await waitFor(() => expect(calls.filter(c => c === 'POST /api/local/admin/auth/pairing')).toHaveLength(2));
        await waitFor(() => expect(calls).toContain(`POST /api/local/admin/auth/pairing/${ID2}/wait`));
        expect(screen.getByTestId('phone-signin-qr')).toBeInTheDocument();
    });

    it(`stops renewing after ${AUTO_RENEWALS} automatic codes, and says so`, async () => {
        const expired = { status: 410, body: { status: 'expired' } };
        const ids = Array.from({ length: AUTO_RENEWALS + 2 }, (_, i) => String(i + 1).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'));
        const scripts = Object.fromEntries(ids.map(id => [id, [expired]]));
        const { calls } = fakeNode(scripts, ids);
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
        expect(calls.filter(c => c === 'POST /api/local/admin/auth/pairing')).toHaveLength(AUTO_RENEWALS + 1);
        fireEvent.click(screen.getByRole('button', { name: 'New code' }));
        await waitFor(() => expect(calls.filter(c => c === 'POST /api/local/admin/auth/pairing')).toHaveLength(AUTO_RENEWALS + 2));
    });

    it.each([
        ['declined', 410, PHONE_SIGNIN_MESSAGES.declined],
        ['refused', 410, PHONE_SIGNIN_MESSAGES.refused],
        ['wrong-browser', 403, PHONE_SIGNIN_MESSAGES.wrongBrowser],
        ['used', 410, PHONE_SIGNIN_MESSAGES.used],
    ])('explains "%s" and offers a new code', async (status, http, message) => {
        const { calls } = fakeNode({ [ID1]: [{ status: http, body: { status } }], [ID2]: ['hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(message);
        expect(screen.queryByTestId('phone-signin-qr')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'New code' }));
        expect(await screen.findByTestId('phone-signin-qr')).toBeInTheDocument();
        expect(calls.filter(c => c === 'POST /api/local/admin/auth/pairing')).toHaveLength(2);
    });

    it('explains a node without phone sign-in (an older node)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'Not Found' })));
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(/doesn't offer phone sign-in yet/);
    });

    it('"New code" abandons the waiting poll and asks for a fresh pairing', async () => {
        const { calls } = fakeNode({ [ID1]: ['hang'], [ID2]: ['hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        const first = (await screen.findByTestId('phone-signin-code')).textContent;
        fireEvent.click(screen.getByRole('button', { name: 'New code' }));
        await waitFor(() => expect(calls).toContain(`POST /api/local/admin/auth/pairing/${ID2}/wait`));
        expect(screen.getByTestId('phone-signin-code').textContent).not.toBe(first);
    });

    it('the QR decodes to this page\'s node, the pairing id and the short code (what the app parses)', async () => {
        fakeNode({ [ID1]: ['hang'] });
        const QRCode = await import('qrcode');
        const spy = vi.spyOn(QRCode.default, 'create');
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        await screen.findByTestId('phone-signin-qr');
        const text = spy.mock.calls[0][0] as string;
        const parsed = parseSettingsSigninQr(text);
        expect(parsed).toMatchObject({ ok: true, nodeUrl: window.location.origin.toLowerCase(), pairingId: ID1 });
        expect(formatShortCode((parsed as any).shortCode)).toBe(screen.getByTestId('phone-signin-code').textContent);
    });

    it('keeps its buttons at least 48px tall', async () => {
        fakeNode({ [ID1]: ['hang'] });
        render(<PhoneSignIn onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
        await screen.findByTestId('phone-signin-qr');
        for (const name of ['New code', 'Use the password']) {
            expect(screen.getByRole('button', { name }).className).toMatch(/min-h-\[48px\]/);
        }
        expect(screen.getByTestId('phone-signin-qr').className).toMatch(/w-full max-w-\[240px\]/);
    });
});

describe('AdminLoginCard — phone option', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('offers "Sign in with your phone" beside the password, and the password stays', async () => {
        fakeNode({ [ID1]: ['hang'] });
        render(<AdminLoginCard nodeUrl="" onAuthenticated={vi.fn()} onKeySession={vi.fn()} />);
        expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Sign in with your phone/ }));
        expect(await screen.findByTestId('phone-signin-qr')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Password')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Use the password' }));
        expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    });

    it('has no phone option where the caller cannot take a key session (fleet mode)', () => {
        render(<AdminLoginCard nodeUrl="http://localhost:3000" onAuthenticated={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /Sign in with your phone/ })).toBeNull();
    });
});

describe('phone-signin helpers', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('formats the countdown and the short code', () => {
        expect(formatCountdown(119_001)).toBe('2:00');
        expect(formatCountdown(65_000)).toBe('1:05');
        expect(formatCountdown(-5)).toBe('0:00');
        expect(formatShortCode('K7F3QX')).toBe('K7F 3QX');
    });

    it('treats a network error or a busy node as "poll again", not an ending', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
        expect(await waitForPhone(ID1)).toEqual({ kind: 'retry' });
        vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: 'busy' })));
        expect(await waitForPhone(ID1)).toEqual({ kind: 'retry' });
    });

    it('refuses a signed-in answer without a role it knows', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'signed-in', role: 'moderator', memberPubkey: 'x', csrfToken: 'y' })));
        expect(await waitForPhone(ID1)).toEqual({ kind: 'ended', message: PHONE_SIGNIN_MESSAGES.failed });
    });
});
