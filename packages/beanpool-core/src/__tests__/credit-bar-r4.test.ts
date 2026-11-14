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
 *   quotes the card's fee note. F23: no English page of the guide (every page under content/, not only credit-line)
 *   still says a 1- or 2-Bean trade is too small to count.
 * - The 24 copies of those pages name the sheet and the marks with their own catalog's words.
 * - No guide page, English or copy, keeps the old Offer list ("1 Offer: down to 200 … the smaller of the two") or, in any
 *   language, F23's sentence; how-it-works carries credit-line's Offer rule, in English and in each copy.
 *
 * The pages are read from content/ (what a test pins is what the page says, not the published copy).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDIT_SHEET_WORDS } from '../credit-sheet.js';
import { beans } from '../hundredths.js';
import { earnedCreditFromValue } from '../protocol.js';
import { CREDIT_STANDING_WORDS, creditBarPicture, creditLineParts, creditStandingCard, type CreditStandingAnswer } from '../credit-standing.js';
import { VOUCH_PRESET_WORDS } from '../vouch-presets.js';

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

    // F23 across the guide: the line opens, and Send unlocks, with any completed trade. The send gate is
    // earnedCredit > 0 (state-engine's transfer), and a 1-Bean trade already earns some.
    it('F23 on every English page: no page says a 1- or 2-Bean trade is too small to count', () => {
        expect(earnedCreditFromValue(beans(1)), 'a 1-Bean trade earns credit').toBeGreaterThan(0);
        const pages = walk(GUIDE).filter((p) => p.endsWith('.md') && !LANGS.some((lang) => p.startsWith(join(GUIDE, lang) + '/')));
        expect(pages.length, 'English pages read').toBeGreaterThan(50);
        const said = pages.flatMap((p) => readFileSync(p, 'utf8').split('\n')
            .filter((line) => /\b(1|one) or (2|two) beans?\b|too small to count/i.test(line))
            .map((line) => `${p.slice(GUIDE.length + 1)}: ${line}`));
        expect(said).toEqual([]);
        // The four places that said it now say the opposite, as credit-line does.
        const howItWorks = readFileSync(join(GUIDE, 'about/how-it-works.md'), 'utf8');
        expect(section(howItWorks, 'Gifts')).toContain('once you have completed a trade in the market, however small.');
        expect(section(howItWorks, 'Going below zero: your credit line')).toContain('It opens when you complete your first trade in the market, however small.');
        expect(section(english('gifts'), 'Before you can')).toContain('You need to have completed a trade in the market, however small.');
        expect(section(readFileSync(join(GUIDE, 'about/faq.md'), 'utf8'), "Why can't I send a gift?")).toContain('You must have completed a trade in the market, however small,');
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

// Fix round 1, finding 2: the phone's Trust & Tiers ⓘ says how a line opens before any trade. It lists no preset
// figures (an owner vouches 200 or 500 too) and names the other two ways: a member's credit-line gift and the known floor.
describe("the phone's Trust & Tiers lines name every way a line opens before a trade", () => {
    const file = join(ROOT, 'apps/native/components/info-content/TrustInfoModal.tsx');
    const lines = wordsLiterals(file).filter((s) => /^Your credit line (stays|opens)/.test(s));

    it('both lines name a vouch, a credit-line gift and the known floor, and no vouch figures', () => {
        expect(lines).toHaveLength(2);
        for (const s of lines) {
            expect(s, s).toContain('someone vouches for you');
            expect(s, s).toContain('a member gives you part of the credit line someone gave them');
            expect(s, s).toContain('(the known floor)');
            expect(s, s).not.toMatch(/\b(25|50|75|100|200|500)\b/);
        }
        expect(readFileSync(file, 'utf8')).not.toContain('25, 50, 75 or 100 Beans');
    });

    it.each(LANGS)('%s: the phone catalog has both lines, the first keeping {line}', (lang) => {
        const words = catalog('apps/native/words', lang);
        for (const s of lines) {
            expect(typeof words[s], `${lang}: ${s}`).toBe('string');
            if (s.includes('{line}')) expect(words[s] as string).toContain('{line}');
        }
    });
});

// Fix round 2: the old Offer list ("1 Offer: down to 200 below zero … You get the smaller of the two") is gone from every
// guide page in every language, and so is F23's sentence. The node's rule is usableAllowance (protocol.ts): one live Offer
// opens a vouch, a credit-line gift and the known floor whole, and what you earned opens in the Offer steps.
describe('no guide page, in any language, keeps the old Offer list or the F23 sentence', () => {
    // ASCII, Arabic-Indic, Persian, Devanagari, Bengali, Tamil and Malayalam digits all read as ASCII; "1,000", "1.000",
    // "1 000" and "۱٬۰۰۰" read as 1000.
    const ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xbe6, 0xd66];
    const figures = (s: string) => s.normalize('NFC')
        .replace(/\p{Nd}/gu, (ch) => {
            const cp = ch.codePointAt(0)!;
            const zero = ZEROS.find((z) => cp >= z && cp <= z + 9);
            return zero === undefined ? ch : String(cp - zero);
        })
        .replace(/(\d)[,.\u00a0\u202f\u066c' ](?=\d{3}(?!\d))/g, '$1');
    const LADDER = [200, 500, 1000, 1500, 2000];
    const ladderFigures = (line: string) => (figures(line).match(/\d+/g) ?? []).map(Number).filter((n) => LADDER.includes(n));
    const isBullet = (line: string) => /^\s*[-*] /.test(line);
    const rel = (p: string) => p.slice(GUIDE.length + 1);
    const inLang = (lang: string) => (p: string) => p.startsWith(join(GUIDE, lang) + '/');
    const allPages = walk(GUIDE).filter((p) => p.endsWith('.md'));
    const englishPages = allPages.filter((p) => !LANGS.some((lang) => inLang(lang)(p)));
    /** The old list's shape in any language: bullets one after another with one ladder figure each, 200, 500, 1,000, 1,500. */
    const oldLists = (p: string) => {
        const lines = readFileSync(p, 'utf8').split('\n');
        return lines.flatMap((_, k) => (LADDER.slice(0, 4).every((n, j) => isBullet(lines[k + j] ?? '') && ladderFigures(lines[k + j]!).join() === String(n))
            ? [`${rel(p)}:${k + 1}`] : []));
    };
    /** The bullet naming the earned steps: 500, 1,000, 1,500 and 2,000 in one line. */
    const stepsLine = (text: string) => text.split('\n').find((line) => isBullet(line) && LADDER.slice(1).every((n) => ladderFigures(line).includes(n)));

    it('reads every page: the English ones and the 24 copies', () => {
        expect(LANGS).toHaveLength(24);
        expect(englishPages.length, 'English pages').toBeGreaterThan(50);
        expect(allPages.length, 'all pages').toBeGreaterThan(englishPages.length * 20);
    });

    it('no page, English or copy, has the old list; no English page says its words', () => {
        expect(allPages.flatMap(oldLists)).toEqual([]);
        const said = englishPages.flatMap((p) => readFileSync(p, 'utf8').split('\n')
            .filter((line) => /\b1 Offer: down to|smaller of the two|how deep you \*\*may\*\*/i.test(line))
            .map((line) => `${rel(p)}: ${line}`));
        expect(said).toEqual([]);
    });

    it('how-it-works says what credit-line says: one Offer opens what people stand behind, then the earned steps', () => {
        const offers = section(readFileSync(join(GUIDE, 'about/how-it-works.md'), 'utf8'), 'Your Offers unlock your credit');
        const rule = section(english('credit-line'), 'Your Offers set how much you can use');
        const bullets = rule.split('\n').filter(isBullet);
        expect(bullets).toHaveLength(2);
        expect(bullets[0]).toContain('One live Offer opens everything people stand behind for you (a vouch, a credit-line gift, the known floor)');
        for (const b of bullets) expect(offers).toContain(b);
        expect(offers).toContain('With no live Offer, none of it is open.');
    });

    it("what-the-admins-can-see names a voucher's budget as the Ledger's row does (R3: Vouching budget)", () => {
        const page = readFileSync(join(GUIDE, 'settings/what-the-admins-can-see.md'), 'utf8');
        expect(page).not.toMatch(/budget to vouch from/i);
        const row = String(VOUCH_PRESET_WORDS.ledgerBudget).split(':')[0]!;
        expect(row).toBe('Vouching budget');
        expect(section(page, 'Who can see your balance and your credit line')).toContain(`**${row}**`);
    });

    it.each(LANGS)("%s: how-it-works carries its own credit-line copy's steps line", (lang) => {
        const steps = stepsLine(copy(lang, 'credit-line'));
        expect(steps, `${lang}: credit-line's steps line`).toBeTruthy();
        expect(readFileSync(join(GUIDE, lang, 'about/how-it-works.md'), 'utf8').split('\n')).toContain(steps);
    });

    // F23 in the copies: no "1 or 2" beside the language's own word for beans (the phone's "Beans"), on any of its pages.
    // Against main's pages it finds the sentence 5 times in each copy (4 in Arabic). It reads figures, not number words:
    // main's Arabic faq said "one or two beans" in words, which this round's copies no longer say (the English check
    // above reads "one or two" too).
    it.each(LANGS)('%s: no page says a 1- or 2-Bean trade is too small to count', (lang) => {
        const bean = catalog('apps/native/words', lang)['Beans'];
        expect(typeof bean, `${lang}: the phone's "Beans"`).toBe('string');
        const letters = Array.from((bean as string).normalize('NFC').toLowerCase());
        const stem = letters.slice(0, letters.length > 3 ? 3 : letters.length === 3 ? 2 : letters.length).join('');
        const oneOrTwo = /(?<![\d.,])1(?![\d.,%])[^\d\n]{1,14}(?<![\d.,])2(?![\d.,%])/g;
        const said = allPages.filter(inLang(lang)).flatMap((p) => readFileSync(p, 'utf8').split('\n')
            .filter((line) => {
                const text = figures(line).toLowerCase();
                return [...text.matchAll(oneOrTwo)].some((m) => text.slice(Math.max(0, m.index! - 12), m.index! + m[0].length + 6).includes(stem));
            })
            .map((line) => `${rel(p)}: ${line}`));
        expect(said).toEqual([]);
    });
});
