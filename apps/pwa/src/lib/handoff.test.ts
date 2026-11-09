/**
 * The account handoff's checks (lib/handoff.ts, DESIGN-global-yes-join-fable.md §2.1, slice Y1), with stand-in windows: the
 * address it opens carries no key; the receiver takes an account only from its opener, at `from`, with its nonce, whole
 * (the private key makes the public key, the 12 words the same key); the holder posts the account only after the opened
 * page's `ready` from that window, at the knock's origin, with the nonce, and only to that origin, never '*'.
 * Chromium's own delivery between two real origins is e2e/global-yes-y1-check.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HANDOFF_DOOR, accountFrom, accountMessage, answerFrom, answerMessage, awaitHandoffJoin, forgetHandedOver, handedOverHere, handoffAtLoad,
    handoffJoined, handoffOrigin, handoffUrl, isHandoffNonce, isReadyFrom, markHandedOver, newHandoffNonce, readyMessage, runHandoff,
} from './handoff';
import { generateIdentity, type BeanPoolIdentity } from './identity';

const GLOBAL = 'https://global.example.org';
const BYRON = 'https://byron.example.org';
const SPY = 'https://spy.example.org';

/** A stand-in window: what was posted to it, and with which target origin. */
function fakeWindow() {
    const posted: Array<{ data: unknown; targetOrigin: string }> = [];
    const win = { closed: false, postMessage: vi.fn((data: unknown, targetOrigin: string) => { posted.push({ data, targetOrigin }); }) };
    return { win: win as unknown as Window & { closed: boolean }, posted };
}

const event = (data: unknown, origin: string, source: unknown) => new MessageEvent('message', { data, origin, source: source as Window });

let me: BeanPoolIdentity;
beforeEach(async () => { me = await generateIdentity('CJ'); });

describe('the address the holder opens', () => {
    it('names the community, its handoff door, a fresh nonce and who asks: no key, no words', () => {
        const nonce = newHandoffNonce();
        expect(isHandoffNonce(nonce)).toBe(true);
        expect(newHandoffNonce()).not.toBe(nonce);
        const url = handoffUrl(BYRON, nonce, GLOBAL);
        expect(url).toBe(`${BYRON}/app?door=${HANDOFF_DOOR}&n=${nonce}&from=${encodeURIComponent(GLOBAL)}`);
        expect(url).not.toContain(me.privateKey);
        expect(url).not.toContain(me.publicKey);
        // The address is exactly the line above: the constants and the nonce. "door", "hand", "off" and "example" are in
        // it by design and are also recovery words, so the phrase is looked for whole, in each form a URL could carry it.
        for (const sep of [' ', '+', '%20', '%2B', '-', ',', '%2C', '']) expect(url).not.toContain(me.mnemonic!.join(sep));
    });

    it('the receiver reads only a well-formed handoff from another https origin', () => {
        const n = 'a'.repeat(32);
        expect(handoffAtLoad(`?door=handoff&n=${n}&from=${encodeURIComponent(GLOBAL)}`, BYRON)).toEqual({ nonce: n, from: GLOBAL });
        expect(handoffAtLoad(`?door=ask&n=${n}&from=${encodeURIComponent(GLOBAL)}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${'a'.repeat(31)}&from=${encodeURIComponent(GLOBAL)}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${'A'.repeat(32)}&from=${encodeURIComponent(GLOBAL)}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${n}&from=${encodeURIComponent('http://global.example.org')}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${n}&from=${encodeURIComponent(`${GLOBAL}/app`)}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${n}&from=${encodeURIComponent(BYRON)}`, BYRON)).toBeNull();
        expect(handoffAtLoad(`?door=handoff&n=${n}`, BYRON)).toBeNull();
    });

    it('a holder origin is https, a host with a dot (or an IPv4), a port at most', () => {
        expect(handoffOrigin('https://global.beanpool.org')).toBe('https://global.beanpool.org');
        expect(handoffOrigin('https://global.example.org:8443')).toBe('https://global.example.org:8443');
        expect(handoffOrigin('https://Global.Example.org/')).toBe('https://global.example.org');
        expect(handoffOrigin('https://localhost')).toBeNull();
        expect(handoffOrigin('https://user:pw@global.example.org')).toBeNull();
        expect(handoffOrigin('javascript:alert(1)')).toBeNull();
        expect(handoffOrigin(null)).toBeNull();
    });
});

describe('the receiver takes one account, whole, from its opener only', () => {
    const nonce = 'b'.repeat(32);
    const handed = () => ({ publicKey: me.publicKey, privateKey: me.privateKey, mnemonic: me.mnemonic, callsign: 'CJ' });

    it('takes it: the key, its words, the name, and a photo a profile takes', async () => {
        const { win: opener } = fakeWindow();
        const photo = 'data:image/png;base64,iVBORw0KGgo=';
        const got = await accountFrom(event(accountMessage(nonce, handed(), photo), GLOBAL, opener), opener, GLOBAL, nonce);
        expect(got?.account).toMatchObject({ publicKey: me.publicKey, privateKey: me.privateKey, mnemonic: me.mnemonic, callsign: 'CJ' });
        expect(got?.photo).toBe(photo);
    });

    it('refuses a message not from the opener, from another origin, with a wrong nonce, or of another shape', async () => {
        const { win: opener } = fakeWindow();
        const { win: other } = fakeWindow();
        const good = accountMessage(nonce, handed(), null);
        expect(await accountFrom(event(good, GLOBAL, other), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event(good, GLOBAL, null), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event(good, SPY, opener), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event(good, GLOBAL, opener), null, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event(accountMessage('c'.repeat(32), handed(), null), GLOBAL, opener), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event(readyMessage(nonce), GLOBAL, opener), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event({ ...good, tag: 'other' }, GLOBAL, opener), opener, GLOBAL, nonce)).toBeNull();
        expect(await accountFrom(event('a string', GLOBAL, opener), opener, GLOBAL, nonce)).toBeNull();
    });

    it("refuses a private key that doesn't make the public key, and words that make another key", async () => {
        const { win: opener } = fakeWindow();
        const other = await generateIdentity('Mallory');
        const send = (account: Record<string, unknown>) =>
            accountFrom(event({ ...accountMessage(nonce, handed(), null), account }, GLOBAL, opener), opener, GLOBAL, nonce);
        expect(await send({ ...handed(), privateKey: other.privateKey })).toBeNull();
        expect(await send({ ...handed(), mnemonic: other.mnemonic })).toBeNull();
        expect(await send({ ...handed(), mnemonic: me.mnemonic!.slice(0, 11) })).toBeNull();
        expect(await send({ ...handed(), publicKey: me.publicKey.toUpperCase() })).toBeNull();
        expect(await send({ ...handed(), privateKey: 'zz' })).toBeNull();
        // No words at all is an account that had none where it was made: taken, with none.
        const noWords: Record<string, unknown> = { ...handed() };
        delete noWords.mnemonic;
        expect((await send(noWords))?.account.mnemonic).toBeUndefined();
    });

    it('leaves behind a photo a profile would not take (an SVG, a link), and keeps the account', async () => {
        const { win: opener } = fakeWindow();
        for (const photo of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil.example.org/x.png']) {
            const got = await accountFrom(event(accountMessage(nonce, handed(), photo), GLOBAL, opener), opener, GLOBAL, nonce);
            expect(got?.photo).toBeNull();
            expect(got?.account.publicKey).toBe(me.publicKey);
        }
    });
});

describe('the holder posts the account only to the knock\'s origin, after its page said ready', () => {
    const nonce = 'd'.repeat(32);
    let host: EventTarget & Pick<Window, 'addEventListener' | 'removeEventListener'>;
    beforeEach(() => {
        vi.useFakeTimers();
        host = new EventTarget() as typeof host;
    });
    afterEach(() => { vi.useRealTimers(); });
    const account = async () => ({ account: { publicKey: me.publicKey, privateKey: me.privateKey, mnemonic: me.mnemonic, callsign: 'CJ' }, photo: null });

    it('ignores a ready from another window, another origin or another nonce; posts once to the origin after the real one', async () => {
        const { win, posted } = fakeWindow();
        const { win: spy } = fakeWindow();
        const ends: string[] = [];
        runHandoff({ win, origin: BYRON, nonce, account, listenOn: host, onEnd: (e) => ends.push(e) });
        host.dispatchEvent(event(readyMessage(nonce), BYRON, spy));
        host.dispatchEvent(event(readyMessage(nonce), SPY, win));
        host.dispatchEvent(event(readyMessage('e'.repeat(32)), BYRON, win));
        await vi.advanceTimersByTimeAsync(10);
        expect(posted).toEqual([]);
        host.dispatchEvent(event(readyMessage(nonce), BYRON, win));
        await vi.advanceTimersByTimeAsync(10);
        expect(posted).toHaveLength(1);
        expect(posted[0].targetOrigin).toBe(BYRON);
        expect((posted[0].data as { type: string }).type).toBe('account');
        // A second ready posts nothing more.
        host.dispatchEvent(event(readyMessage(nonce), BYRON, win));
        await vi.advanceTimersByTimeAsync(10);
        expect(posted).toHaveLength(1);
        expect(ends).toEqual([]);
    });

    it('hears the answer only from that window, at that origin, with the nonce, and only once the account is sent', async () => {
        const { win } = fakeWindow();
        const { win: spy } = fakeWindow();
        const ends: string[] = [];
        runHandoff({ win, origin: BYRON, nonce, account, listenOn: host, onEnd: (e) => ends.push(e) });
        host.dispatchEvent(event(answerMessage(nonce, 'joined'), BYRON, win));
        expect(ends).toEqual([]);
        host.dispatchEvent(event(readyMessage(nonce), BYRON, win));
        await vi.advanceTimersByTimeAsync(10);
        host.dispatchEvent(event(answerMessage(nonce, 'joined'), SPY, win));
        host.dispatchEvent(event(answerMessage(nonce, 'joined'), BYRON, spy));
        host.dispatchEvent(event(answerMessage('e'.repeat(32), 'joined'), BYRON, win));
        expect(ends).toEqual([]);
        host.dispatchEvent(event(answerMessage(nonce, 'joined'), BYRON, win));
        host.dispatchEvent(event(answerMessage(nonce, 'refused'), BYRON, win));
        expect(ends).toEqual(['joined']);
        expect(answerFrom(event(answerMessage(nonce, 'held'), BYRON, win), win, BYRON, nonce)).toBe('held');
        expect(answerFrom(event({ ...answerMessage(nonce, 'held'), type: 'steal' }, BYRON, win), win, BYRON, nonce)).toBeNull();
    });

    it('no ready in 20 s: late (the fallback shows), nothing posted; a late ready, by the same checks, still gets it, at that origin only', async () => {
        const { win, posted } = fakeWindow();
        const ends: string[] = [];
        const late = vi.fn();
        runHandoff({ win, origin: BYRON, nonce, account, listenOn: host, onLate: late, onEnd: (e) => ends.push(e) });
        await vi.advanceTimersByTimeAsync(19_000);
        expect(late).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_001);
        expect(late).toHaveBeenCalledTimes(1);
        expect(posted).toEqual([]);
        // A slow phone: the community's page says ready at 45 s. Another origin's late ready is still nothing.
        await vi.advanceTimersByTimeAsync(25_000);
        host.dispatchEvent(event(readyMessage(nonce), SPY, win));
        await vi.advanceTimersByTimeAsync(10);
        expect(posted).toEqual([]);
        host.dispatchEvent(event(readyMessage(nonce), BYRON, win));
        await vi.advanceTimersByTimeAsync(10);
        expect(posted).toHaveLength(1);
        expect(posted[0].targetOrigin).toBe(BYRON);
        expect(ends).toEqual([]);
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('nothing at all for 15 minutes: timeout, nothing posted; a window closed before its ready: timeout; after the account: closed', async () => {
        const ends: string[] = [];
        const silent = fakeWindow();
        runHandoff({ win: silent.win, origin: BYRON, nonce, account, listenOn: host, onEnd: (e) => ends.push(e) });
        await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
        host.dispatchEvent(event(readyMessage(nonce), BYRON, silent.win));
        await vi.advanceTimersByTimeAsync(10);
        expect(ends).toEqual(['timeout']);
        expect(silent.posted).toEqual([]);

        const shut = fakeWindow();
        runHandoff({ win: shut.win, origin: BYRON, nonce, account, listenOn: host, onEnd: (e) => ends.push(e) });
        shut.win.closed = true;
        await vi.advanceTimersByTimeAsync(1_001);
        expect(ends).toEqual(['timeout', 'timeout']);

        const second = fakeWindow();
        runHandoff({ win: second.win, origin: BYRON, nonce, account, listenOn: host, onEnd: (e) => ends.push(e) });
        host.dispatchEvent(event(readyMessage(nonce), BYRON, second.win));
        await vi.advanceTimersByTimeAsync(10);
        second.win.closed = true;
        await vi.advanceTimersByTimeAsync(1_001);
        expect(ends).toEqual(['timeout', 'timeout', 'closed']);
    });

    it('isReadyFrom is the one test for the ready', () => {
        const { win } = fakeWindow();
        expect(isReadyFrom(event(readyMessage(nonce), BYRON, win), win, BYRON, nonce)).toBe(true);
        expect(isReadyFrom(event(readyMessage(nonce), BYRON, win), win, SPY, nonce)).toBe(false);
    });
});

describe('the receiver, after Join', () => {
    afterEach(() => { Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true }); });

    it('tells the page it came from, at its origin only, once, gives back the photo ticked, and drops the opener', () => {
        const { win: opener, posted } = fakeWindow();
        Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true });
        awaitHandoffJoin(me.publicKey, opener, GLOBAL, 'f'.repeat(32), 'bundled://bean-green');
        expect(handoffJoined('9'.repeat(64))).toBeNull();
        expect(posted).toEqual([]);
        expect(window.opener).toBe(opener);
        expect(handoffJoined(me.publicKey)).toBe('bundled://bean-green');
        expect(posted).toEqual([{ data: answerMessage('f'.repeat(32), 'joined'), targetOrigin: GLOBAL }]);
        // Its last word said: this page keeps no way to reach (or send elsewhere) the tab that opened it.
        expect(window.opener).toBeNull();
        expect(handoffJoined(me.publicKey)).toBeNull();
        expect(posted).toHaveLength(1);
    });

    it('marks this key as handed over once the yes made it a member, for Home to offer the phone app once (design §2.2)', () => {
        localStorage.clear();
        const { win: opener } = fakeWindow();
        Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true });
        awaitHandoffJoin(me.publicKey, opener, GLOBAL, 'f'.repeat(32), null);
        // Another key's join is not this handoff's: no mark.
        expect(handoffJoined('9'.repeat(64))).toBeNull();
        expect(handedOverHere(me.publicKey)).toBe(false);
        // This key's: marked (no photo ticked, still marked), and for this key only.
        expect(handoffJoined(me.publicKey)).toBeNull();
        expect(handedOverHere(me.publicKey)).toBe(true);
        expect(handedOverHere('9'.repeat(64))).toBe(false);
        // Home takes it once.
        forgetHandedOver();
        expect(handedOverHere(me.publicKey)).toBe(false);
        // The receiver's own path for a key that was a member already (HandoffPage) marks it the same way.
        markHandedOver(me.publicKey);
        expect(handedOverHere(me.publicKey)).toBe(true);
    });
});
