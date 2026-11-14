/**
 * Credit bar amendment, slice R4 (scratch/fable-design/DESIGN-credit-bar-amend-fable.md §9, §11 R4, F23): one name
 * everywhere, and the guide says what the card says.
 *
 * - No string a member, an owner or a keeper reads says "Overdraft Floor" or "Credit Floor" (in any case): the Wallet's
 *   tiles say **Credit line**, as the card does, and so do the other screens that named it a floor. The words layer's
 *   English (every t()/word() call in the phone, the web, core and the server), the 96 catalogs' keys and the node's own
 *   English pause warning are read.
 * - The guide's bar section (`credit-line`, "Where to see it") names the card's own marks and lines from core, and its
 *   examples are core's sentences for the same figures; `your-balance` names the tiles as the apps do; `circulation-fee`
 *   quotes the card's fee note. F23: no page still says a 1- or 2-Bean trade is too small to count.
 * - The 24 copies of those pages name the sheet and the marks with their own catalog's words.
 *
 * The pages are read from content/ (what a test pins is what the page says, not the published copy).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDIT_SHEET_WORDS } from '../credit-sheet.js';
import { CREDIT_STANDING_WORDS, creditBarPicture, creditLineParts, creditStandingCard, type CreditStandingAnswer } from '../credit-standing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GUIDE = join(ROOT, 'packages/beanpool-guide/content');
const CATALOGS = ['packages/beanpool-core/words', 'apps/native/words', 'apps/pwa/words', 'apps/server/words'];
const LANGS = readdirSync(GUIDE).filter((d) => existsSync(join(GUIDE, d, 'manifest.json')));
const FLOOR = /\b(credit|overdraft)\s+floors?\b/i;

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === '__fixtures__') return [];
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}
const isSource = (p: string) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !/\/test-[^/]*\.ts$/.test(p);
/** Every English literal handed to the words layer: t('…'), tn(n, '…', '…'), word('…'), wordn('…', '…'). */
function wordsLiterals(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    const call = /\b(?:t|tn|word|wordn)\(\s*(?:[^,'"`()]+,\s*)?(['"`])((?:\\.|(?!\1)[^\\])*)\1(?:\s*,\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3)?/g;
    for (const m of src.matchAll(call)) out.push(m[2]!, ...(m[4] ? [m[4]] : []));
    return out;
}
const plain = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ');
const lower = (s: string) => plain(s).toLowerCase();
const noStop = (s: string) => s.replace(/\.$/, '');
const section = (page: string, heading: string) => {
    const at = page.indexOf(`## ${heading}`);
    expect(at, `section "${heading}"`).toBeGreaterThanOrEqual(0);
    const next = page.indexOf('\n## ', at + 3);
    return page.slice(at, next < 0 ? undefined : next);
};
const english = (slug: string) => readFileSync(join(GUIDE, 'ledger', `${slug}.md`), 'utf8');
const copy = (lang: string, slug: string) => readFileSync(join(GUIDE, lang, 'ledger', `${slug}.md`), 'utf8');
const catalog = (dir: string, lang: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, dir, `${lang}.json`), 'utf8'));

describe('one name: no screen says "Overdraft Floor" or "Credit Floor"', () => {
    it('no English handed to the words layer, in the phone, the web, core or the server, names a credit or overdraft floor', () => {
        const dirs = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'packages/beanpool-core/src', 'apps/server/src'];
        const files = dirs.flatMap((d) => walk(join(ROOT, d))).filter(isSource);
        expect(files.length, 'source files read').toBeGreaterThan(500);
        const said = files.flatMap((f) => wordsLiterals(f).filter((s) => FLOOR.test(s)).map((s) => `${f.slice(ROOT.length + 1)}: ${s}`));
        expect(said).toEqual([]);
        // The Wallet tiles themselves (the design's §9 row), by their own words.
        const phone = readFileSync(join(ROOT, 'apps/native/app/(tabs)/ledger.tsx'), 'utf8');
        const web = readFileSync(join(ROOT, 'apps/pwa/src/pages/LedgerPage.tsx'), 'utf8');
        expect(phone).toContain("t('CREDIT LINE')");
        expect(web).toContain("t('Credit line')");
        expect(phone).not.toMatch(/t\('CREDIT FLOOR'\)|Floor \{floor\}|Your current floor/);
        expect(web).not.toMatch(/t\('Overdraft Floor'\)|Your current floor/);
    });

    it('no catalog of the 24 languages keeps an English key that names one', () => {
        const keys = CATALOGS.flatMap((dir) => LANGS.flatMap((lang) => Object.keys(catalog(dir, lang)).filter((k) => FLOOR.test(k)).map((k) => `${dir}/${lang}: ${k}`)));
        expect(keys).toEqual([]);
    });

    it("the node's own pause warning, which both apps show as it comes, says credit line", () => {
        const treasury = readFileSync(join(ROOT, 'apps/server/src/routes/treasury.ts'), 'utf8');
        const warnings = [...treasury.matchAll(/pauseWarning = [^;]+;/g)].map((m) => m[0]);
        expect(warnings).toHaveLength(2);
        for (const w of warnings) {
            expect(w).not.toMatch(FLOOR);
            expect(w).toContain('The credit line held for the pause has ended');
            expect(w).toContain('The credit line held for the pause ends in ${pauseDaysRemaining} day');
        }
    });

    it('the vouching budget has one name in the notices too (amendment §7a): no "budget to vouch from" in any English', () => {
        const dirs = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'packages/beanpool-core/src', 'apps/server/src'];
        const said = dirs.flatMap((d) => walk(join(ROOT, d))).filter(isSource)
            .flatMap((f) => wordsLiterals(f).filter((s) => /budget to vouch from/i.test(s)).map((s) => `${f.slice(ROOT.length + 1)}: ${s}`));
        expect(said).toEqual([]);
    });
});

// The figures the guide's examples use: owing 50 of a 500 line, all one vouch, one live Offer (Marty's own card, §0);
// earned 600 and a vouch of 300 with one live Offer (§3); the same 500 line with no live Offer; holding 600.
const vouch = (amount_c: number) => [{ callsign: 'Jane', amount_c }];
const OWING: CreditStandingAnswer = { balance_c: -5000, floor_c: -50000, usableFloor_c: -50000, earnedCredit_c: 0, knownGrant_c: 0, roomHeld_c: 50000, vouchedBy: vouch(50000), liveOffers: 1 };
const PART_CLOSED: CreditStandingAnswer = { balance_c: -12000, floor_c: -90000, usableFloor_c: -50000, earnedCredit_c: 60000, knownGrant_c: 0, roomHeld_c: 30000, vouchedBy: vouch(30000), liveOffers: 1 };
const ASLEEP: CreditStandingAnswer = { ...OWING, balance_c: 0, usableFloor_c: 0, liveOffers: 0 };
const HOLDING: CreditStandingAnswer = { ...OWING, balance_c: 60000 };

describe("the guide's bar section matches the card's words", () => {
    const page = english('credit-line');
    const where = section(page, 'Where to see it');

    it("names every mark with the card's own words and lines, from core", () => {
        const pic = creditBarPicture(OWING);
        const text = lower(where);
        for (const w of [CREDIT_STANDING_WORDS.limit, CREDIT_STANDING_WORDS.balanced, CREDIT_STANDING_WORDS.feeStarts, CREDIT_STANDING_WORDS.noLineYet]) {
            expect(text, String(w)).toContain(String(w).toLowerCase());
        }
        for (const line of [CREDIT_STANDING_WORDS.limitLine, CREDIT_STANDING_WORDS.balancedLine, pic.marks.fee.line]) {
            expect(text, String(line)).toContain(noStop(String(line)).toLowerCase());
        }
        expect(where).toContain(`**${pic.marks.zero.figure}**`);
        expect(where).toContain(`**${pic.marks.fee.figure}**`);
        // The strip and the stripes, in the sheet's words (part 1).
        for (const words of ['a solid block is credit you earned by trading', 'an outlined block is credit someone stands behind for you', 'closed for now', 'your live offers open it']) {
            expect(text, words).toContain(words);
        }
        expect(where).toContain(`**${CREDIT_SHEET_WORDS.title}**`);
    });

    it("its examples are core's sentences for the same figures", () => {
        const owing = creditStandingCard(OWING);
        expect(where).toContain(`"${owing.headline}"`);
        expect(where).toContain(`"${owing.sentence}"`);
        expect(where).toContain(`"${creditLineParts(OWING).line}"`);
        const offers = section(page, 'Your Offers set how much you can use');
        const closed = creditStandingCard(PART_CLOSED);
        expect(offers).toContain(`"${closed.sentence}"`);
        expect(offers).toContain(`"${closed.note!.text}"`);
        expect(offers).toContain(`"${creditStandingCard(ASLEEP).note!.text}"`);
    });

    it("says nothing the card no longer draws, and F23: no trade is too small to open the line", () => {
        for (const old of [/marks on the left/i, /Credit Slider/i, /Post an offer to open your credit line/i, /1 Offer: down to/i, /1 or 2 beans/i, /too small to count/i]) {
            expect(page).not.toMatch(old);
        }
        expect(where).not.toMatch(/floor|overdraft|sweet spot|fee-free/i);
        expect(section(page, 'How it opens')).toContain(`**${CREDIT_STANDING_WORDS.noLineYet}**`);
    });

    it('your-balance names the Wallet tiles as the apps do, and circulation-fee quotes the card\'s fee note', () => {
        const balance = english('your-balance');
        expect(balance).not.toMatch(FLOOR);
        expect(balance).not.toMatch(/your floor/i);
        expect(balance).toContain('**Credit line:**');
        expect(section(balance, 'The Wallet tab')).toContain('In the web app the Wallet tab is shorter: **Credit line**,');
        const fee = section(english('circulation-fee'), 'Seeing it');
        expect(fee).toContain(`"${creditStandingCard(HOLDING).note!.text}"`);
        expect(fee).toContain(`**${CREDIT_STANDING_WORDS.feeStarts}**`);
    });
});

describe('the 24 copies name the sheet and the marks in their own words', () => {
    const value = (dir: string, lang: string, key: string) => {
        const v = catalog(dir, lang)[key];
        return typeof v === 'string' ? v : undefined;
    };

    it.each(LANGS)('%s: credit-line names the sheet and the three marks; your-balance names the tile', (lang) => {
        const page = copy(lang, 'credit-line');
        for (const key of [String(CREDIT_SHEET_WORDS.title), String(CREDIT_STANDING_WORDS.balanced), String(CREDIT_STANDING_WORDS.limit), String(CREDIT_STANDING_WORDS.feeStarts)]) {
            const said = value('packages/beanpool-core/words', lang, key);
            expect(said, `${lang}: core's catalog has "${key}"`).toBeTruthy();
            expect(lower(page), `${lang}: "${key}"`).toContain(said!.toLowerCase());
        }
        const tile = value('apps/pwa/words', lang, 'Credit line');
        expect(tile, `${lang}: the web's "Credit line"`).toBeTruthy();
        expect(lower(copy(lang, 'your-balance')), `${lang}: the tile`).toContain(tile!.toLowerCase());
    });
});
