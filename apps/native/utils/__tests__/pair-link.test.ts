/**
 * The web app's pairing QR scanned with the phone's CAMERA app (utils/pair-link.ts, app/+native-intent.ts,
 * app/pair-device.tsx). Marty, 16 Oct: it opened BeanPool on "Unmatched Route"; only a scan from inside the app worked.
 *
 * - Every shape the system hands over (the link itself on Android, the path forms, cold start and warm) opens the
 *   pairing screen with the whole link, unchanged from the `?` on, so the strict grammar judges what was in the QR.
 * - A garbled pair link still opens the pairing screen, which refuses it in its own words: never Unmatched Route.
 * - On the screen a link is read by the same function as a scan (readPairingCode), so every code gets the same verdict
 *   either way, and the same saved-server rule (transferTarget) decides where it may go.
 * - Nothing is sent on the way: the link's path only fills the sheet; Confirm & Link Device (the member's tap, the
 *   phone's unlock, then the two digits) is still the only thing that sends.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

import { isPairLink, pairLinkFromSystemPath, pairRouteFromSystemPath } from '../pair-link';
import { parsePairingQr, readPairingCode, transferTarget } from '../pair-device-target';
import { redirectSystemPath } from '../../app/+native-intent';

const SESSION = 'a1'.repeat(16);
const PUB = 'b2'.repeat(32);
const OWN = 'https://mullum.example';
/** The QR exactly as the web page builds it (WelcomePage). */
const QUERY = `session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(OWN)}`;
const LINK = `beanpool://pair?${QUERY}`;

/** The `qr` the pairing screen gets for a route: what expo-router decodes from it. */
function qrOf(route: string | null): string | null {
    if (!route) return null;
    const m = /^\/pair-device\?qr=([^&]*)$/.exec(route);
    return m ? decodeURIComponent(m[1]) : null;
}

describe('a pairing link from outside the app opens the pairing screen', () => {
    const shapes: Array<[string, string]> = [
        ['the link itself (Android, and iOS from the camera)', LINK],
        ['a third slash some normalisers add', `beanpool:///pair?${QUERY}`],
        ['the path form with a slash (iOS)', `/pair?${QUERY}`],
        ['the bare path form', `pair?${QUERY}`],
        ['a trailing slash after pair', `beanpool://pair/?${QUERY}`],
        ['the scheme in capitals', `BEANPOOL://pair?${QUERY}`],
    ];

    it.each(shapes)('%s: the whole link, unchanged, on cold start and warm', (_name, systemPath) => {
        for (const initial of [true, false]) {
            const route = redirectSystemPath({ path: systemPath, initial });
            expect(route).toMatch(/^\/pair-device\?qr=/);
            expect(qrOf(route)).toBe(LINK);
        }
    });

    it('the screen reads the link it is given exactly as the QR: same session, key and server', () => {
        const fromLink = parsePairingQr(qrOf(redirectSystemPath({ path: LINK, initial: true })));
        expect(fromLink).toEqual(parsePairingQr(LINK));
        expect(fromLink).toEqual({ sessionId: SESSION, desktopPubHex: PUB, nodeUrl: OWN });
    });

    it('the query is passed on byte for byte, so a hostile spelling the grammar refuses is still refused', () => {
        const hostile = `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://mullum.example\\@evil.test')}`;
        const passed = qrOf(redirectSystemPath({ path: hostile, initial: false }));
        expect(passed).toBe(hostile);
        expect(readPairingCode(passed, 'link')).toEqual({ kind: 'unreadable' });
    });

    it('a garbled pair link opens the pairing screen, which refuses it: never Unmatched Route', () => {
        for (const garbage of ['beanpool://pair', 'beanpool://pair?', 'beanpool://pair?garbage', `beanpool://pair?${QUERY}#x`, `beanpool://pair?${QUERY}&extra=1`, 'pair', '/pair#frag']) {
            const route = redirectSystemPath({ path: garbage, initial: true });
            expect(route, garbage).toMatch(/^\/pair-device\?qr=/);
            expect(readPairingCode(qrOf(route), 'link'), garbage).toEqual({ kind: 'unreadable' });
        }
    });

    it('other links are not pairing links', () => {
        for (const other of ['beanpool://pairing?x=1', 'beanpool://pair-device?qr=x', 'beanpool://paired', 'https://mullum.example/pair?x', 'beanpool://claim?node=x', '/']) {
            expect(pairLinkFromSystemPath(other), other).toBeNull();
            expect(pairRouteFromSystemPath(other), other).toBeNull();
            expect(isPairLink(other), other).toBe(false);
        }
        expect(pairRouteFromSystemPath(undefined)).toBeNull();
        expect(isPairLink(LINK)).toBe(true);
    });
});

describe('on the screen, a link gets the same checks as a scan', () => {
    const codes = [
        LINK,
        `beanpool://pair?session=${SESSION}&pub=${PUB}`,
        `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://castlemaine.example')}`,
        `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://evil.test')}`,
        `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('http://10.0.2.2:3000')}`,
        `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://Mullum.Example')}`,
        `BEANPOOL://PAIR?${QUERY}`,
        `beanpool://pair?session=short&pub=${PUB}`,
    ];

    it.each(codes)('%s', (code) => {
        const camera = readPairingCode(code, 'camera');
        const link = readPairingCode(code, 'link');
        expect(link).toEqual(camera);
        // Where it may go is the saved-server rule's alone, from what the grammar read: the same either way.
        if (link.kind === 'pairing' && camera.kind === 'pairing') {
            expect(transferTarget(link.qr.nodeUrl, OWN, ['https://castlemaine.example']))
                .toEqual(transferTarget(camera.qr.nodeUrl, OWN, ['https://castlemaine.example']));
        }
    });

    it('a server this phone does not use is refused from a link as from a scan', () => {
        const link = readPairingCode(codes[3], 'link');
        expect(link.kind).toBe('pairing');
        if (link.kind === 'pairing') expect(transferTarget(link.qr.nodeUrl, OWN, []).kind).toBe('foreign');
    });

    it('text that is no pairing code: the camera ignores it, a link (opened on purpose) is refused aloud', () => {
        expect(readPairingCode('https://example.com', 'camera')).toEqual({ kind: 'ignore' });
        expect(readPairingCode('https://example.com', 'link')).toEqual({ kind: 'unreadable' });
        expect(readPairingCode(undefined, 'link')).toEqual({ kind: 'unreadable' });
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pair = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf-8'));
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}

describe("the pairing screen's link path (the screen cannot be rendered here: its wiring is read from its source)", () => {
    const readCode = () => slice(pair(), "async function readCode(data: string, source: 'camera' | 'link') {", '\n    }\n');

    it('the camera and the link both go through readCode, which reads with readPairingCode and transferTarget', () => {
        const src = pair();
        expect(src).toContain("await readCode(result.data, 'camera');");
        expect(src).toContain("void readCode(linkCode, 'link');");
        const body = readCode();
        expect(body).toContain('readPairingCode(data, source)');
        expect(body).toContain('transferTarget(parsed.nodeUrl, anchor, saved)');
        expect(body).toContain('setScannedData({ ...parsed, target })');
        expect(src).not.toContain('parsePairingQr(');
    });

    it('reading a code sends nothing: no request, no words read, nothing sealed', () => {
        const body = readCode();
        for (const sends of ['fetch(', 'getMnemonic', 'encryptPairingPayload', 'handleConfirmLink', 'requireDeviceUnlock']) {
            expect(body, sends).not.toContain(sends);
        }
        const effect = slice(pair(), 'useEffect(() => {\n        if (linkCode === undefined', '}, [linkCode]);');
        expect(effect).not.toContain('handleConfirmLink');
        expect(effect).not.toContain('fetch(');
    });

    it('only Confirm & Link Device sends, after the unlock; the transfer says this app shows the digits', () => {
        const src = pair();
        expect(src.split('handleConfirmLink').length - 1).toBe(2); // its definition and the button's onPress
        expect(src).toContain('onPress={handleConfirmLink}');
        const confirm = slice(src, 'async function handleConfirmLink() {', '\n    }\n');
        expect(confirm.indexOf("await requireDeviceUnlock(")).toBeLessThan(confirm.indexOf('await fetch(urls.transfer'));
        expect(slice(confirm, 'await fetch(urls.transfer', '});')).toContain("confirm: 'digits'");
    });

    it("a link never replaces the sheet while an account is on its way or its digits are shown", () => {
        const effect = slice(pair(), 'useEffect(() => {\n        if (linkCode === undefined', '}, [linkCode]);');
        expect(effect).toContain('isTransferringRef.current || confirmCodeRef.current || lockBusyRef.current) return;');
    });

    it('the sheet shows whether or not BeanPool may use the camera: a link needs none', () => {
        expect(pair().split('{sheet}').length - 1).toBe(3);
    });

    it("the root layout doesn't read a pairing link as an invite", () => {
        const layout = code(fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8'));
        const skip = layout.indexOf('if (isPairLink(currentUrl)) return;');
        expect(skip).toBeGreaterThan(-1);
        expect(skip).toBeLessThan(layout.indexOf('const inviteToken = extractInviteToken(currentUrl);'));
    });
});
