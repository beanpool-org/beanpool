/**
 * A known community's rule as the apps say it: the rule line and its half variant, what a node's answer can draw, and the
 * standing decision that this is all a member gets (Marty, 2 Nov: "Rules page only").
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMUNITY_SHAPE_CARD_WORDS, communityShapeLines, joinRuleLines, knownRuleLine, waitingLineSentences } from '../community-shape-card.js';
import { HOME_TIPS } from '../home-tips.js';
import { readKnownRule, ruleStartsLine, type KnownRule } from '../known-rule.js';
import { pseudoLocalise, setLanguage } from '../words.js';

/** The defaults, nothing waiting. */
const RULE: KnownRule = { knownFloor: 1000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null };
const HALF = "The admins can see a confirmed member's balance if they owe more than half their credit line, or are in debit and haven't made a sale for 60 days. Each look is logged.";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const APP_SOURCES = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'packages/beanpool-core/src'];
const CATALOGS = ['packages/beanpool-core/words', 'apps/native/words', 'apps/pwa/words'];
const isTest = (p: string) => /(__tests__|\.test\.tsx?$)/.test(p);

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}
const sources = APP_SOURCES.flatMap(d => walk(join(ROOT, d))).filter(p => /\.tsx?$/.test(p) && !isTest(p));
const catalogFiles = CATALOGS.flatMap(d => walk(join(ROOT, d))).filter(p => p.endsWith('.json') && !p.endsWith('en.sources.json'));

afterEach(() => setLanguage('en'));

describe('the rule line', () => {
    it('says "half" at 50 and the percentage otherwise, in the community\'s numbers', () => {
        expect(knownRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe(HALF);
        expect(knownRuleLine({ debtLinePct: 30, quietDays: 90 })).toBe("The admins can see a confirmed member's balance if they owe more than 30% of their credit line, or are in debit and haven't made a sale for 90 days. Each look is logged.");
    });

    it('an older node, which states no lines, draws no rule line and keeps its floor line', () => {
        expect(knownRuleLine({})).toBeNull();
        expect(knownRuleLine({ debtLinePct: 50 })).toBeNull();
        expect(knownRuleLine({ quietDays: 60 })).toBeNull();
        expect(communityShapeLines({ beans: true, door: 'members', knownFloor: 1000 }).filter(l => /admins can see/.test(l))).toEqual([]);
        expect(communityShapeLines({ beans: true, door: 'members', knownFloor: 1000 }).some(l => l.includes('1,000 Beans'))).toBe(true);
    });

    it('sits right under the floor line on "How this community works", and only with the floor', () => {
        const lines = communityShapeLines({ beans: true, door: 'members', knownFloor: 1000, debtLinePct: 50, quietDays: 60 });
        const floor = lines.findIndex(l => l.includes('(the known floor)'));
        expect(lines[floor + 1]).toBe(HALF);
        expect(communityShapeLines({ beans: true, door: 'members', debtLinePct: 50, quietDays: 60 }).filter(l => /admins can see/.test(l))).toEqual([]);
    });

    it('the join screen draws the floor and the rule together, or nothing', () => {
        expect(joinRuleLines(RULE)).toEqual(['**Confirmed members** can owe up to 1,000 Beans (the known floor)', HALF]);
        expect(joinRuleLines(null)).toEqual([]);
        expect(joinRuleLines({ knownFloor: 1000 })).toEqual([]);
        expect(joinRuleLines({ debtLinePct: 50, quietDays: 60 })).toEqual([]);
    });

    it('a tightened line carries its date on the rules page, per line, the number the owner set', () => {
        const waiting = { ...RULE, debtLinePct: 30, debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: '2026-11-20T04:00:00.000Z', quietDays: 45 };
        expect(waitingLineSentences(waiting)).toEqual(['The line of 30% applies from 16 November.', 'The line of 45 days applies from 20 November.']);
        expect(waitingLineSentences(RULE)).toEqual([]);
        const lines = communityShapeLines({ beans: true, door: 'members', knownFloor: 1000, debtLinePct: 30, quietDays: 45 }, waiting);
        expect(lines.indexOf('The line of 30% applies from 16 November.')).toBe(lines.indexOf(knownRuleLine(waiting) as string) + 1);
    });

    it('goes through the words layer: each sentence bracketed in the pseudo-locale, {days} in the language\'s plural', () => {
        setLanguage('xx');
        const days = pseudoLocalise('{n} days').replace('{n}', '60');
        expect(knownRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe(pseudoLocalise(String(COMMUNITY_SHAPE_CARD_WORDS.ruleLineHalf)).replace('{days}', days));
    });
});

describe('reading the node', () => {
    it('a whole known community only: an older node, a plain community and a bad answer are null', () => {
        expect(readKnownRule({ known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-11-16T04:00:00.000Z', debtLineFrom: null, quietDaysFrom: null })).toEqual(RULE);
        expect(readKnownRule({ known: false })).toBeNull();
        expect(readKnownRule({ known: false, knownFloor: 1000, debtLinePct: 50, quietDays: 60 })).toBeNull();
        expect(readKnownRule(null)).toBeNull();
        expect(readKnownRule({ error: 'Not found' })).toBeNull();
        expect(readKnownRule({ known: true, knownFloor: '1000', debtLinePct: 50, quietDays: 60 })).toBeNull();
    });

    it('a date it can\'t read is no date, so no sentence is drawn from it', () => {
        expect(readKnownRule({ ...RULE, known: true, debtLineFrom: 'soon' })?.debtLineFrom).toBeNull();
        expect(readKnownRule({ ...RULE, known: true, quietDaysFrom: 7 })?.quietDaysFrom).toBeNull();
    });
});

describe('the admins\' line', () => {
    it('names the start while it\'s ahead, and only then; it isn\'t "nobody", members confirmed under it are listed', () => {
        const line = ruleStartsLine({ from: '2026-11-16T04:00:00.000Z', started: false });
        expect(line).toBe('The rule starts on 16 November. Until then, only members confirmed since the notice began are listed.');
        expect(ruleStartsLine({ from: '2026-11-16T04:00:00.000Z', started: true })).toBeNull();
        expect(ruleStartsLine({ from: null, started: false })).toBeNull();
        expect(ruleStartsLine(undefined)).toBeNull();
    });
});

describe('Rules page only (Marty, 2 Nov): no card, no step-back, no tick, on either app', () => {
    it('the sweep is reading the apps: each side\'s join screen, rules page and Home are in it', () => {
        for (const file of ['apps/native/app/welcome.tsx', 'apps/native/components/CommunityShapeSheet.tsx', 'apps/native/app/(tabs)/index.tsx', 'apps/native/app/(tabs)/settings.tsx',
            'apps/pwa/src/pages/WelcomePage.tsx', 'apps/pwa/src/components/CommunityShapeModal.tsx', 'apps/pwa/src/pages/HomePage.tsx', 'apps/pwa/src/pages/SettingsPage.tsx']) {
            expect(sources.map(p => relative(ROOT, p))).toContain(file);
        }
        expect(catalogFiles.length).toBeGreaterThanOrEqual(3 * 24);
    });

    it('no such file', () => {
        const banned = /(ConfirmedCard|ConfirmedSettingsRow|StepBackSheet|KnownConsentCard|ConsentText|known-consent)\.tsx?$/;
        expect(sources.map(p => relative(ROOT, p)).filter(p => banned.test(p))).toEqual([]);
    });

    it('no app asks a node for any of it, keeps a "seen" state, or names a piece of it', () => {
        const banned = [
            '/api/names/step-back', '/api/names/consent', '/api/community/consent-terms', 'beanpool_rule_seen',
            'ConfirmedCard', 'ConfirmedSettingsRow', 'StepBackSheet', 'KnownConsentCard', 'ruleCardFor', 'stepBackFromConfirmed', 'stepped_back_owing',
        ];
        const found = sources.flatMap((p) => {
            const text = readFileSync(p, 'utf8');
            return banned.filter(b => text.includes(b)).map(b => `${relative(ROOT, p)}: ${b}`);
        });
        expect(found).toEqual([]);
    });

    it('no sentence for it, in the code or in any catalog', () => {
        const sentences = [
            /you're confirmed\./i, /rather stay unconfirmed/i, /stepp(ing|ed) back/i, /step back from being/i, /· step back/i,
            /rule on what the admins can see changes/i, /nothing to withdraw/i, /\bi agree\b/i, /up to you: you join either way/i,
        ];
        const inCode = sources.flatMap((p) => {
            const lines = readFileSync(p, 'utf8').split('\n').filter(l => /['"`]/.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l) && !/\/\*|\/\/ /.test(l));
            return lines.filter(l => sentences.some(s => s.test(l))).map(l => `${relative(ROOT, p)}: ${l.trim().slice(0, 100)}`);
        });
        expect(inCode).toEqual([]);
        const inCatalogs = catalogFiles.flatMap((p) => {
            const keys = Object.keys(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>);
            return keys.filter(k => sentences.some(s => s.test(k))).map(k => `${relative(ROOT, p)}: ${k.slice(0, 80)}`);
        });
        expect(inCatalogs).toEqual([]);
    });
});

describe('no sentence left that contradicts the rule (review of #2746)', () => {
    const GUIDE = join(ROOT, 'packages/beanpool-guide/content');
    const MANUAL = join(ROOT, 'packages/beanpool-guide/operators');
    const WEBSITE = join(ROOT, 'apps/website');
    /**
     * The same claim, however it was said: a member's balance or trades reach nobody, with no exception. "Other members
     * never see your balance" isn't it, and nor is "private", which the tip says: both stay true with the rule on.
     */
    const CLAIM = [
        /only you can (see|read) your balance/i,
        /nobody else in your community can read/i,
        /\b(nobody|no one)\b[^.]{0,30}\b(sees?|reads?)\b[^.]{0,12}\byour balance\b/i,
        /\byour balances?(?: and [^.:]{1,30})? (is|are)(n't| not)\b/i,
        /\bbalances?\b[^.:]{0,40}\b(not|never|n't)\b[^.:]{0,12}\b(shared|public|visible|shown)\b/i,
    ];
    const claims = (text: string) => CLAIM.some(c => c.test(text));
    /** S3 rewrites this page, with the tick it still describes; #2746 names the line under "Until S3 merges". */
    const S3_REWRITES = ['packages/beanpool-guide/content/settings/privacy.md'];
    /**
     * A wait the server doesn't give: openExceptions tests "below zero now" and "no sale in {days}", and nothing records
     * when a debit began. "in debit with no sale for {n} days", the admins' own line, is the two tests and stays.
     */
    const WAIT = /\b(stay|stays|staying|remain|remains|been) in debit\b|\bin debit for\b/i;
    /** S3's pages, named under "Until S3 merges": S3's meaning check must not keep the phrase. */
    const S3_WAITS = [
        'apps/website/privacy.html',
        'packages/beanpool-guide/content/settings/what-the-admins-can-see.md',
        'packages/beanpool-guide/operators/people/running-a-known-community.md',
    ];
    const tip = () => HOME_TIPS.find(t => t.id === 'private')!;
    const coreCatalogs = () => readdirSync(join(ROOT, 'packages/beanpool-core/words')).filter(f => f.endsWith('.json'));
    const read = (dir: string, file: string) => JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8')) as Record<string, string>;

    /** The English pages of the guide or the manual: each language's copy sits in a folder with its manifest. */
    function englishPages(top: string): string[] {
        const langs = new Set(readdirSync(GUIDE).filter(d => existsSync(join(GUIDE, d, 'manifest.json'))));
        return walk(top).filter(p => p.endsWith('.md') && !langs.has(relative(top, p).split('/')[0]));
    }

    /** Every line a member or an operator can read: both apps' code, the catalogs' keys, the guide, the manual, the website. */
    function everything(): Array<{ where: string; text: string }> {
        const lines = (p: string) => readFileSync(p, 'utf8').split('\n').map(text => ({ where: relative(ROOT, p), text }));
        const website = readdirSync(WEBSITE).filter(f => f.endsWith('.html')).map(f => join(WEBSITE, f));
        return [
            ...sources.flatMap(lines),
            ...catalogFiles.flatMap(p => Object.keys(JSON.parse(readFileSync(p, 'utf8')) as object).map(text => ({ where: relative(ROOT, p), text }))),
            ...[...englishPages(GUIDE), ...englishPages(MANUAL), ...website].flatMap(lines),
        ];
    }
    const said = everything();
    const saying = (test: (text: string) => boolean) => [...new Set(said.filter(s => test(s.text)).map(s => s.where))].sort();

    it('Home\'s tip says private, and sends the exception to the rules page by the page\'s own name', () => {
        expect(String(tip().text)).toMatch(/^Your balance and your trades are private\./);
        expect(String(tip().text)).toContain(String(COMMUNITY_SHAPE_CARD_WORDS.title));
    });

    it('the tip is true with the rule on and with it off: it only says where a rule would be, and never says the reader has one', () => {
        expect(String(tip().text)).toMatch(/\bIf your community has a rule\b/);
        expect(String(tip().text)).not.toMatch(/\?/);
        expect(String(tip().text)).not.toMatch(/\byou (are|owe|have been)\b/i);
    });

    it('in every language the tip names the page by the title the page draws, and the old sentence has gone', () => {
        const old = 'Only you can see your balance and your trades. Other members see your name, photo, level and reviews.';
        const catalogs = readdirSync(join(ROOT, 'packages/beanpool-core/words')).filter(f => f.endsWith('.json'));
        expect(catalogs.length).toBe(24);
        for (const file of catalogs) {
            const catalog = JSON.parse(readFileSync(join(ROOT, 'packages/beanpool-core/words', file), 'utf8')) as Record<string, string>;
            const title = catalog[String(COMMUNITY_SHAPE_CARD_WORDS.title)];
            expect(title, `${file}: the rules page's title`).toBeTruthy();
            expect(catalog[String(tip().text)], `${file}: the tip`).toContain(title);
            expect(catalog, file).not.toHaveProperty(old);
        }
    });

    it('the sweep reads the apps, the catalogs, the guide, the manual and the website, and no other language\'s pages', () => {
        const places = new Set(said.map(s => s.where));
        for (const where of ['apps/pwa/src/pages/WelcomePage.tsx', 'apps/native/app/welcome.tsx', 'packages/beanpool-core/src/home-tips.ts',
            'apps/pwa/words/fr.json', 'apps/native/words/fr.json', 'packages/beanpool-core/words/fr.json',
            'packages/beanpool-guide/content/ledger/your-balance.md', 'packages/beanpool-guide/operators/people/running-a-known-community.md',
            'apps/website/privacy.html']) {
            expect(places, where).toContain(where);
        }
        expect(englishPages(GUIDE).length).toBeGreaterThan(50);
        expect(englishPages(MANUAL).length).toBeGreaterThan(20);
        expect([...places].filter(w => w.startsWith('packages/beanpool-guide/content/fr/'))).toEqual([]);
    });

    it('the guard knows the claim however it was said, and leaves what stays true with the rule on', () => {
        for (const sentence of [
            'Only you can see your balance and your trades.',
            'Nobody else in your community can read them.',
            'Your posts are shared within your community. Your balance and trades are not: a trade shows only its two people.',
            "Your balance isn't shared with anyone.",
            'Your balance and your trades are not shared.',
            'Nobody can see your balance.',
            'Balances are never shown to anyone.',
        ]) expect(claims(sentence), sentence).toBe(true);
        for (const sentence of [
            String(tip().text),
            'Other members never see your balance.',
            'Your balance stays private to you except in the four cases below.',
            'A look at your balance in a vote on removing you is not recorded.',
        ]) expect(claims(sentence), sentence).toBe(false);
    });

    it('nothing a member or an operator reads makes the claim, but the page S3 rewrites', () => {
        expect(saying(claims)).toEqual(S3_REWRITES);
    });

    it('the rule states what the server tests: in debit now, and no sale for {days}, with no wait on the debit', () => {
        for (const line of [COMMUNITY_SHAPE_CARD_WORDS.ruleLineHalf, COMMUNITY_SHAPE_CARD_WORDS.ruleLinePct]) {
            expect(String(line)).toContain("or are in debit and haven't made a sale for {days}.");
            expect(String(line)).not.toMatch(WAIT);
        }
    });

    it('nothing promises a wait the server doesn\'t give, in the code or any catalog, but S3\'s pages', () => {
        expect(saying(text => WAIT.test(text))).toEqual(S3_WAITS);
    });

    it('in every language both rule lines stand, with their numbers', () => {
        expect(coreCatalogs().length).toBe(24);
        for (const file of coreCatalogs()) {
            const catalog = read('packages/beanpool-core/words', file);
            const half = catalog[String(COMMUNITY_SHAPE_CARD_WORDS.ruleLineHalf)];
            const pct = catalog[String(COMMUNITY_SHAPE_CARD_WORDS.ruleLinePct)];
            expect(half, `${file}: the half line`).toContain('{days}');
            expect(pct, `${file}: the percentage line`).toContain('{days}');
            expect(pct, `${file}: the percentage line`).toContain('{pct}');
        }
    });

    it('the join page answers "Is my data private?" in the tip\'s own words, and in every language by the page\'s title', () => {
        const START = 'Your identity is an Ed25519 key made on your device.';
        const source = readFileSync(join(ROOT, 'apps/pwa/src/pages/WelcomePage.tsx'), 'utf8');
        expect(source).toContain(`${START} Your posts are shared within your community. ${String(tip().text)} Your key leaves`);
        const catalogs = readdirSync(join(ROOT, 'apps/pwa/words')).filter(f => f.endsWith('.json'));
        expect(catalogs.length).toBe(24);
        for (const file of catalogs) {
            const catalog = read('apps/pwa/words', file);
            const answers = Object.keys(catalog).filter(k => k.startsWith(START));
            expect(answers, `${file}: one answer`).toHaveLength(1);
            expect(answers[0], `${file}: the English`).toContain(String(tip().text));
            const title = read('packages/beanpool-core/words', file)[String(COMMUNITY_SHAPE_CARD_WORDS.title)];
            expect(catalog[answers[0]!], `${file}: the rules page's title`).toContain(title);
        }
    });

    it('the balance page and What\'s new say private, not "only you", and the balance page points to the rules page', () => {
        const balance = readFileSync(join(GUIDE, 'ledger/your-balance.md'), 'utf8');
        expect(balance).toContain('Your balance and these transactions are private.');
        expect(balance).toContain('"How this community works"');
        expect(readFileSync(join(GUIDE, 'about/whats-new.md'), 'utf8')).toContain("Other members can't read your balance or your history.");
    });
});
