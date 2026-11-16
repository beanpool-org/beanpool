/**
 * A person's name as it is read, cut and served (name-line.ts cleanName, clipName, servedName; group-guest-chat.ts
 * guestNameLine; outside-chat.ts addressCardName), #3275 round 3: Home's cards cut a guest's line at 60, so a 60-character
 * card name lost " · a.example · guest", and "Ana" padded with zero-width spaces read "Ana…" beside the member Ana.
 * Round 4: reading a name clean took out the joiners real names are spelled with (a rainbow flag after "Sam", a Persian surname with its non-joiner), so
 * members' names changed on group lines and cards main's core signed stopped verifying. One table below: every name a
 * person really writes reads exactly as written, and only padding and spoofing go. Every character that shows nothing is
 * written here as an escape, never literally.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { NAME_LINE_CHARS, NAME_LINE_MAX, cleanName, clipName, servedName } from '../name-line.js';
import { guestNameLine } from '../group-guest-chat.js';
import { addressCardDigest, addressCardName, addressCardVerifies, signAddressCard, type AddressCard } from '../outside-chat.js';
import { toBase64 } from '../request-signing.js';
import { LANGS } from '../words.js';

/** What shows nothing, read by Unicode's own property (Node knows it): Cf, the combining grapheme joiner, the Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/u;

const seed = sha256(utf8ToBytes('beanpool relay vector: Ana'));
const key = bytesToHex(ed25519.getPublicKey(seed));
const sign = (b: Uint8Array) => ed25519.sign(b, seed);

/**
 * A card as main's core signed it before #3275 (d30445fa): its addressCardName was the name trimmed, 1 to 60 characters, on
 * one line; the digest and the signature are this core's unchanged (outside-chat.ts addressCardDigest). Null for a name it
 * refused.
 */
// eslint-disable-next-line no-control-regex -- main's own test for a line break or another control character
const MAIN_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
function mainSigned(name: string): AddressCard | null {
    const n = name.trim();
    if (n.length === 0 || n.length > 60 || MAIN_CONTROL.test(n)) return null;
    return { v: 1, key, home: 'a.example', name: n, sig: toBase64(sign(addressCardDigest({ key, home: 'a.example', name: n }))) };
}
/** The name a phone on main put on its own card: its callsign, each run of spaces one, trimmed, cut to 60 (utils/outside-mail.ts). */
const mainPhoneName = (callsign: string) => callsign.replace(/\s+/g, ' ').trim().slice(0, 60);

/** Names people really write: one or more in every shipped language's script, and emoji. Each reads exactly as written. */
const REAL_NAMES: Array<[string, string, string]> = [
    ['emoji', 'a rainbow flag (a joiner after a presentation selector)', 'Sam \u{1F3F3}\uFE0F\u200D\u{1F308}'],
    ['emoji', 'a woman technologist (a joiner)', 'Dev \u{1F469}\u200D\u{1F4BB}'],
    ['emoji', 'a transgender flag (a joiner, two selectors)', 'Kai \u{1F3F3}\uFE0F\u200D⚧\uFE0F'],
    ['emoji', 'a family (three joiners)', 'Mia \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'],
    ['emoji', 'an astronaut with a skin tone (a joiner after the tone)', 'Ari \u{1F9D1}\u{1F3FD}\u200D\u{1F680}'],
    ['emoji', 'a handshake of two skin tones', 'Jo \u{1FAF1}\u{1F3FB}\u200D\u{1FAF2}\u{1F3FF}'],
    ['emoji', 'a waving hand with a skin tone', 'Lou \u{1F44B}\u{1F3FF}'],
    ['emoji', 'a heart on fire', 'Bea ❤\uFE0F\u200D\u{1F525}'],
    ['emoji', 'a polar bear (the selector last)', 'Ola \u{1F43B}\u200D❄\uFE0F'],
    ['emoji', 'an eye in a speech bubble', 'Eve \u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F'],
    ['emoji', 'keycaps', 'Team 1\uFE0F⃣ #\uFE0F⃣'],
    ['emoji', 'a country\'s flag', 'Tom \u{1F1E6}\u{1F1FA}'],
    ['emoji', 'Scotland\'s flag (tag characters)', 'Ewan \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
    ['emoji', 'Wales\' flag (tag characters)', 'Gwen \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'],
    ['emoji', 'a text-style smiley and a red heart (the two selectors)', 'Ivy ☺\uFE0E ❤\uFE0F'],
    ['en', 'English', 'Siobhán O\'Brien-Smith'],
    ['en', 'English, letters and their accents written apart (combining marks)', 'Zoë Ríos'],
    ['en', 'a no-break space between two names', 'Jean\u00A0Paul'],
    ['es', 'Spanish', 'José Álvarez Muñoz'],
    ['pt', 'Portuguese', 'Maria da Conceição'],
    ['fr', 'French', 'François Lefèvre'],
    ['it', 'Italian', 'Niccolò Rossi'],
    ['de', 'German', 'Jürgen Groß'],
    ['tr', 'Turkish', 'Şükrü Öztürk'],
    ['id', 'Indonesian', 'Siti Nurhaliza'],
    ['sw', 'Swahili', 'Amani Wanjiku'],
    ['fil', 'Filipino', 'Juan dela Cruz'],
    ['vi', 'Vietnamese', 'Nguyễn Văn An'],
    ['el', 'Greek', 'Γιώργος Παπαδόπουλος'],
    ['ru', 'Russian', 'Алёна Иванова'],
    ['uk', 'Ukrainian', 'Ґанна Їжак'],
    ['ar', 'Arabic', 'محمد عبد الله'],
    ['fa', 'Persian, a surname with a non-joiner', 'مهدی\u200Cزاده'],
    ['fa', 'Persian, a given name with a non-joiner', 'علی\u200Cرضا'],
    ['ur', 'Urdu', 'فاطمہ ثناء'],
    ['hi', 'Hindi', 'अनीता शर्मा'],
    ['hi', 'Hindi, a half form (a joiner after the virama)', 'क्\u200Dष'],
    ['hi', 'Hindi, the virama shown (a non-joiner after it)', 'क्\u200Cष'],
    ['hi', 'Hindi, the eyelash ra', 'र्\u200Dया'],
    ['bn', 'Bengali', 'রবীন্দ্রনাথ ঠাকুর'],
    ['bn', 'Bengali, the ra-phala with a joiner', 'র\u200D্যাব'],
    ['ml', 'Malayalam, its chillus as one character each', 'അർജുൻ'],
    ['ml', 'Malayalam, its chillus written with a joiner, the last at the end', 'അര്\u200Dജുന്\u200D'],
    ['ml', 'Malayalam, two words, each ending in a chillu written with a joiner', 'മോഹന്\u200D ലാല്\u200D'],
    ['ta', 'Tamil', 'ஸ்ரீநிவாசன் செல்வி'],
    ['ja', 'Japanese, an ideographic space between the names', '山田\u3000太郎'],
    ['ja', 'Japanese, kana', 'さくら カタカナ'],
    ['ja', 'Japanese, an ideographic variation selector', '葛\u{E0100}飾北斎'],
    ['ko', 'Korean', '김민준'],
    ['zh-Hans', 'Chinese (simplified)', '王小明'],
    ['zh-Hant', 'Chinese (traditional)', '陳大文'],
];

/** Padding and spoofing: what shows nothing where it joins nothing, runs of it, and the direction overrides. */
const CLEANED: Array<[string, string, string]> = [
    ['zero-width spaces after it', `Ana${'\u200B'.repeat(56)}`, 'Ana'],
    ['a run of joiners after it', `Ana${'\u200D'.repeat(56)}`, 'Ana'],
    ['a run of non-joiners after it', `Ana${'\u200C'.repeat(56)}`, 'Ana'],
    ['a run of joiners between two letters', 'A\u200D\u200D\u200Cna', 'Ana'],
    ['a run of joiners inside an emoji', 'Sam \u{1F3F3}\uFE0F\u200D\u200D\u{1F308}', 'Sam \u{1F3F3}\uFE0F\u{1F308}'],
    ['a joiner at the start', '\u200DAna', 'Ana'],
    ['a joiner at the end, after a letter (no virama)', 'Ana\u200C', 'Ana'],
    ['a joiner beside a space', 'Ana \u200DRíos\u200C Lee', 'Ana Ríos Lee'],
    ['a run of joiners after a virama', 'അര്\u200D\u200D', 'അര്'],
    ['a run of variation selectors after a letter', `Ana${'\uFE0F'.repeat(56)}`, 'Ana\uFE0F'],
    ['a run of ideographic variation selectors', `葛${'\u{E0100}'.repeat(28)}`, '葛\u{E0100}'],
    ['a run of selectors after an emoji', '❤\uFE0F\uFE0E\uFE0F Bea', '❤\uFE0F Bea'],
    ['a variation selector at the start and after a space', '\uFE0FAna \uFE0FRíos', 'Ana Ríos'],
    ['tag characters with no flag', 'Ana\u{E0041}\u{E007F}', 'Ana'],
    ['a run of tag characters', `Ana${'\u{E0020}'.repeat(28)}`, 'Ana'],
    ['tags on a black flag with no cancel tag', `\u{1F3F4}${'\u{E0067}'.repeat(20)} Ewan`, '\u{1F3F4} Ewan'],
    ['tags on a black flag past a region\'s length', `\u{1F3F4}${'\u{E0067}'.repeat(20)}\u{E007F} Ewan`, '\u{1F3F4} Ewan'],
    ['a flag\'s tags on a letter', 'A\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}na', 'Ana'],
    ['a right-to-left override around it', '\u202EAna\u202C', 'Ana'],
    ['a right-to-left override that shows "anA" as "Ana"', '\u202EanA', 'anA'],
    ['isolates, a byte-order mark and a soft hyphen', '\u2066Ana\u2069\uFEFF\u00AD', 'Ana'],
    ['direction marks', '\u200FAna\u200E\u061C', 'Ana'],
    ['Hangul fillers and a combining grapheme joiner', 'A\u3164n\uFFA0a\u115F\u1160\u034F', 'Ana'],
    ['invisible characters before, between and after its letters (one joiner between two letters stays)', '\u200BA\u200Dn\u2066a\u202E\uFEFF', 'A\u200Dna'],
    ['runs of spaces, no-break and ideographic spaces', '  Ana \u00A0\u3000 Ríos ', 'Ana Ríos'],
    ['nothing that shows', '\u200B\u200D\uFE0F\u{E007F}', ''],
];

describe('cleanName: a name a person really writes is never changed; only padding and spoofing go (#3275 round 4)', () => {
    it('the real names cover every shipped language', () => {
        const langs = new Set(REAL_NAMES.map(([lang]) => lang));
        expect(LANGS.filter((l) => !langs.has(l))).toEqual([]);
    });

    it.each(REAL_NAMES)('%s, %s: read, cut, served and carried on a card as written; a card main signed over it still verifies', async (_lang, _what, name) => {
        expect(cleanName(name)).toBe(name);
        expect(clipName(name)).toBe(name);
        expect(servedName(name)).toBe(name);
        expect(addressCardName(name)).toBe(name);
        expect(guestNameLine(name, 'a.example', NAME_LINE_CHARS)).toBe(`${name} · a.example · guest`);
        // A card main's core signed, over the name as given and as its phone wrote it, verifies on this core.
        for (const signed of [mainSigned(name), mainSigned(mainPhoneName(name))]) {
            expect(signed).not.toBeNull();
            expect(addressCardVerifies(signed)).toBe(true);
        }
        // A phone on this core signs the name as written.
        expect((await signAddressCard({ key, home: 'a.example', name }, sign)).name).toBe(name);
    });

    it.each(CLEANED)('%s: %j reads %j', async (_what, raw, clean) => {
        expect(cleanName(raw)).toBe(clean);
        expect(cleanName(clean)).toBe(clean);
        expect(addressCardName(raw)).toBe(clean || null);
        expect(guestNameLine(raw, 'a.example', NAME_LINE_CHARS)).toBe(`${clean || '…'} · a.example · guest`);
        // A phone on this core signs the clean name; a card main signed over the padded one no longer verifies (#3275's PR
        // lists these: only padding and spoofing changes a name).
        if (clean) expect((await signAddressCard({ key, home: 'a.example', name: raw }, sign)).name).toBe(clean);
        const main = mainSigned(raw);
        if (main && main.name !== clean) expect(addressCardVerifies(main)).toBe(false);
    });

    it('every format character Unicode names (\\p{Cf}) goes where it joins nothing; between two letters only a joiner stays', () => {
        const all: string[] = [];
        for (let cp = 0; cp <= 0x10ffff; cp++) {
            if (cp >= 0xd800 && cp <= 0xdfff) continue;
            const ch = String.fromCodePoint(cp);
            if (/\p{Cf}/u.test(ch)) all.push(ch);
        }
        expect(all.length).toBeGreaterThan(150);
        const left: string[] = [];
        for (const ch of all) {
            const u = `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`;
            const joiner = ch === '\u200C' || ch === '\u200D';
            if (cleanName(`Ana${ch}`) !== 'Ana') left.push(`${u} at the end`);
            if (cleanName(`${ch}Ana`) !== 'Ana') left.push(`${u} at the start`);
            if (cleanName(`An ${ch}a`) !== 'An a') left.push(`${u} after a space`);
            if (cleanName(`A${ch}${ch}na`) !== 'Ana') left.push(`${u} in a run`);
            if (cleanName(`A${ch}na`) !== (joiner ? `A${ch}na` : 'Ana')) left.push(`${u} between two letters`);
        }
        expect(left).toEqual([]);
    });

    it('a variation selector stays only as the one straight after a character that shows', () => {
        const selectors: string[] = [];
        for (let cp = 0xfe00; cp <= 0xfe0f; cp++) selectors.push(String.fromCodePoint(cp));
        for (let cp = 0xe0100; cp <= 0xe01ef; cp++) selectors.push(String.fromCodePoint(cp));
        const left = selectors.filter((vs) => cleanName(`A${vs}${vs}${vs}na`) !== `A${vs}na` || cleanName(`${vs}Ana`) !== 'Ana'
            || cleanName(`Ana ${vs}`) !== 'Ana' || cleanName(`A\u200D${vs}na`) !== 'Ana');
        expect(left.map((vs) => vs.codePointAt(0)!.toString(16))).toEqual([]);
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
        // A cut inside an emoji's sequence or a flag's tags keeps only what reads clean, so nothing passing it on changes it.
        ['Sam \u{1F3F3}\uFE0F\u200D\u{1F308}!', 8, 'Sam \u{1F3F3}\uFE0F…'],
        ['Ewan \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}!', 9, 'Ewan \u{1F3F4}…'],
        // A Malayalam chillu written with a joiner keeps its joiner before "…".
        ['അര്\u200Dജുന്\u200D', 5, 'അര്\u200D…'],
    ])('%j in %d reads %j', (raw, max, want) => {
        expect(clipName(raw, max)).toBe(want);
        expect(servedName(want)).toBe(want);
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
