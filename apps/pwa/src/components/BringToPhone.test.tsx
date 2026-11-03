/**
 * Settings → Use the phone app → Put your account on your phone (front doors S9; components/BringToPhone.tsx). The node is
 * a stubbed fetch; the relay's side is apps/server test-pairing-to-phone.ts, the phone's apps/native pair-in.test.ts.
 *
 * What is checked: the code names a to-phone session, this community and the session key only; nothing is sent before
 * the digits the phone shows are typed here; once they match, the account goes sealed to the phone's key, opens only
 * with the code's key, and holds the 12 words and the public key but never the private key; a burned or run-out code
 * says so and sends nothing; a browser without the 12 words sends nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <span data-testid="qr" data-value={value} /> }));
// A browser whose account has no 12 words (a legacy one): getMnemonic answers null while this is set.
const noWords = vi.hoisted(() => ({ on: false }));
vi.mock('../lib/identity', async (original) => {
    const real = await original<typeof import('../lib/identity')>();
    return { ...real, getMnemonic: (id: Parameters<typeof real.getMnemonic>[0]) => (noWords.on ? Promise.resolve(null) : real.getMnemonic(id)) };
});

import { createPairInKey, openPairingPayloadOnPhone } from '@beanpool/core';
import { BringToPhone } from './BringToPhone';
import { createIdentity, loadIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The relay as this browser sees it: poll answers come from `polls` in turn (the last repeats). */
function stubRelay(polls: Array<() => unknown>, confirms: Array<[number, unknown]> = [[200, { result: 'released' }]]) {
    const calls: Array<{ path: string; body: any }> = [];
    let p = 0, c = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === '/api/pair/init') return json(200, { success: true, expiresAt: Date.now() + 120_000 });
        if (path.startsWith('/api/pair/poll')) return json(200, polls[Math.min(p++, polls.length - 1)]());
        if (path === '/api/pair/confirm') {
            const [status, answer] = confirms[Math.min(c++, confirms.length - 1)];
            return json(status, answer);
        }
        if (path === '/api/pair/send') return json(200, { success: true });
        return json(200, {});
    }));
    return calls;
}

const WAIT = { timeout: 5_000 };

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Put your account on your phone', () => {
    it('shows a to-phone code, takes the digits the phone shows, then sends the account sealed to that phone only', async () => {
        const me = await createIdentity('Ana');
        const phone = createPairInKey();
        let typed = false;
        const calls = stubRelay([
            () => ({ status: 'confirming' }),
            () => (typed ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'confirming' }),
            () => ({ status: 'collected' }),
        ]);
        const onRemoveHere = vi.fn();
        render(<BringToPhone onRemoveHere={onRemoveHere} />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));

        const qr = await screen.findByTestId('qr', {}, WAIT);
        const init = calls.find((x) => x.path === '/api/pair/init')!;
        expect(init.body.to).toBe('phone');
        const value = qr.getAttribute('data-value')!;
        const m = /^beanpool:\/\/pair-in\?session=([0-9a-f]{32})&pub=([0-9a-f]{64})&node=([^&]+)$/.exec(value);
        expect(m, value).not.toBeNull();
        expect(m![1]).toBe(init.body.sessionId);
        expect(m![2]).toBe(init.body.desktopPubHex);
        expect(decodeURIComponent(m![3])).toBe(window.location.origin);
        expect(value).not.toContain(me.publicKey);

        // A phone scanned: the code gives way to the digits. Nothing is sent before they are typed.
        const input = await screen.findByLabelText('Type the four digits your phone shows', {}, WAIT);
        expect((input as HTMLInputElement).maxLength).toBe(4);
        expect(input.getAttribute('autocomplete')).toBe('one-time-code');
        expect(calls.some((x) => x.path === '/api/pair/send')).toBe(false);
        fireEvent.change(input, { target: { value: '4821' } });
        typed = true;
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(calls.filter((x) => x.path === '/api/pair/confirm').map((x) => x.body)).toEqual([{ sessionId: init.body.sessionId, code: '4821' }]));

        await waitFor(() => expect(calls.some((x) => x.path === '/api/pair/send')).toBe(true), WAIT);
        const sends = calls.filter((x) => x.path === '/api/pair/send');
        expect(sends).toHaveLength(1);
        const opened = openPairingPayloadOnPhone<any>(sends[0].body.ciphertextHex, sends[0].body.nonceHex, init.body.desktopPubHex, phone.privateKeyHex, init.body.sessionId);
        const stored = (await loadIdentity())!;
        expect(opened).toEqual({ version: 1, publicKey: stored.publicKey, mnemonic: stored.mnemonic, callsign: 'Ana' });
        expect(JSON.stringify(opened)).not.toContain(stored.privateKey);

        // The phone collected: done, and removing it here is offered, never done.
        await screen.findByText('Your phone has your account. Finish on your phone.', {}, WAIT);
        expect(await loadIdentity()).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove from this browser' }));
        expect(onRemoveHere).toHaveBeenCalledTimes(1);
    }, 20_000);

    it('wrong digits say so and send nothing; three wrong end the code with nothing sent', async () => {
        await createIdentity('Ana');
        const calls = stubRelay([() => ({ status: 'confirming' })], [[400, { result: 'wrong', triesLeft: 2 }], [410, { result: 'burned' }]]);
        render(<BringToPhone />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));
        const input = await screen.findByLabelText('Type the four digits your phone shows', {}, WAIT);
        fireEvent.change(input, { target: { value: '1111' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('Those are not the digits on the phone. Check them and try again.');
        fireEvent.change(screen.getByLabelText('Type the four digits your phone shows'), { target: { value: '2222' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('The digits were typed wrong three times, so nothing was sent. Make a new code.');
        expect(calls.some((x) => x.path === '/api/pair/send')).toBe(false);
        await waitFor(() => expect(calls.some((x) => x.path === '/api/pair/cancel')).toBe(true));
        expect(screen.getByRole('button', { name: 'Make a new code' })).toBeTruthy();
    }, 15_000);

    it('a browser without the 12 words opens no session and sends nothing', async () => {
        await createIdentity('Ana');
        noWords.on = true;
        const calls = stubRelay([() => ({ status: 'waiting' })]);
        render(<BringToPhone />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));
        await screen.findByText(/doesn't hold your 12 recovery words/, {}, WAIT);
        expect(calls.some((x) => x.path.startsWith('/api/pair/'))).toBe(false);
        noWords.on = false;
    });
});
