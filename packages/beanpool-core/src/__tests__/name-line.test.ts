/**
 * A person's name as it is read, cut and served (name-line.ts cleanName, clipName, servedName; group-guest-chat.ts
 * guestNameLine; outside-chat.ts addressCardName), #3275 round 3: Home's cards cut a guest's line at 60, so a 60-character
 * card name lost " · a.example · guest", and "Ana" padded with zero-width spaces read "Ana…" beside the member Ana.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { NAME_LINE_CHARS, NAME_LINE_MAX, cleanName, clipName, servedName } from '../name-line.js';
import { guestNameLine } from '../group-guest-chat.js';
import { addressCardDigest, addressCardName, addressCardVerifies, signAddressCard } from '../outside-chat.js';
import { toBase64 } from '../request-signing.js';

/** What shows nothing, read by Unicode's own property (Node knows it): Cf, the combining grapheme joiner, the Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/u;

describe('cleanName', () => {
    it('takes out every format character Unicode names (\\p{Cf}), however the written-out list in name-line.ts was made', () => {
        const all: string[] = [];
        for (let cp = 0; cp <= 0x10ffff; cp++) {
            if (cp >= 0xd800 && cp <= 0xdfff) continue;
            const ch = String.fromCodePoint(cp);
            if (/\p{Cf}/u.test(ch)) all.push(ch);
        }
        expect(all.length).toBeGreaterThan(150);
        const left = all.filter((ch) => cleanName(`A${ch}na`) !== 'Ana').map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
        expect(left).toEqual([]);
    });

    it.each([
        ['Ana', 'Ana'],
        ['  Ana  Ríos ', 'Ana Ríos'],
        ['Ana\u00A0\u3000 Ríos', 'Ana Ríos'],
        [`Ana${'\u200B'.repeat(56)}`, 'Ana'],
        ['\u202EAna\u202C', 'Ana'],
        ['\u202EanA', 'anA'],
        ['\u2066Ana\u2069\uFEFF\u00AD', 'Ana'],
        ['A\u3164n\uFFA0a\u115F\u1160\u034F', 'Ana'],
        ['Ana\u{E0041}\u{E007F}', 'Ana'],
        ['\u200B\u200D', ''],
    ])('%j reads %j', (raw, clean) => {
        expect(cleanName(raw)).toBe(clean);
        expect(INVISIBLE.test(cleanName(raw))).toBe(false);
    });

    it('keeps every letter, mark and emoji that shows', () => {
        for (const name of ['Ana Ríos', 'Zoë', 'Nguyễn Văn An', '鸡蛋', 'Алёна', 'محمد', 'देवनागरी', 'Ana 🙂', 'J.R. Smith']) expect(cleanName(name)).toBe(name);
    });

    it('is no name for what is not text', () => {
        expect(cleanName(undefined)).toBe('');
        expect(cleanName(null)).toBe('');
        expect(cleanName(42)).toBe('');
    });
});

describe('clipName', () => {
    const name60 = 'Wren Tallowmere of the Long Valley Seed Library and Mill Coo';
    it.each([
        ['Ana', 60, 'Ana'],
        [name60, 60, name60],
        [`${name60}p`, 60, 'Wren Tallowmere of the Long Valley Seed Library and Mill Co…'],
        // A cut that lands after a space keeps no space before "…".
        ['Ana Ríos Tallowmere', 5, 'Ana…'],
        // Never fewer than the first character and "…".
        ['Ana', 1, 'A…'],
        ['Ana', -4, 'A…'],
        // Whole code points: the emoji is kept whole or dropped whole.
        ['Ana🙂🙂🙂', 5, 'Ana🙂…'],
        // Read clean first: padding doesn't count, and doesn't push the name past the cut.
        [`Ana${'\u200B'.repeat(56)}`, 4, 'Ana'],
    ])('%j in %d reads %j', (raw, max, want) => {
        expect(clipName(raw, max)).toBe(want);
    });

    it('cuts at NAME_LINE_CHARS by default, and servedName only past NAME_LINE_MAX', () => {
        expect([...clipName('x'.repeat(200))].length).toBe(NAME_LINE_CHARS);
        expect(servedName('x'.repeat(200))).toBe('x'.repeat(200));
        expect([...servedName('x'.repeat(NAME_LINE_MAX + 5))].length).toBe(NAME_LINE_MAX);
    });
});

describe('guestNameLine: the card name is cut, never " · <home> · guest"', () => {
    const NAME60 = 'Wren Tallowmere of the Long Valley Seedbank Library and Mill Coop';
    // The longest home a server can have: 253 characters of host and a port.
    const LONGEST_HOME = `${'h'.repeat(63)}.${'o'.repeat(63)}.${'m'.repeat(63)}.${'e'.repeat(53)}.example:65535`;
    const HOMES = ['a.example', 'the-long-name-of-a-community-garden-and-its-shed.green.hills.example:8443', LONGEST_HOME];
    const NAMES: Array<[string, string]> = [
        ...[1, 40, 41, 58, 59, 60].map((n): [string, string] => [NAME60.slice(0, n), NAME60.slice(0, n)]),
        [`Ana${'\u200B'.repeat(56)}`, 'Ana'],
        ['\u202EAna\u202C', 'Ana'],
        [`${NAME60.slice(0, 30)}\u200B\u202E${NAME60.slice(30, 60)}\u2069`, NAME60.slice(0, 60)],
    ];

    it('the longest home a server has is 259 characters', () => {
        expect(LONGEST_HOME.length).toBe(259);
    });

    for (const home of HOMES) {
        it.each(NAMES)(`%j from ${home.slice(0, 24)}…`, (card, clean) => {
            const tail = ` · ${home} · guest`;
            const line = guestNameLine(card, home, NAME_LINE_CHARS);
            expect(line.endsWith(tail)).toBe(true);
            expect(INVISIBLE.test(line)).toBe(false);
            const shown = line.slice(0, -tail.length);
            const room = NAME_LINE_CHARS - [...tail].length;
            if ([...clean].length <= Math.max(2, room)) {
                expect(shown).toBe(clean);
            } else {
                expect(shown.endsWith('…')).toBe(true);
                expect(clean.startsWith(shown.slice(0, -1))).toBe(true);
                expect([...line].length).toBeLessThanOrEqual(Math.max(NAME_LINE_CHARS, 2 + [...tail].length));
            }
            // Whatever the home, nothing a place passes it on through (servedName) cuts it again.
            expect([...line].length).toBeLessThanOrEqual(NAME_LINE_MAX);
            expect(servedName(line)).toBe(line);
        });
    }

    it('with no `max` (the apps), the whole card name, read clean', () => {
        expect(guestNameLine(NAME60, 'a.example')).toBe(`${NAME60} · a.example · guest`);
        expect(guestNameLine(`Ana${'\u200B'.repeat(56)}`, 'a.example')).toBe('Ana · a.example · guest');
        expect(guestNameLine('\u200B\u200B', 'a.example')).toBe('… · a.example · guest');
    });
});

describe('addressCardName and the card: only a clean name gets in', () => {
    const seed = sha256(utf8ToBytes('beanpool relay vector: Ana'));
    const key = bytesToHex(ed25519.getPublicKey(seed));
    const sign = (b: Uint8Array) => ed25519.sign(b, seed);

    it.each([
        [`Ana${'\u200B'.repeat(56)}`, 'Ana'],
        ['\u202EAna\u202C', 'Ana'],
        ['Ana  \u00A0Ríos', 'Ana Ríos'],
        ['  Ana Ríos ', 'Ana Ríos'],
    ])('%j is the name %j', (raw, clean) => {
        expect(addressCardName(raw)).toBe(clean);
    });

    it.each([['Ana\nRíos'], ['Ana\u2028Ríos'], ['Ana\u0007'], ['\u200B\u200B'], ['x'.repeat(61)]])('%j is no name', (raw) => {
        expect(addressCardName(raw)).toBeNull();
    });

    it('a phone signs the clean name; a card signed over a padded one is no card', async () => {
        const padded = `Ana${'\u200B'.repeat(56)}`;
        const card = await signAddressCard({ key, home: 'a.example', name: padded }, sign);
        expect(card.name).toBe('Ana');
        expect(addressCardVerifies(card)).toBe(true);
        const handMade = { v: 1, key, home: 'a.example', name: padded, sig: toBase64(sign(addressCardDigest({ key, home: 'a.example', name: padded }))) };
        expect(addressCardVerifies(handMade)).toBe(false);
    });
});
