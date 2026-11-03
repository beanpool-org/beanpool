/**
 * Settings → Use the phone app → Put your account on your phone (front doors S9; components/BringToPhone.tsx). The node is
 * a stubbed fetch; the relay's side is apps/server test-pairing-to-phone.ts, the phone's apps/native pair-in.test.ts.
 *
 * What is checked: the code names a to-phone session, this community and the session key only; nothing is sent before
 * the digits the phone shows are typed here; once they match, the account goes sealed to the phone's key, opens only
 * with the code's key, and holds the 12 words and the public key but never the private key; a burned or run-out code
 * says so and sends nothing; a browser without the 12 words sends nothing at all.
 *
 * And (doors-s9-fix1, the Opus review of 278bff9f): the phone collecting the seal is not the phone saving it, so Remove
 * from this browser is offered only after the phone says 'saved'; a phone that says 'not-saved', or says nothing, leaves
 * the account here and the panel says so. A second Confirm (Enter and a click, a double click) sends one confirm and
 * cancels nothing; a lost answer is a note to try again, and the session goes on.
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
function stubRelay(
    polls: Array<() => unknown>,
    confirms: Array<[number, unknown]> = [[200, { result: 'released' }]],
    onConfirm?: () => Promise<Response>,
) {
    const calls: Array<{ path: string; body: any }> = [];
    let p = 0, c = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === '/api/pair/init') return json(200, { success: true, expiresAt: Date.now() + 120_000 });
        if (path.startsWith('/api/pair/poll')) return json(200, polls[Math.min(p++, polls.length - 1)]());
        if (path === '/api/pair/confirm') {
            if (onConfirm) return onConfirm();
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
        let phoneSaved = false;
        const calls = stubRelay([
            () => ({ status: 'confirming' }),
            () => (typed ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'confirming' }),
            () => (phoneSaved ? { status: 'saved' } : { status: 'collected' }),
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

        // The phone collected the seal: not saved yet. It says what to tap on the phone, and offers no Remove.
        await screen.findByText('Your phone has received your account. On your phone, tap Bring it to this phone.', {}, WAIT);
        expect(screen.queryByRole('button', { name: 'Remove from this browser' })).toBeNull();
        expect(screen.queryByText(/is now on this browser and your phone/)).toBeNull();
        expect(calls.some((x) => x.path === '/api/pair/cancel')).toBe(false);

        // The phone says it saved it: done, and removing it here is offered, never done.
        phoneSaved = true;
        await screen.findByText('Your phone has saved your account.', {}, WAIT);
        expect(screen.getByText('Your account is now on this browser and your phone. You can keep both, or remove it from this browser.')).toBeTruthy();
        expect(await loadIdentity()).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove from this browser' }));
        expect(onRemoveHere).toHaveBeenCalledTimes(1);
    }, 20_000);

    async function toCollected(after: () => unknown) {
        await createIdentity('Ana');
        const phone = createPairInKey();
        let typed = false;
        const calls = stubRelay([
            () => ({ status: 'confirming' }),
            () => (typed ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'confirming' }),
            () => ({ status: 'collected' }),
            after,
        ]);
        const onRemoveHere = vi.fn();
        render(<BringToPhone onRemoveHere={onRemoveHere} />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));
        const input = await screen.findByLabelText('Type the four digits your phone shows', {}, WAIT);
        fireEvent.change(input, { target: { value: '4821' } });
        typed = true;
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('Your phone has received your account. On your phone, tap Bring it to this phone.', {}, WAIT);
        return { calls, onRemoveHere };
    }

    it("a phone that says it didn't save it: the account stays here, no Remove, and a new code is offered", async () => {
        const { onRemoveHere } = await toCollected(() => ({ status: 'not-saved' }));
        await screen.findByText("Your phone didn't save your account, so it is still here on this browser. Make a new code to try again.", {}, WAIT);
        expect(screen.queryByRole('button', { name: 'Remove from this browser' })).toBeNull();
        expect(screen.queryByText('Your phone has saved your account.')).toBeNull();
        expect(screen.getByRole('button', { name: 'Make a new code' })).toBeTruthy();
        expect(onRemoveHere).not.toHaveBeenCalled();
        expect(await loadIdentity()).not.toBeNull();
    }, 20_000);

    it('a phone that never says (the session and its word gone): the account stays here, no Remove', async () => {
        const { onRemoveHere } = await toCollected(() => ({ status: 'expired' }));
        await screen.findByText("Your phone hasn't said it saved your account, so it is still here on this browser. If your phone shows your account, it is on both.", {}, WAIT);
        expect(screen.queryByRole('button', { name: 'Remove from this browser' })).toBeNull();
        expect(screen.queryByText('This code has run out. Make a new one.')).toBeNull();
        expect(onRemoveHere).not.toHaveBeenCalled();
    }, 20_000);

    it('a second Confirm while the first is out sends one confirm and cancels nothing; the account still goes', async () => {
        await createIdentity('Ana');
        const phone = createPairInKey();
        let released = false;
        let answer: (r: Response) => void = () => {};
        const calls = stubRelay(
            [() => ({ status: 'confirming' }), () => (released ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'confirming' })],
            [],
            // The first confirm's answer waits; any second one gets what the relay answered a released session at 278bff9f.
            () => (calls.filter((x) => x.path === '/api/pair/confirm').length === 1
                ? new Promise<Response>((r) => { answer = r; })
                : Promise.resolve(json(410, { result: 'not-confirming' }))),
        );
        render(<BringToPhone />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));
        const input = await screen.findByLabelText('Type the four digits your phone shows', {}, WAIT);
        fireEvent.change(input, { target: { value: '4821' } });
        // Enter, then a click, then Enter again, before the first answer is back.
        const form = input.closest('form')!;
        fireEvent.submit(form);
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        fireEvent.submit(form);
        await waitFor(() => expect(calls.filter((x) => x.path === '/api/pair/confirm')).toHaveLength(1));
        released = true;
        answer(json(200, { result: 'released' }));
        await waitFor(() => expect(calls.some((x) => x.path === '/api/pair/send')).toBe(true), WAIT);
        expect(calls.filter((x) => x.path === '/api/pair/confirm')).toHaveLength(1);
        expect(calls.some((x) => x.path === '/api/pair/cancel')).toBe(false);
        expect(screen.queryByText('This code has run out. Make a new one.')).toBeNull();
    }, 20_000);

    it('a lost answer to Confirm is a note to try again, never an end: the session goes on and the poll decides', async () => {
        await createIdentity('Ana');
        const phone = createPairInKey();
        let released = false;
        const calls = stubRelay(
            [() => ({ status: 'confirming' }), () => (released ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'confirming' })],
            [],
            // The relay released, but its answer never came back.
            () => { released = true; return Promise.reject(new TypeError('Failed to fetch')); },
        );
        render(<BringToPhone />);
        fireEvent.click(screen.getByTestId('bring-to-phone-open'));
        const input = await screen.findByLabelText('Type the four digits your phone shows', {}, WAIT);
        fireEvent.change(input, { target: { value: '4821' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('That did not go through. Try again.', {}, WAIT);
        expect(calls.some((x) => x.path === '/api/pair/cancel')).toBe(false);
        await waitFor(() => expect(calls.some((x) => x.path === '/api/pair/send')).toBe(true), WAIT);
        expect(calls.some((x) => x.path === '/api/pair/cancel')).toBe(false);
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
