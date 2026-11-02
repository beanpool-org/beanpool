/**
 * A known community's rule as the apps say it: the rule line and its half variant, what a node's answer can draw, and the
 * standing decision that this is all a member gets (Marty, 2 Nov: "Rules page only").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMUNITY_SHAPE_CARD_WORDS, communityShapeLines, joinRuleLines, knownRuleLine, waitingLineSentences } from '../community-shape-card.js';
import { readKnownRule, ruleStartsLine, type KnownRule } from '../known-rule.js';
import { pseudoLocalise, setLanguage } from '../words.js';

/** The defaults, nothing waiting. */
const RULE: KnownRule = { knownFloor: 1000, debtLinePct: 50, quietDays: 60, debtLineFrom: null, quietDaysFrom: null };
const HALF = "The admins can see a confirmed member's balance if they owe more than half their credit line, or stay in debit for 60 days without a sale. Each look is logged.";

afterEach(() => setLanguage('en'));

describe('the rule line', () => {
    it('says "half" at 50 and the percentage otherwise, in the community\'s numbers', () => {
        expect(knownRuleLine({ debtLinePct: 50, quietDays: 60 })).toBe(HALF);
        expect(knownRuleLine({ debtLinePct: 30, quietDays: 90 })).toBe("The admins can see a confirmed member's balance if they owe more than 30% of their credit line, or stay in debit for 90 days without a sale. Each look is logged.");
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
