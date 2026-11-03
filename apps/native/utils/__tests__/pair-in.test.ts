/**
 * Already a member → Scan from a browser (front doors S9; utils/pair-in.ts, app/pair-in.tsx). What the phone reads from
 * the browser's code, what it takes from the browser's seal, how a link from the camera app reaches the screen, and that a
 * phone with no account may stay on it.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() }, StyleSheet: { create: (s: unknown) => s } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) }));

import { createPairingSession, createPairInKey, openPairingPayloadOnPhone, sealPairingPayloadToPhone, recoveryWordsFromEntropy } from '@beanpool/core';
import { isPairInLink, isUnreadablePairInQr, pairInLinkFromRoute, pairInRouteFromSystemPath, pairInUrls, parsePairInQr, readPairInAccount } from '../pair-in';
import { isPairLink } from '../pair-link';
import { parsePairingQr } from '../pair-device-target';
import { setupRedirect } from '../auth-return';
import { mnemonicToKeypair } from '../crypto';
import { redirectSystemPath as routeSystemPath } from '../../app/+native-intent';

const SESSION = 'a1'.repeat(16);
const PUB = 'b2'.repeat(32);
const NODE = 'https://mullum.example';
/** The code exactly as the web page builds it (apps/pwa BringToPhone). */
const LINK = `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(NODE)}`;

describe("the browser's code, read strictly", () => {
    it('reads the code the web page makes', () => {
        expect(parsePairInQr(LINK)).toEqual({ sessionId: SESSION, browserPubHex: PUB, nodeUrl: NODE });
        expect(parsePairInQr(`beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://lan.example:8443/')}`)?.nodeUrl)
            .toBe('https://lan.example:8443');
    });

    const refused: Array<[string, string]> = [
        ['no community named (a new phone has none of its own)', `beanpool://pair-in?session=${SESSION}&pub=${PUB}`],
        ['an http community', `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('http://mullum.example')}`],
        ['a login in the address', `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://mullum.example@evil.test')}`],
        ['a backslash trick', `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://mullum.example\\@evil.test')}`],
        ['a path after the host', `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://mullum.example/x')}`],
        ['upper case host', `beanpool://pair-in?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://Mullum.example')}`],
        ['a parameter twice', `${LINK}&pub=${PUB}`],
        ['an extra parameter', `${LINK}&then=home`],
        ['a short key', `beanpool://pair-in?session=${SESSION}&pub=${PUB.slice(2)}&node=${encodeURIComponent(NODE)}`],
        ['a short session', `beanpool://pair-in?session=abc&pub=${PUB}&node=${encodeURIComponent(NODE)}`],
        ['the other direction\'s code', `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(NODE)}`],
        ['too long', `${LINK}${'a'.repeat(600)}`],
    ];
    for (const [what, raw] of refused) {
        it(`refuses ${what}`, () => expect(parsePairInQr(raw)).toBeNull());
    }

    it('says a refused pair-in code is unreadable, and ignores any other QR', () => {
        expect(isUnreadablePairInQr(`beanpool://pair-in?session=${SESSION}`)).toBe(true);
        expect(isUnreadablePairInQr('https://example.com')).toBe(false);
        expect(isUnreadablePairInQr(LINK)).toBe(false);
    });

    it("the other direction's reader refuses this code, so an older app's pairing screen sends nothing to it", () => {
        expect(parsePairingQr(LINK)).toBeNull();
    });

    it('sends only to fixed paths on the code\'s community', () => {
        expect(pairInUrls(parsePairInQr(LINK)!)).toEqual({
            offer: `${NODE}/api/pair/offer`, collect: `${NODE}/api/pair/collect`, cancel: `${NODE}/api/pair/cancel`,
        });
    });
});

describe("what the phone takes from the browser's seal", () => {
    const words = recoveryWordsFromEntropy(new Uint8Array(16).fill(7));

    it('the 12 words and the key they make, with the name to show; never a private key', async () => {
        const { publicKeyHex } = await mnemonicToKeypair(words);
        const account = readPairInAccount({ version: 1, publicKey: publicKeyHex, mnemonic: words, callsign: 'Ana', privateKey: 'f'.repeat(64) });
        expect(account).toEqual({ publicKey: publicKeyHex, words, callsign: 'Ana' });
        expect(Object.keys(account!)).not.toContain('privateKey');
    });

    it('refuses words that make another account, too few words, or another version', async () => {
        const { publicKeyHex } = await mnemonicToKeypair(words);
        const other = recoveryWordsFromEntropy(new Uint8Array(16).fill(9));
        expect(readPairInAccount({ version: 1, publicKey: publicKeyHex, mnemonic: other })).toBeNull();
        expect(readPairInAccount({ version: 1, publicKey: publicKeyHex, mnemonic: words.slice(0, 11) })).toBeNull();
        expect(readPairInAccount({ version: 2, publicKey: publicKeyHex, mnemonic: words })).toBeNull();
        expect(readPairInAccount({ version: 1, publicKey: publicKeyHex })).toBeNull();
        expect(readPairInAccount(null)).toBeNull();
    });

    it('a seal opens only with the key the code showed', async () => {
        const { publicKeyHex } = await mnemonicToKeypair(words);
        const browser = createPairingSession();
        const swapped = createPairingSession();
        const phone = createPairInKey();
        const sealed = sealPairingPayloadToPhone({ version: 1, publicKey: publicKeyHex, mnemonic: words }, swapped.privateKeyHex, phone.publicKeyHex, browser.sessionId);
        expect(() => openPairingPayloadOnPhone(sealed.ciphertextHex, sealed.nonceHex, browser.publicKeyHex, phone.privateKeyHex, browser.sessionId)).toThrow();
    });
});

describe('a pair-in link from the camera app opens the screen', () => {
    function redirect(p: string): string | null {
        const to = routeSystemPath({ path: p, initial: false });
        if (to instanceof Promise) throw new Error('routed later');
        return to as string | null;
    }
    for (const [what, p] of [['the link', LINK], ['a third slash', LINK.replace('beanpool://', 'beanpool:///')], ['the path form', LINK.replace('beanpool://', '/')]] as const) {
        it(`${what}: to /pair-in, the whole link as hex, read back exactly after the router's two decodes`, () => {
            const route = redirect(p);
            expect(route).toMatch(/^\/pair-in\?qr=[0-9a-f]+$/);
            const hex = decodeURIComponent(decodeURIComponent(route!.slice('/pair-in?qr='.length)));
            expect(parsePairInQr(pairInLinkFromRoute(hex))).toEqual({ sessionId: SESSION, browserPubHex: PUB, nodeUrl: NODE });
        });
    }

    it('is told from the other pairing link and from invites', () => {
        expect(isPairInLink(LINK)).toBe(true);
        expect(isPairLink(LINK)).toBe(false);
        expect(pairInRouteFromSystemPath(`beanpool://pair?session=${SESSION}`)).toBeNull();
        expect(pairInRouteFromSystemPath('beanpool://pair-into?x=1')).toBeNull();
        expect(redirect(`beanpool://pair?session=${SESSION}&pub=${PUB}`)).toMatch(/^\/pair-device\?qr=/);
    });

    it('the root layout leaves it alone as an invite', () => {
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');
        const code = layout.indexOf('if (isPairInLink(currentUrl)) return;');
        expect(code).toBeGreaterThan(-1);
        expect(code).toBeLessThan(layout.indexOf('const inviteToken = '));
    });
});

describe('a phone with no account may stay on the screen; one with an account takes nothing there', () => {
    it('the root guard keeps pair-in with no identity', () => {
        expect(setupRedirect(['pair-in'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();
        expect(setupRedirect(['pair-device'], { hasIdentity: false, pendingOnboarding: false })).toBe('/welcome');
    });

    const screen = fs.readFileSync(path.resolve(__dirname, '../../app/pair-in.tsx'), 'utf-8');
    it('restores from the words through restoreFromWords, with no confirmReplace (another account is never replaced)', () => {
        const call = screen.slice(screen.indexOf('await restoreFromWords('), screen.indexOf('});', screen.indexOf('await restoreFromWords(')));
        expect(call).toContain('account.words, qr.nodeUrl');
        expect(call).not.toContain('confirmReplace');
        expect(screen).not.toMatch(/\.privateKey\b(?!Hex)/);
    });

    it('sends nothing before a scan, or a tap on a link\'s Continue', () => {
        const offerCalls = screen.match(/offer\(/g) ?? [];
        // The scan's call and Continue's call: nothing on mount.
        expect(offerCalls.length).toBe(2);
        expect(screen).toMatch(/setStep\(qr \? \{ kind: 'ask', qr \}/);
    });

    it('opens the seal only with the code\'s key, never one the relay names', () => {
        expect(screen).toContain('openPairingPayloadOnPhone(res!.body.ciphertextHex, res!.body.nonceHex, s.qr.browserPubHex, key.privateKeyHex, s.qr.sessionId)');
    });
});
