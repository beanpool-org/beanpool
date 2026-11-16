/**
 * "Use your account on another device" sends the key and the 12 words only to a server this phone already uses, and
 * only to the phone's own saved address for it (utils/pair-device-target.ts; fable-security-signin finding 1, and the
 * deciding review of #1983, BLOCKING 1).
 *
 * The review's case: a QR naming `https://mullum.example\@evil.test` passed a WHATWG-origin check (it reads
 * mullum.example) and the phone then posted to the QR's own string, which iOS's NSURL sends to evil.test. Now the QR is
 * read by a strict grammar (any other spelling is refused outright), and the request goes to the matched saved origin,
 * never to the scanned text. Every hostile spelling below ends with nothing sent; the real saved servers are reached at
 * exactly their own origin.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAppCommunity, isUnreadablePairingQr, pairingRequestUrls, parsePairingQr, provedAtScan, transferTarget } from '../pair-device-target';
import { communityRecordOf, resetCommunityIndexForTests, setCommunityIndex, type CommunityRecord } from '../community-index';
import type { AddressAnswer } from '../address-decide';

const SESSION = 'a1'.repeat(16);
const PUB = 'b2'.repeat(32);
const OWN = 'https://mullum.example';
const SAVED = ['https://castlemaine.example', 'https://lan.example:8443'];

/** The QR exactly as the web page builds it (WelcomePage): the node encoded with encodeURIComponent. */
const qr = (node: string) => `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(node)}`;

/** What the phone does with a scanned QR: the transfer URL it would post to, or 'refused' (nothing sent). */
function decide(raw: string, own: string | null = OWN, saved: readonly string[] = SAVED): string {
    const parsed = parsePairingQr(raw);
    if (!parsed) return 'refused';
    const target = transferTarget(parsed.nodeUrl, own, saved);
    return target.kind === 'ok' ? pairingRequestUrls(target, parsed.sessionId).transfer : 'refused';
}

describe('hostile spellings of a server: refused, nothing sent', () => {
    const hostile: Array<[string, string]> = [
        ["the review's case: backslash then @", qr('https://mullum.example\\@evil.test')],
        ['two backslashes then @', qr('https://mullum.example\\\\@evil.test')],
        ['backslash then @, not encoded in the QR', `beanpool://pair?session=${SESSION}&pub=${PUB}&node=https://mullum.example\\@evil.test`],
        ['a login before the host', qr('https://evil@mullum.example')],
        ['the host as a login, then another host', qr('https://mullum.example@evil.test')],
        ['an encoded @ (%40) in the host', qr('https://mullum.example%40evil.test')],
        ['an @ encoded twice in the QR', `beanpool://pair?session=${SESSION}&pub=${PUB}&node=https%3A%2F%2Fmullum.example%2540evil.test`],
        ['an encoded backslash (%5C)', qr('https://mullum.example%5C@evil.test')],
        ['upper case', qr('https://MULLUM.example')],
        ['a trailing dot', qr('https://mullum.example.')],
        ['the default port written out', qr('https://mullum.example:443')],
        ['another port', qr('https://mullum.example:8443')],
        ["the saved node's port with a leading zero", qr('https://lan.example:08443')],
        ["the saved node without its port", qr('https://lan.example')],
        ['an IPv4 address for a name', qr('https://203.0.113.5')],
        ['an IPv4 address as one number', qr('https://3405803781')],
        ['an IPv4 address in hex', qr('https://0xcb.0.113.5')],
        ['an IPv6 form', qr('https://[::ffff:203.0.113.5]')],
        ['a tab in the host', qr('https://mullum.example\t@evil.test')],
        ['a newline in the host', qr('https://mullum.example\n.evil.test')],
        ['a tab in the QR itself', `beanpool://pair?session=${SESSION}&pub=${PUB}&node=${encodeURIComponent(OWN)}\t`],
        ['http', qr('http://mullum.example')],
        ['a path', qr('https://mullum.example/evil')],
        ['a path that names another host', qr('https://mullum.example/@evil.test')],
        ['a query', qr('https://mullum.example?x@evil.test')],
        ['a fragment', qr('https://mullum.example#x')],
        ['two trailing slashes', qr('https://mullum.example//')],
        ['a look-alike (Cyrillic а)', qr('https://mullum.exаmple')],
        ['the look-alike in punycode', qr('https://mullum.xn--exmple-4nf')],
        ['a suffix look-alike', qr('https://mullum.example.attacker.example')],
        ['a server the phone never used', qr('https://attacker.example')],
        ['a scheme that is no server', qr('javascript:alert(1)')],
        ['no scheme', qr('//mullum.example')],
        ['an extra parameter', `${qr(OWN)}&x=1`],
        ['node given twice', `${qr('https://attacker.example')}&node=${encodeURIComponent(OWN)}`],
        ['a plain https link instead of the pairing QR', `https://mullum.example/?session=${SESSION}&pub=${PUB}`],
        ['the QR in other case', qr(OWN).replace('beanpool://pair', 'BEANPOOL://pair')],
    ];
    for (const [name, raw] of hostile) {
        it(name, () => expect(decide(raw)).toBe('refused'));
    }
});

describe('a pairing code that fails the grammar is said so, not ignored (confirmation review, NON-BLOCKING 2)', () => {
    // Before, the camera kept scanning and the member saw nothing: a bad code looked like a camera that had not focused.
    const unreadable: Array<[string, string]> = [
        ["the review's case: backslash then @", qr('https://mullum.example\\@evil.test')],
        ['a login before the host', qr('https://evil@mullum.example')],
        ['upper case host', qr('https://MULLUM.example')],
        ['http (a dev page)', qr('http://localhost:5173')],
        ['a path (a custom node URL)', qr('https://mullum.example/evil')],
        ['an extra parameter', `${qr(OWN)}&x=1`],
        ['node given twice', `${qr('https://attacker.example')}&node=${encodeURIComponent(OWN)}`],
        ['a short session', `beanpool://pair?session=abc&pub=${PUB}`],
        ['the prefix alone', 'beanpool://pair?'],
        ['the QR in other case', qr(OWN).replace('beanpool://pair', 'BEANPOOL://PAIR')],
        ['a leading space', ` ${qr(OWN)}`],
        ['padded past 600 characters', `${qr(OWN)}&x=${'0'.repeat(600)}`],
    ];
    for (const [name, raw] of unreadable) {
        it(name, () => {
            expect(parsePairingQr(raw)).toBeNull();
            expect(isUnreadablePairingQr(raw)).toBe(true);
        });
    }

    it('a code that reads is not refused here (the sheet decides where it may go)', () => {
        for (const raw of [qr(OWN), qr('https://attacker.example'), qr('https://mullum.example:443'), `beanpool://pair?session=${SESSION}&pub=${PUB}`]) {
            expect(isUnreadablePairingQr(raw)).toBe(false);
        }
    });

    it('any other QR is still ignored, as before', () => {
        for (const raw of [
            '', 'hello', 'https://mullum.example/', `https://mullum.example/?session=${SESSION}&pub=${PUB}`,
            'beanpool://claim?node=mullum.example&code=x', 'beanpool://join?code=x', `beanpool:pair?session=${SESSION}&pub=${PUB}`,
        ]) {
            expect(isUnreadablePairingQr(raw)).toBe(false);
        }
        expect(isUnreadablePairingQr(undefined)).toBe(false);
        expect(isUnreadablePairingQr(42)).toBe(false);
    });
});

describe("the phone's own servers: reached at exactly their saved origin", () => {
    it("the community it is on, at its own origin, with or without one trailing slash", () => {
        expect(decide(qr(OWN))).toBe('https://mullum.example/api/pair/transfer');
        expect(decide(qr(`${OWN}/`))).toBe('https://mullum.example/api/pair/transfer');
    });

    it('a phone with two communities: each QR goes to its own one', () => {
        const saved = ['https://castlemaine.example', OWN];
        expect(decide(qr('https://castlemaine.example'), OWN, saved)).toBe('https://castlemaine.example/api/pair/transfer');
        expect(decide(qr(OWN), OWN, saved)).toBe('https://mullum.example/api/pair/transfer');
        // On castlemaine, the mullum QR still reaches mullum, a saved community.
        expect(decide(qr(OWN), 'https://castlemaine.example', saved)).toBe('https://mullum.example/api/pair/transfer');
    });

    it('a saved node with its port', () => {
        expect(decide(qr('https://lan.example:8443'))).toBe('https://lan.example:8443/api/pair/transfer');
    });

    it("the address used is the phone's canonical one, not the QR's spelling", () => {
        // Saved as typed long ago; the QR spells it canonically. The request goes to the saved server's canonical origin.
        expect(decide(qr(OWN), 'https://Mullum.Example/', [])).toBe('https://mullum.example/api/pair/transfer');
        const target = transferTarget('https://mullum.example/', OWN, []);
        expect(target).toEqual({ kind: 'ok', nodeUrl: 'https://mullum.example' });
        if (target.kind === 'ok') {
            expect(pairingRequestUrls(target, SESSION)).toEqual({
                probe: `https://mullum.example/api/pair/poll?session=${SESSION}`,
                transfer: 'https://mullum.example/api/pair/transfer',
                cancel: 'https://mullum.example/api/pair/cancel',
            });
        }
    });

    it("a QR with no server goes to the phone's own", () => {
        expect(decide(`beanpool://pair?session=${SESSION}&pub=${PUB}`)).toBe('https://mullum.example/api/pair/transfer');
    });

    it('https only: an http server, the phone\'s own or saved, is never a target (the screen keeps no cleartext check)', () => {
        expect(transferTarget('', 'http://10.0.2.2:3000', [])).toEqual({ kind: 'no-node' });
        expect(transferTarget('', 'http://localhost:3000', ['http://192.168.1.5:3000'])).toEqual({ kind: 'no-node' });
        expect(decide(qr('http://10.0.2.2:3000'), 'http://10.0.2.2:3000', ['http://10.0.2.2:3000'])).toBe('refused');
        expect(transferTarget('https://10.0.2.2:3000', 'http://10.0.2.2:3000', ['http://10.0.2.2:3000']).kind).toBe('foreign');
        for (const own of [OWN, 'https://lan.example:8443', 'https://[2001:db8::1]:8443']) {
            const target = transferTarget('', own, SAVED);
            expect(target.kind === 'ok' && target.nodeUrl.startsWith('https://')).toBe(true);
        }
    });

    it('a saved address that is not plain is never a target', () => {
        expect(decide(qr('https://evil.test'), 'https://mullum.example\\@evil.test', ['https://x@evil.test'])).toBe('refused');
    });

    it('a phone on no community sends to no QR server', () => {
        expect(decide(qr('https://attacker.example'), null, [])).toBe('refused');
        expect(transferTarget('', null, [])).toEqual({ kind: 'no-node' });
    });

    it('the refusal names both servers', () => {
        expect(transferTarget('https://attacker.example', OWN, SAVED)).toEqual({ kind: 'foreign', scannedHost: 'attacker.example', appHost: 'mullum.example' });
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pair = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf-8'));

describe('pair-device: the rule is wired in (the screen cannot be rendered here, see vitest.config.ts)', () => {
    it('reads the QR with the strict grammar and checks it at scan, against its community and its saved ones', () => {
        const scan = pair().slice(pair().indexOf('async function handleBarcodeScanned('), pair().indexOf('async function handleConfirmLink('));
        // A scan and a link from the camera app (utils/__tests__/pair-link.test.ts) are both read here, by one reader.
        expect(scan).toContain("await readCode(result.data, 'camera');");
        expect(scan).toContain('const read = readPairingCode(data, source);');
        expect(scan).toContain('const parsed = read.qr;');
        // Against its community and its saved ones, any address their own lists name, and proved again at the scan (S5).
        expect(scan).toContain('const target = await provedAtScan(transferTarget(parsed.nodeUrl, anchor, saved), (address, peerId) => proofAt(address, peerId));');
        expect(scan).toContain("await AsyncStorage.getItem('beanpool_anchor_url')");
        expect(scan).toContain('await getSavedNodes()');
        expect(pair()).not.toContain('parsePairingUri');
        expect(pair()).not.toMatch(/new URL\(/);
    });

    it('a target that is not ok asks nothing, reads nothing and sends nothing', () => {
        const body = pair().slice(pair().indexOf('async function handleConfirmLink() {'));
        const refused = body.indexOf("if (!target || target.kind !== 'ok') {");
        expect(refused).toBeGreaterThan(-1);
        for (const later of ['await requireDeviceUnlock(', 'await getMnemonic(identity)', 'encryptPairingPayload(', 'await fetch(']) {
            expect(body.indexOf(later)).toBeGreaterThan(refused);
        }
    });

    it("every request goes to the matched saved origin (pairingRequestUrls), never to the QR's text", () => {
        const fetches = pair().match(/fetch\(([^,)]*)/g) ?? [];
        // The only requests the screen makes: the probe, the transfer, and the cancel (a relay that gave no four digits,
        // and the member's Cancel), each built from the matched origin.
        expect(fetches).toEqual(['fetch(urls.probe', 'fetch(urls.transfer', 'fetch(urls.cancel', 'fetch(pairingRequestUrls(target']);
        expect(pair()).toContain('fetch(pairingRequestUrls(target, scannedData.sessionId).cancel, {');
        expect(pair()).toContain('const urls = pairingRequestUrls(target, scanned.sessionId);');
        expect(pair()).not.toMatch(/scanned(?:Data)?\??\.nodeUrl/);
    });

    it('asks the relay first, and an older one is told so before the words are read', () => {
        const body = pair().slice(pair().indexOf('async function handleConfirmLink() {'));
        const probe = body.indexOf('await fetch(urls.probe');
        expect(probe).toBeGreaterThan(-1);
        expect(body.indexOf("probeBody.status === 'waiting'")).toBeGreaterThan(probe);
        expect(body.indexOf('await getMnemonic(identity)')).toBeGreaterThan(body.indexOf("probeBody.status === 'waiting'"));
    });

    it('Cancel while the digits are up tells the relay to drop the account; Done does not', () => {
        const dismiss = pair().slice(pair().indexOf('function handleDismissSheet() {'), pair().indexOf('if (!permission) {'));
        expect(dismiss).toMatch(/if \(confirmCode && scannedData && target\?\.kind === 'ok'\) \{\s*fetch\(pairingRequestUrls\(target, scannedData\.sessionId\)\.cancel/);
        expect(pair()).toContain("tap Cancel and the other device gets nothing");
        expect(pair()).toMatch(/onPress=\{handleDismissSheet\} accessibilityRole="button">\s*<Text style=\{styles\.cancelBtnText\}>\{t\('Cancel'\)\}/);
    });

    it('a pairing code that fails the grammar: one sentence, the scanner held until OK, nothing sent', () => {
        const scan = pair().slice(pair().indexOf('async function handleBarcodeScanned('), pair().indexOf('function targetRefusal('));
        const from = scan.indexOf("if (read.kind !== 'pairing') {");
        const to = scan.indexOf('Haptics.NotificationFeedbackType.Success');
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        const refused = scan.slice(from, to);
        expect(refused).toContain("if (read.kind === 'unreadable') {");
        expect(refused).toContain('isScanningLocked.current = true;');
        expect(refused).toMatch(/Alert\.alert\('', t\('This code can\\'t be read safely, so nothing was sent: make a new code on the other device and scan that one\.'\), \[\{ text: t\('OK'\), onPress: resumeScanning \}\], \{ cancelable: false \}\)/);
        expect(refused).toContain('return;');
        for (const never of ['fetch(', 'setScannedData(', 'transferTarget(', 'getMnemonic(']) expect(refused).not.toContain(never);
    });

    it('the Confirm button shows only for a server this phone uses', () => {
        expect(pair()).toMatch(/\{scannedData\?\.target\?\.kind === 'ok' && \(\s*<Pressable\s+style=\{\[styles\.confirmBtn/);
    });
});

/**
 * Addresses S5 (scratch/fable-design/DESIGN-several-addresses-fable.md §3.6): a pairing code that names any address of one
 * of the phone's communities is accepted. The account still goes only to an address the phone itself holds (its own
 * spelling, from its saved rows or the community's signed list it keeps), never the scanned text, and the address is
 * proved again at the scan: an address that answers as something else, or not at all, gets nothing.
 *
 * The table: code kind (names the address in use, the main, another proved address, a listed address not yet proved, an
 * address no longer listed, a stranger's, or none) x address state at the scan (proves, answers as something else or an
 * older server, not answering) x the phone's community record (with its key and list; with no key, an older server) ->
 * where the account goes.
 */
describe('S5: a code at any address of one of the phone\'s communities (pair-device-target table)', () => {
    const USING = 'https://riverside.example';
    const MAIN = 'https://coop.example.org';
    const OTHER = 'https://ourtown.example.net';
    const LISTED = 'https://new.example.net';
    const DROPPED = 'https://lapsed.example.com';
    const STRANGER = 'https://stranger.example';
    const PEER = '12D3KooWRiverside';
    const signedList = { list: { v: 1, peerId: PEER, communityId: 'c1', epoch: 2, seq: 14, main: 'coop.example.org', addresses: ['riverside.example', 'coop.example.org', 'ourtown.example.net', 'new.example.net'], spares: [] }, sig: 'x' };
    /** The phone's record: met at DROPPED, now using USING, with the key and the list (proved: USING, MAIN, OTHER). */
    const keyed: CommunityRecord = {
        v: 1, id: DROPPED, using: USING, peerId: PEER, communityId: 'c1', epoch: 2,
        proved: { [USING]: { at: 1, epoch: 2 }, [MAIN]: { at: 1, epoch: 2 }, [OTHER]: { at: 1, epoch: 2 } }, refused: { [DROPPED]: { at: 1, why: 'status 421' } },
        list: signedList as unknown as CommunityRecord['list'],
    };
    /** An older server: no key, no list; only its own address. */
    const keyless: CommunityRecord = { v: 1, id: USING, using: USING, proved: {}, refused: {} };

    type Code = 'the address in use' | 'the main' | 'another proved address' | 'a listed address not yet proved' | 'an address no longer listed' | 'a stranger\'s address' | 'no address';
    const CODE: Record<Code, string> = {
        'the address in use': USING, 'the main': MAIN, 'another proved address': OTHER, 'a listed address not yet proved': LISTED,
        'an address no longer listed': DROPPED, 'a stranger\'s address': STRANGER, 'no address': '',
    };
    type State = 'proves' | 'answers as something else' | 'proves at an older take-over count' | 'not answering';
    const ANSWER: Record<State, AddressAnswer> = {
        proves: { kind: 'proved', epoch: 2, seq: 14 }, 'answers as something else': { kind: 'other-key', why: 'status 421' },
        'proves at an older take-over count': { kind: 'proved', epoch: 1, seq: 30 }, 'not answering': { kind: 'silent' },
    };

    async function whereFor(code: Code, state: State, record: CommunityRecord): Promise<{ to: string; asked: string[] }> {
        setCommunityIndex([record]);
        const asked: string[] = [];
        const first = transferTarget(CODE[code], USING, [USING], communityRecordOf);
        const target = await provedAtScan(first, async (address, peerId) => { asked.push(`${address} ${peerId}`); return ANSWER[state]; });
        resetCommunityIndexForTests();
        return { to: target.kind === 'ok' ? target.nodeUrl : target.kind, asked };
    }

    const rows: Array<[Code, State, 'keyed' | 'keyless', string]> = [];
    for (const code of Object.keys(CODE) as Code[]) {
        for (const state of Object.keys(ANSWER) as State[]) {
            const address = CODE[code];
            // With the key and the list: the code's address, in the phone's own spelling, when the list names it (or no
            // address: the address in use), proved at the scan; else nothing goes.
            const listed = address === '' || [USING, MAIN, OTHER, LISTED].includes(address);
            const keyedTo = !listed ? 'foreign'
                : state === 'proves' ? (address || USING)
                    : state === 'not answering' ? 'not-answering' : 'replaced';
            rows.push([code, state, 'keyed', keyedTo]);
            // An older server (no key): today's rule, the saved address only, string for string, with nothing to prove.
            rows.push([code, state, 'keyless', address === '' || address === USING ? USING : 'foreign']);
        }
    }

    for (const [code, state, kind, to] of rows) {
        it(`${code}, ${state}, a record ${kind === 'keyed' ? 'with its key and list' : 'with no key (an older server)'} -> ${to}`, async () => {
            const got = await whereFor(code, state, kind === 'keyed' ? keyed : keyless);
            expect(got.to).toBe(to);
            // Proved at the scan exactly when the record has the key and the code names one of its listed addresses, and
            // only that address, with the record's key: never the scanned text, never a stranger.
            const proves = kind === 'keyed' && to !== 'foreign';
            expect(got.asked).toEqual(proves ? [`${(CODE[code] || USING).slice('https://'.length)} ${PEER}`] : []);
        });
    }

    it('the account goes to the phone\'s own spelling of the address, from the list it keeps: the scanned text is only compared', () => {
        setCommunityIndex([keyed]);
        const target = transferTarget(`${OTHER}/`, USING, [USING], communityRecordOf);
        resetCommunityIndexForTests();
        expect(target).toEqual({ kind: 'ok', nodeUrl: OTHER, prove: { peerId: PEER, epoch: 2 } });
        expect(pairingRequestUrls(target as Extract<typeof target, { kind: 'ok' }>, SESSION).transfer).toBe(`${OTHER}/api/pair/transfer`);
    });

    it('another saved community\'s other address goes to that community, and is not the community in front', () => {
        const hilltop: CommunityRecord = { ...keyed, id: 'https://hilltop.example', using: 'https://hilltop.example', peerId: 'peer-h', proved: {}, refused: {},
            list: { ...signedList, list: { ...signedList.list, peerId: 'peer-h', main: 'hilltop.example', addresses: ['hilltop.example', 'hill.example.org'] } } as unknown as CommunityRecord['list'] };
        setCommunityIndex([keyless, hilltop]);
        const target = transferTarget('https://hill.example.org', USING, [USING, 'https://hilltop.example'], communityRecordOf);
        expect(target).toEqual({ kind: 'ok', nodeUrl: 'https://hill.example.org', prove: { peerId: 'peer-h', epoch: 2 } });
        expect(isAppCommunity(target, USING)).toBe(false);
        setCommunityIndex([keyed]);
        expect(isAppCommunity(transferTarget(MAIN, USING, [USING], communityRecordOf), USING)).toBe(true);
        resetCommunityIndexForTests();
    });

    it('a list kept under another key than the record\'s names nothing: a code there is refused', () => {
        setCommunityIndex([{ ...keyed, list: { ...signedList, list: { ...signedList.list, peerId: 'someone-else' } } as unknown as CommunityRecord['list'] }]);
        expect(transferTarget(MAIN, USING, [USING], communityRecordOf).kind).toBe('foreign');
        resetCommunityIndexForTests();
    });
});
