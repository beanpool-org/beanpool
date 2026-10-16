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

import { isPairLink, pairLinkFromRoute, pairLinkFromSystemPath, pairRouteFromSystemPath } from '../pair-link';
import { afterJoinRedirect, parsePairingQr, readPairingCode, refusalJoin, transferTarget } from '../pair-device-target';
import { redirectSystemPath } from '../../app/+native-intent';

const SESSION = 'a1'.repeat(16);
const PUB = 'b2'.repeat(32);
const OWN = 'https://mullum.example';
/** The QR exactly as the web page builds it (WelcomePage). */
const QUERY = `session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(OWN)}`;
const LINK = `beanpool://pair?${QUERY}`;

/**
 * The link the pairing screen reads for a route. Expo Router decodes the route's query once reading the path
 * (parseQueryParams), and useLocalSearchParams decodes every value again (expo-router 55 build/hooks.js, which keeps a
 * value it can't decode); the screen then turns the hex back (pairLinkFromRoute). Any other number of decodes: the same.
 */
function qrOf(route: string | null, decodes = 2): string | null {
    if (!route) return null;
    const m = /^\/pair-device\?qr=([^&]*)$/.exec(route);
    if (!m) return null;
    let value = m[1];
    for (let i = 0; i < decodes; i++) {
        try { value = decodeURIComponent(value); } catch { /* kept, as useLocalSearchParams keeps it */ }
    }
    return pairLinkFromRoute(value);
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

    it('the link reaches the screen exactly, however many times the router decodes it (it decodes twice)', () => {
        const odd = [
            LINK,
            `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://mullum.example\\@evil.test')}`,
            `beanpool://pair?${QUERY}%2540x%ZZ%`,
            'beanpool://pair?x=é😀&y=%E9',
        ];
        for (const link of odd) {
            const route = redirectSystemPath({ path: link, initial: false });
            expect(route, link).toMatch(/^\/pair-device\?qr=[0-9a-f]+$/);
            for (const decodes of [0, 1, 2, 3]) expect(qrOf(route, decodes), `${link} ×${decodes}`).toBe(link);
        }
    });

    it('percent-encoded, as before (emulator, #2025 fix round 1): the second decode unescaped node= and every real code was refused', () => {
        const before = `/pair-device?qr=${encodeURIComponent(LINK)}`;
        const screenGot = decodeURIComponent(decodeURIComponent(before.slice('/pair-device?qr='.length)));
        expect(screenGot).toBe(`beanpool://pair?session=${SESSION}&pub=${PUB}&node=${OWN}`);
        expect(readPairingCode(screenGot, 'link')).toEqual({ kind: 'unreadable' });
        // Now: the same link, read as the QR.
        expect(readPairingCode(qrOf(redirectSystemPath({ path: LINK, initial: false })), 'link')).toEqual({ kind: 'pairing', qr: { sessionId: SESSION, desktopPubHex: PUB, nodeUrl: OWN } });
    });

    it('a route value that is not that hex is no link at all: unreadable, nothing guessed', () => {
        for (const bad of ['', 'xyz', '006', '0062ZZZZ', '00620062'.toUpperCase(), LINK, encodeURIComponent(LINK), undefined, 42]) {
            expect(readPairingCode(pairLinkFromRoute(bad), 'link'), String(bad)).toEqual({ kind: 'unreadable' });
        }
        expect(pairLinkFromRoute(undefined)).toBe('');
    });

    it('a very long link is cut to one character over what the grammar reads: still refused, the route stays small', () => {
        const long = `beanpool://pair?${QUERY}${'&x=1'.repeat(5000)}`;
        const route = redirectSystemPath({ path: long, initial: false }) as string;
        expect(route.length).toBeLessThan(2_500);
        expect(qrOf(route)).toBe(long.slice(0, 601));
        expect(readPairingCode(qrOf(route), 'link')).toEqual({ kind: 'unreadable' });
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
        // The route's `qr` is the link as hex (utils/pair-link.ts): turned back before anything reads it.
        expect(src).toContain('const linkCode = qrParam === undefined ? undefined : pairLinkFromRoute(qrParam);');
        const body = readCode();
        expect(body).toContain('readPairingCode(data, source)');
        expect(body).toContain('transferTarget(parsed.nodeUrl, anchor, saved)');
        expect(body).toContain('setScannedData({ ...parsed, target, source })');
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

    it("a link never replaces an open sheet (as a camera scan can't): not while it asks, sends, shows the digits, or at all (review N2)", () => {
        const effect = slice(pair(), 'useEffect(() => {\n        if (linkCode === undefined', '}, [linkCode]);');
        expect(effect).toContain("if (!isTransferringRef.current && !confirmCodeRef.current && !lockBusyRef.current && !scannedDataRef.current) void readCode(linkCode, 'link');");
        // The camera's own guard, for comparison: an open sheet stops it too.
        expect(pair()).toContain('if (isScanningLocked.current || isTransferring || scannedData) return;');
    });

    it('the link is cleared from the route once read (or dropped), so the same link opened again is read again (review N3)', () => {
        const effect = slice(pair(), 'useEffect(() => {\n        if (linkCode === undefined', '}, [linkCode]);');
        const read = effect.indexOf("void readCode(linkCode, 'link');");
        const cleared = effect.indexOf('router.setParams({ qr: undefined });');
        expect(read).toBeGreaterThan(-1);
        // After the read starts, and on its own line: whether the link was read or dropped, it is cleared.
        expect(cleared).toBeGreaterThan(read);
        expect(effect.slice(read, cleared)).toMatch(/^void readCode\(linkCode, 'link'\);\s*$/);
        expect(effect).toMatch(/if \(linkCode === undefined\) return;/);
    });

    it('a sheet opened from a link says so, once, in its own words (review N1)', () => {
        const src = pair();
        expect(readCode()).toContain('setScannedData({ ...parsed, target, source })');
        const line = slice(src, "{scannedData?.source === 'link' && (", '</Text>');
        expect(line).toContain("t('This opened from a link. Go on only if you just pointed your camera at a code on your own screen.')");
        // On the sheet that asks, before anything can be confirmed; not on the digits.
        expect(src.indexOf("{scannedData?.source === 'link' && (")).toBeGreaterThan(src.indexOf("t('Send your whole account to another device?')"));
        expect(src.indexOf("{scannedData?.source === 'link' && (")).toBeLessThan(src.indexOf('onPress={handleConfirmLink}'));
    });

    it('the sheet scrolls, starting at its title: at 320 dp and 1.3x text it is taller than the screen (emulator, fix round 1)', () => {
        const src = pair();
        const sheet = slice(src, '<View style={styles.sheet}>', '</Modal>');
        expect(sheet.indexOf('<ScrollView bounces={false} contentContainerStyle={styles.sheetContent}>')).toBeGreaterThan(-1);
        expect(sheet.indexOf('<ScrollView')).toBeLessThan(sheet.indexOf("t('Send your whole account to another device?')"));
        expect(sheet.indexOf('</ScrollView>')).toBeGreaterThan(sheet.indexOf('onPress={handleDismissSheet}'));
        expect(slice(src, 'sheet: {', '},')).toContain("maxHeight: '90%'");
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

describe('a refused server: join it on this phone first, through its own door, then scan again', () => {
    it("the global community's code: its own door (join-global), back to the pairing screen after", () => {
        const target = transferTarget('https://global.beanpool.org', 'https://beanpool.depincloud.net', []);
        expect(target.kind).toBe('foreign');
        expect(refusalJoin(target)).toEqual({ kind: 'global', href: { pathname: '/join-global', params: { then: 'pair-device' } } });
    });

    it("any other community's code: no join button at all (review B1: a join would make the sender's server one the next scan sends to)", () => {
        for (const node of ['https://castlemaine.example', 'https://castlemaine.example/', 'https://evil-relay.example', 'https://lan.example:8443', 'https://[2001:db8::1]', 'https://global.beanpool.org.evil.example', 'https://beanpool.org']) {
            const target = transferTarget(node, OWN, []);
            expect(target.kind, node).toBe('foreign');
            expect(refusalJoin(target), node).toBeNull();
        }
        // Nor without a community of its own on the phone.
        expect(refusalJoin(transferTarget('https://castlemaine.example', null, []))).toBeNull();
        // Global's code with no community on the phone: still the global door.
        expect(refusalJoin(transferTarget('https://global.beanpool.org/', null, []))?.kind).toBe('global');
    });

    it('no join button for a server this phone uses, for no server, or for a host the strict grammar did not read', () => {
        expect(refusalJoin(transferTarget(OWN, OWN, []))).toBeNull();
        expect(refusalJoin(transferTarget('', null, []))).toBeNull();
        expect(refusalJoin(undefined)).toBeNull();
        // transferTarget only names a host it read in the canonical spelling; any other leaves it empty: no button.
        for (const bad of ['https://Global.Beanpool.org', 'https://mullum.example\\@evil.test', 'https://evil@mullum.example', 'http://castlemaine.example', 'https://castlemaine.example/path']) {
            expect(refusalJoin(transferTarget(bad, OWN, [])), bad).toBeNull();
        }
        // And a hand-made target with such a host is refused by the same grammar.
        for (const scannedHost of ['evil.test/x', 'a@b.example', 'UPPER.example', 'x.example:443x', 'x.example/']) {
            expect(refusalJoin({ kind: 'foreign', scannedHost, appHost: null }), scannedHost).toBeNull();
        }
        // A code the grammar refuses never reaches the sheet at all: the unreadable words, no sheet, no button.
        expect(readPairingCode(`beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent('https://evil@global.beanpool.org')}`, 'link')).toEqual({ kind: 'unreadable' });
    });

    it('after the join: the pairing screen only for the fixed name, every other value keeps the screen it had', () => {
        expect(afterJoinRedirect('pair-device', '/(tabs)')).toBe('/pair-device');
        for (const other of [undefined, '', '/pair-device', 'https://evil.test', '/(tabs)/settings', ['pair-device']]) {
            expect(afterJoinRedirect(other, '/(tabs)'), String(other)).toBe('/(tabs)');
        }
    });

    it('the screens are wired: the global button under the refusal, the global door comes back to pair; People reads no server', () => {
        const src = pair();
        expect(src).toContain('const join = refusalJoin(scannedData?.target);');
        expect(src).toContain('onPress={() => joinFromRefusal(join)}');
        expect(slice(src, 'function joinFromRefusal(', '\n    }\n')).toMatch(/handleDismissSheet\(\);\s*router\.push\(join\.href as any\);/);
        expect(src).toContain("const label = t('🌍 Join the global community');");
        expect(src).not.toContain('Join {host}');
        const global = code(fs.readFileSync(path.resolve(__dirname, '../../app/join-global.tsx'), 'utf-8'));
        expect(global).toContain('redirect: afterJoinRedirect(thenParam, HOME_REDIRECT), name: joined.name');
        // People's invite join is as before: no server filled in from a route, no way back to the pairing screen.
        const people = code(fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/people.tsx'), 'utf-8'));
        expect(people).not.toContain('pair-device-target');
        expect(people).not.toContain('params.server');
        expect(people).not.toContain('params.then');
        expect(people).toContain("const params = useLocalSearchParams<{ view?: string }>();");
    });

    it('the refusal words: the way through at the phone\'s own server; "join" only for global; never "join {host}" or the 12 words', () => {
        const refusal = slice(pair(), 'function targetRefusal(', '\n    }\n');
        expect(refusal).toContain('const global = refusalJoin(target) !== null;');
        // With a community of its own on the phone.
        expect(refusal).toContain("? t('This code is from {host}, a server your phone doesn\\'t use: it uses {own}. Nothing was sent. Open BeanPool at {own} on the other device and scan the code there, or join the global community on this phone first, then scan again.', { host: target.scannedHost, own: target.appHost })");
        expect(refusal).toContain(": t('This code is from {host}, a server your phone doesn\\'t use: it uses {own}. Nothing was sent. Open BeanPool at {own} on the other device and scan the code there.', { host: target.scannedHost, own: target.appHost });");
        // Without one.
        expect(refusal).toContain("? t('This code is from {host}, a server your phone doesn\\'t use. Nothing was sent. Join the global community on this phone first, then scan again.', { host: target.scannedHost })");
        expect(refusal).toContain(": t('This code is from {host}, a server your phone doesn\\'t use. Nothing was sent.', { host: target.scannedHost });");
        for (const never of ['join {host}', 'Join {host}', '12 words', 'restore']) expect(refusal, never).not.toContain(never);
    });
});

/**
 * Every kind of QR or link the phone's camera app (or a message) can hand BeanPool, and the screen it opens: a route
 * file that exists, never Unmatched Route. Expo Router reads `beanpool://<host>/<path>` as the path `<host>/<path>`, and
 * an https link as its path alone (here always `/`: the App Links claim only `/`, utils/__tests__/android-app-links).
 */
describe('every link kind from the camera opens a screen that exists', () => {
    const appDir = path.resolve(__dirname, '../../app');
    /** The route file Expo Router matches for an href the intent hands it, or null: Unmatched Route. */
    function screenFor(href: string): string | null {
        const p = href.replace(/^beanpool:\/\/\/?/i, '').replace(/^https?:\/\/[^/?#]*/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
        if (p === '') return fs.existsSync(path.join(appDir, 'index.tsx')) ? 'index.tsx' : null;
        const segs = p.split('/');
        let dir = appDir;
        const found: string[] = [];
        for (let i = 0; i < segs.length; i++) {
            const last = i === segs.length - 1;
            const entries = fs.readdirSync(dir);
            const exact = last ? entries.find((e) => e === `${segs[i]}.tsx`) : entries.find((e) => e === segs[i]);
            const dynamic = last ? entries.find((e) => /^\[[^\]]+\]\.tsx$/.test(e)) : entries.find((e) => /^\[[^\]]+\]$/.test(e));
            const next = exact ?? dynamic;
            if (!next) return null;
            found.push(next);
            dir = path.join(dir, next);
        }
        return found.join('/');
    }
    const kinds: Array<[string, string, string]> = [
        ['the web pairing QR', LINK, 'pair-device.tsx'],
        ['a garbled pairing link', 'beanpool://pair?garbage', 'pair-device.tsx'],
        ['an invite link (a community on *.beanpool.org; the root layout then reads the invite)', 'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH', 'index.tsx'],
        ['the legacy invite link', 'beanpool://invite?code=INV-ABCD-EFGH&server=https%3A%2F%2Fmullum.beanpool.org', 'invite.tsx'],
        ["the invite page's Open the app", 'beanpool://welcome?invite=INV-ABCD-EFGH&server=https%3A%2F%2Fmullum.beanpool.org', 'welcome.tsx'],
        ['a server claim QR', `beanpool://claim?node=${encodeURIComponent('https://new.example')}&id=a1b2c3d4`, 'claim-community.tsx'],
        ['a shared post', 'https://mullum.beanpool.org/?post=abc123', 'post/[id].tsx'],
        ['a re-key code (the root layout then opens rekey-code)', 'https://mullum.beanpool.org/?rekey=RK-ABCD-1234', 'index.tsx'],
        ['take over with this phone', 'beanpool://unlock-keys?node=x', 'unlock-keys.tsx'],
        ['a group invitation', 'beanpool://group/g1', 'group/[id].tsx'],
        ['pay the commons', 'beanpool://pay-commons?code=d1&amount=5', 'pay-commons.tsx'],
        ['View my profile (from node Settings)', 'beanpool://public-profile?publicKey=ab', 'public-profile.tsx'],
    ];

    it.each(kinds)('%s', (_name, link, screen) => {
        for (const initial of [true, false]) {
            const to = redirectSystemPath({ path: link, initial });
            expect(to, link).not.toBeNull();
            expect(screenFor(to as string), `${link} → ${to}`).toBe(screen);
        }
    });

    it('a pairing link before this change fell through to a route that does not exist (what Marty saw)', () => {
        expect(screenFor(LINK)).toBeNull();
    });
});
