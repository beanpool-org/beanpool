/**
 * Addresses S7, the words (scratch/fable-design/DESIGN-several-addresses-fable.md §8, §9 S7): every sentence the
 * several-addresses feature shows comes from a catalog, in all 25 languages.
 *
 * One table: each §8 sentence the phone, the web, Settings (the manager reads core's words) and the members' notice show,
 * with the catalog it belongs to and the source that shows it. For each row and each of the 24 languages beside English:
 * the catalog holds a non-empty draft whose placeholders are exactly the English ones (every plural form too); and the
 * source hands that very English to t(), tn(), word() or wordn(), so the screen reads the catalog, not literal English.
 * English is the key itself (en has no catalog).
 *
 * §8 lines with no screen yet have no row and no words: the mismatch banner with nowhere to go ("Nothing is sent until it
 * does", Try again, Type an address) and the refusal of a look-alike address (S4 and S5 left both for later), the
 * community sheet's "Reached at … Also answers at …" (S5 split it off), the row after a take-over, and spares (S8). A
 * catalog entry no source uses is refused by `words.mjs check`, so their words come with their screens.
 *
 * The guide checks at the end read the pages (content/, operators/), not the published copies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, PLURAL_SEPARATOR, placeholdersOf } from '../words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OTHERS = LANGS.filter((l) => l !== 'en');

type Catalog = 'apps/native/words' | 'apps/pwa/words' | 'packages/beanpool-core/words' | 'apps/server/words';
interface Row { key: string; catalog: Catalog; sources: string[] }

const PHONE: Catalog = 'apps/native/words';
const WEB: Catalog = 'apps/pwa/words';
const CORE: Catalog = 'packages/beanpool-core/words';
const SERVER: Catalog = 'apps/server/words';

/** The §8 sentences this feature shows today. */
const TABLE: readonly Row[] = [
    // Phone: Home's one line (S4), and the scan refusals for a code at an address that didn't prove (S5).
    { key: '{community} now lives at {address}. This phone uses it from now on. Nothing else changed.', catalog: PHONE, sources: ['apps/native/components/AddressLine.tsx'] },
    { key: '{old} no longer answers as {community}. This phone now uses {address}.', catalog: PHONE, sources: ['apps/native/components/AddressLine.tsx'] },
    { key: "{old} isn't answering. This phone uses {address} for now.", catalog: PHONE, sources: ['apps/native/components/AddressLine.tsx'] },
    { key: "{host} no longer answers as your community, so nothing was sent. Make a new code at your community's main address and scan that one.", catalog: PHONE, sources: ['apps/native/utils/pair-device-target.ts'] },
    { key: "{host} isn't answering right now, so nothing was sent. Try again in a moment.", catalog: PHONE, sources: ['apps/native/utils/pair-device-target.ts'] },
    { key: 'Nothing was sent', catalog: PHONE, sources: ['apps/native/app/settings-signin.tsx'] },
    { key: 'This code is for {codeHost}. Your phone uses {currentHost}. Open Settings at {currentHost} and scan again, or move your phone first.', catalog: PHONE, sources: ['apps/native/app/pair-device.tsx', 'apps/native/components/key-lines.ts'] },
    // Web: the quiet line at an address that is not main, and at one that is no longer listed (S6).
    { key: "This community's main address is now {address}. This address keeps working.", catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: 'This community has moved to {address}.', catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: 'Open it there', catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: "You'll sign in there again, as you would in a new browser.", catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: 'To use {address} from this browser, the phone must be on {address} first, because a Link a device code is refused when the phone and browser are on different addresses.', catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: 'Community address change alert', catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    { key: 'Link this browser from your phone', catalog: WEB, sources: ['apps/pwa/src/components/FormerAddressBanner.tsx'] },
    // Settings → Addresses: core's words, which the manager draws (S6).
    { key: 'Make {address} the main address?', catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: "New members, invites, the directory and search engines are sent there. Members' phones follow by themselves, usually within a day. Every other address keeps working. People on the web stay where they are and are shown the new address.", catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: '{address} is now the main address.', catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: "Members' phones will trust {address} as this community once it answers with this server's key, and people can sign in on the web there. Only add an address you control.", catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: 'Add it', catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: 'Keep {address} as well: it is the way back if the domain ever lapses.', catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    { key: `Members' phones follow this list: {n} address, main {address}.${PLURAL_SEPARATOR}Members' phones follow this list: {n} addresses, main {address}.`, catalog: CORE, sources: ['packages/beanpool-core/src/address-reach.ts'] },
    // The notice to members (§8 "Notice to members"), at a claim and at Make main.
    { key: 'This community has a new address', catalog: SERVER, sources: ['apps/server/src/services/address-notice.ts'] },
    { key: "This community's main address is now {address}. Your app follows by itself. The old address keeps working.", catalog: SERVER, sources: ['apps/server/src/services/address-notice.ts'] },
];

/** The placeholders the brief names, and the pairing lines' hosts. Nothing else may appear in a §8 key. */
const KNOWN_PLACEHOLDERS = new Set(['community', 'address', 'old', 'addresses', 'n', 'time', 'name', 'host', 'codeHost', 'currentHost']);

const catalogs = new Map<string, Record<string, unknown>>();
function catalog(dir: Catalog, lang: string): Record<string, unknown> {
    const file = join(ROOT, dir, `${lang}.json`);
    if (!catalogs.has(file)) catalogs.set(file, JSON.parse(readFileSync(file, 'utf8')));
    return catalogs.get(file)!;
}

/** Every English literal a source hands to the words layer: t('…'), tn(n, '…', '…'), word('…'), wordn('…', '…'), unescaped. */
function wordsLiterals(file: string): Set<string> {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const out = new Set<string>();
    const lit = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
    const call = new RegExp(String.raw`\b(?:t|tn|word|wordn)\(\s*(?:[^,'"\x60()]+,\s*)?${lit}(?:\s*,\s*${lit.replace('\\1', '\\3').replace('\\1', '\\3')})?`, 'g');
    const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
    for (const m of src.matchAll(call)) {
        out.add(unescape(m[2]!));
        if (m[4] !== undefined) out.add(unescape(m[4]));
    }
    return out;
}

const sorted = (xs: string[]) => [...new Set(xs)].sort();
const isPlural = (key: string) => key.includes(PLURAL_SEPARATOR);

describe('several addresses §8: each sentence, in every language', () => {
    it('the table is the feature\'s words: 23 rows, each key once, only the placeholders the feature uses', () => {
        expect(TABLE).toHaveLength(23);
        expect(new Set(TABLE.map((r) => r.key)).size).toBe(TABLE.length);
        for (const row of TABLE) {
            for (const p of placeholdersOf(row.key)) expect(KNOWN_PLACEHOLDERS.has(p), `${row.key}: {${p}}`).toBe(true);
        }
        expect(OTHERS).toHaveLength(24);
    });

    it.each(TABLE.map((r) => [r.key, r] as const))('the screen reads the catalog key: %s', (_key, row) => {
        const halves = isPlural(row.key) ? row.key.split(PLURAL_SEPARATOR) : [row.key];
        for (const source of row.sources) {
            const said = wordsLiterals(source);
            for (const half of halves) expect(said.has(half), `${source} hands "${half}" to t()/word()`).toBe(true);
        }
    });

    for (const row of TABLE) {
        it.each(OTHERS.map((l) => [l] as const))(`${row.catalog} %s: ${row.key.slice(0, 60)}`, (lang) => {
            const value = catalog(row.catalog, lang)[row.key];
            if (isPlural(row.key)) {
                const english = sorted(placeholdersOf(row.key.split(PLURAL_SEPARATOR)[1]!));
                expect(value && typeof value === 'object', `${lang}: a plural entry`).toBe(true);
                const forms = Object.entries(value as Record<string, unknown>);
                expect(forms.length, `${lang}: forms`).toBeGreaterThan(0);
                for (const [form, text] of forms) {
                    expect(typeof text === 'string' && text.trim().length > 0, `${lang} ${form}: non-empty`).toBe(true);
                    expect(sorted(placeholdersOf(text as string)), `${lang} ${form}: placeholders`).toEqual(english);
                    expect(text as string).not.toContain('Ʀ');
                }
                return;
            }
            expect(typeof value === 'string' && value.trim().length > 0, `${lang}: present and non-empty`).toBe(true);
            expect(sorted(placeholdersOf(value as string)), `${lang}: placeholders`).toEqual(sorted(placeholdersOf(row.key)));
            expect(value as string).not.toContain('Ʀ');
        });
    }

    it('the sentences S7 replaced are gone from every catalog and every source', () => {
        const gone = [
            'This community is also at {address}. The old address keeps working.',
            'This code is for {codeHost}. Your phone uses {currentHost}. Open Settings at {currentHost} and scan again, or move your phone first (Home card).',
        ];
        for (const dir of [PHONE, WEB, CORE, SERVER]) {
            for (const lang of OTHERS) for (const key of gone) expect(catalog(dir, lang)[key], `${dir}/${lang}: ${key}`).toBeUndefined();
        }
        const sources = ['apps/server/src/services/address-notice.ts', 'apps/native/app/pair-device.tsx', 'apps/native/components/key-lines.ts', 'apps/native/utils/settings-signin.ts'];
        for (const s of sources) expect(readFileSync(join(ROOT, s), 'utf8'), s).not.toMatch(/\(Home card\)|is also at \{address\}/);
    });
});

describe('several addresses §8: the guide', () => {
    const GUIDE = join(ROOT, 'packages/beanpool-guide');
    const page = (rel: string) => readFileSync(join(GUIDE, rel), 'utf8');
    const section = (text: string, heading: string) => {
        const at = text.indexOf(`\n## ${heading}\n`);
        if (at < 0) return null;
        const next = text.indexOf('\n## ', at + 4);
        return text.slice(at, next < 0 ? undefined : next);
    };

    it('the operators\' page: no follow card and no "has to type the new address"; Make main, phones follow by themselves, spares', () => {
        const text = page('operators/server/address-and-peers.md');
        expect(text).not.toMatch(/Use the new address|Use that address from now on|has to type the new address/);
        expect(text).toContain('**Make main**');
        expect(text).toMatch(/[Pp]hones follow by themselves/);
        expect(text).toMatch(/\*\*[Ss]pares?\*\*/);
    });

    it('the operators\' alert list quotes the notice members get, word for word', () => {
        expect(page('operators/server/updates-and-health.md')).toContain(
            "\"This community's main address is now yourtown.beanpool.org. Your app follows by itself. The old address keeps working.\"",
        );
    });

    it('members: one short section "If your community changes its address", and no card to tap, in English', () => {
        const text = page('content/getting-started/communities.md');
        expect(text.split('\n## If your community changes its address\n')).toHaveLength(2);
        const body = section(text, 'If your community changes its address')!;
        expect(body.split(/\s+/).length, 'short').toBeLessThan(170);
        expect(body).toContain('**Open it there**');
        expect(body).toContain('**Link this browser from your phone**');
        expect(text).not.toMatch(/Use the new address|Use that address for now|\*\*Not now\*\*, and the card/);
        expect(page('content/getting-started/home.md')).not.toMatch(/a card above all of these asks whether to use it/);
    });

    it.each(OTHERS.map((l) => [l] as const))('members, %s: the copy carries the section with the web line\'s own words, and no card to tap', (lang) => {
        const file = join(GUIDE, 'content', lang, 'getting-started', 'communities.md');
        expect(existsSync(file), file).toBe(true);
        const text = readFileSync(file, 'utf8');
        const web = catalog(WEB, lang);
        expect(text).toContain(`**${web['Open it there'] as string}**`);
        expect(text).toContain(`**${web['Link this browser from your phone'] as string}**`);
        // The old card's English sentence, quoted in some copies, and its 7-day "Not now".
        expect(text).not.toContain('This community is also at beans.example.org');
    });
});
