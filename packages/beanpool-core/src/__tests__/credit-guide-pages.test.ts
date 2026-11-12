/**
 * Credit on the People list C7 (scratch/fable-design/DESIGN-credit-list-amend-fable.md §7, C7): the guide, the operator manual
 * and the website's privacy page say what the code does, and none still says what stopped being true when Marty took all
 * the picks on 12 Nov: owners, admins and vouchers see each member's balance and credit line, and each look is recorded.
 *
 * The pages are English prose, so these read the pages themselves (what a test pins is what the page says, not the
 * published copy), and the numbers and sentences from core and the server's source, so a page cannot drift from the code
 * it describes. Each test names the change that turns it red.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { knownRuleLine } from '../community-shape-card.js';
import { formatHundredths } from '../hundredths.js';
import {
    ALMOST_ALL_TENTHS, BRANCH_BELOW_MIN, CANCELLED_MIN, COMPLETION_MIN_ENDED, CREDIT_SIGHT_WORDS, DISPUTE_DAYS, LOW_DAYS_HERE, LOW_PARTNERS,
    LOW_TRADES, RISK_LEVELS, RISK_SHAPES, riskLevelSentence, riskReasonSentence, type ReasonMark, type RiskLevel, type RiskReason,
} from '../credit-sight.js';
import { VOUCH_MAX, VOUCH_PRESETS, VOUCHER_BUDGET_MAX } from '../vouch-presets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GUIDE = join(ROOT, 'packages/beanpool-guide/content');
const MANUAL = join(ROOT, 'packages/beanpool-guide/operators');
const WEBSITE = join(ROOT, 'apps/website');

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}
/** The English pages: each language's copy sits in a folder with its own manifest. */
function englishPages(top: string): string[] {
    const langs = new Set(readdirSync(GUIDE).filter((d) => existsSync(join(GUIDE, d, 'manifest.json'))));
    return walk(top).filter((p) => p.endsWith('.md') && !langs.has(relative(top, p).split('/')[0]!));
}
const websitePages = () => readdirSync(WEBSITE).filter((f) => f.endsWith('.html')).map((f) => join(WEBSITE, f));
const plain = (text: string) => text.replace(/\*\*/g, '');
const read = (p: string) => plain(readFileSync(p, 'utf8'));
const guide = (page: string) => read(join(GUIDE, page));
const manual = (page: string) => read(join(MANUAL, page));
const policy = () => readFileSync(join(WEBSITE, 'privacy.html'), 'utf8');

const TOLD = String(CREDIT_SIGHT_WORDS.told);
const noStop = (sentence: string) => sentence.replace(/\.$/, '');

describe('no page still says what stopped being true', () => {
    // The two things the amendment's C7 row stops on: a page that still says balances are private from vouchers, or shows the
    // old rule sentence ("The admins can see a confirmed member's balance if …"), which the reworded list line replaced.
    const OLD: Array<[RegExp, string]> = [
        [/can see a confirmed member['’]s balance if/i, 'the old rule sentence'],
        [/The admins can see a confirmed member/i, 'the old rule sentence'],
        [/Other members never see your balance/i, 'vouchers are members, and they see it'],
        [/Can other members see my balance/i, 'the FAQ question that answered No'],
        [/Your balance and these transactions are private/i, 'the balance page before the giver sentence'],
        [/Other members can['’]t read your balance/i, 'What\'s new before the giver sentence'],
        [/\*\*Your balance and your trades\.\*\* Nobody else/, 'the privacy page before the giver section'],
        [/Your balance stays private to you except in the four cases below/, 'the policy before section 9'],
        [/in a known community, if an admin has confirmed you, the admins can see your balance/i, 'the privacy page before the admins\' list wording'],
    ];

    it('the guide, the operator manual and the website say none of the old sentences', () => {
        const pages = [...englishPages(GUIDE), ...englishPages(MANUAL), ...websitePages()];
        const found = pages.flatMap((p) => {
            const text = readFileSync(p, 'utf8');
            return OLD.filter(([re]) => re.test(text)).map(([, why]) => `${relative(ROOT, p)}: ${why}`);
        });
        expect(found).toEqual([]);
        // The sweep reads what it says it reads.
        expect(englishPages(GUIDE).length).toBeGreaterThan(50);
        expect(englishPages(MANUAL).length).toBeGreaterThan(20);
        expect(pages.map((p) => relative(ROOT, p))).toContain('apps/website/privacy.html');
    });

    it('the guard knows each old sentence', () => {
        for (const sentence of [
            "The admins can see a confirmed member's balance if they owe more than half their credit line, or are in debit and haven't made a sale for 60 days. Each look is logged.",
            'No. Other members never see your balance.',
            '## Can other members see my balance?',
            'Your balance and these transactions are private.',
            "Other members can't read your balance or your history.",
            "**Your balance and your trades.** Nobody else in your community can read them, in the app or from your community's server.",
            'Your balance stays private to you except in the four cases below.',
        ]) expect(OLD.some(([re]) => re.test(sentence)), sentence).toBe(true);
    });
});

describe('every page that tells a member who sees their balance says it as the code does', () => {
    it('the rules sentence is core\'s own, word for word, where the rule is told', () => {
        for (const text of [guide('settings/what-the-admins-can-see.md'), guide('getting-started/how-your-community-works.md'),
            manual('people/running-a-known-community.md'), plain(policy())]) {
            expect(text).toContain(TOLD);
        }
    });

    it('every other page that touches the balance names the people who give credit', () => {
        for (const page of ['about/faq.md', 'about/whats-new.md', 'settings/privacy.md', 'ledger/your-balance.md', 'ledger/credit-line.md', 'getting-started/joining.md']) {
            expect(guide(page), page).toContain('owners, admins and vouchers');
        }
    });

    it('the admins\' list line is core\'s reworded one, in the usual numbers (half, 60 days), in the three pages that quote it', () => {
        const list = noStop(knownRuleLine({ debtLinePct: 50, quietDays: 60 }) as string);
        expect(list).toBe("The admins also keep a list of confirmed members who owe more than half their credit line, or are in debit and haven't made a sale for 60 days");
        for (const text of [guide('settings/what-the-admins-can-see.md'), guide('getting-started/how-your-community-works.md'), manual('people/running-a-known-community.md')]) {
            expect(text).toContain(list);
        }
    });

    it('who reads the record of looks: owners and admins, never a voucher, and a member is told but not shown names', () => {
        const members = guide('settings/what-the-admins-can-see.md');
        expect(members).toContain('Every owner and admin can read it in Settings, beside the log of who looked at a balance');
        expect(members).toContain("A voucher can't read it. You are not shown the names, but you are told that looks are recorded and that the owners and admins can say who.");
        expect(members).toContain('A line is written before the answer, so a look that can\'t be recorded isn\'t answered.');
        expect(manual('people/running-a-known-community.md')).toContain("A voucher can't read it, and a member is not shown the names");
        expect(plain(policy())).toContain('A voucher cannot read it, and you are not shown the names');
    });

    it('the record is kept as long as the server keeps it: 12 months, in every page that says so', () => {
        const manifest = readFileSync(join(ROOT, 'apps/server/src/engine/replication-manifest.ts'), 'utf8');
        expect(Number(/export const CREDIT_LOOK_KEPT_DAYS = (\d+)/.exec(manifest)?.[1])).toBe(365);
        for (const text of [guide('settings/what-the-admins-can-see.md'), guide('settings/privacy.md'), manual('people/running-a-known-community.md'),
            manual('privacy/what-the-server-sees.md'), plain(policy())]) {
            expect(text).toContain('12 months');
        }
    });
});

describe('Credit risk: what it reads says what core\'s rules say', () => {
    const page = guide('ledger/credit-risk.md');
    const source = readFileSync(join(ROOT, 'packages/beanpool-core/src/credit-sight.ts'), 'utf8');
    /** Every rule the engine can trip: its code, its level and who may read its reason, read from the rules themselves. */
    const rules = [...source.matchAll(/add\('(\w+)',\s*'(\w+)',\s*'(\w+)'/g)].map((m) => ({ code: m[1]!, level: m[2] as RiskLevel, mark: m[3] as ReasonMark }));
    /** A reason's figures, in hundredths for money: 900 owed of a line of 1,000, 60 days, and so on. The page's examples. */
    const EXAMPLES: Record<string, Record<string, number>> = {
        frozen: {}, over: { owed: 90000, over: 10000 }, paused: { owed: 90000, usable: 30000 }, ring: {},
        almost_all_quiet: { owed: 90000, line: 100000, days: 60 }, dispute: {}, completion: {}, written_off: {},
        over_half: { owed: 90000, line: 100000, pct: 50 }, below_zero_quiet: { owed: 90000, days: 60 }, branch_below: { n: 2, m: 4 },
        inside_only: {}, cancelled: { n: 3 }, confirmed: {}, established: { n: 5, k: 3 }, new: {}, few_trades: { n: 2 },
    };
    const HEADING: Record<RiskLevel, string> = { high: 'High', medium: 'Medium', low: 'Low', not_known: 'Not known yet' };
    const section = (level: RiskLevel) => {
        const m = new RegExp(`### ${HEADING[level]}\\n([\\s\\S]*?)(?=\\n#{2,3} |$)`).exec(page);
        return m?.[1] ?? '';
    };

    it('the page has an example for every rule in core, and core has a rule for every example', () => {
        expect(rules.map((r) => r.code).sort()).toEqual(Object.keys(EXAMPLES).sort());
        expect(rules.length).toBe(17);
    });

    it('every reason is on the page under its level, in its sentence, with who reads it', () => {
        for (const r of rules) {
            const reason: RiskReason = { code: r.code as RiskReason['code'], level: r.level, mark: r.mark, values: EXAMPLES[r.code]! };
            const sentence = riskReasonSentence(reason);
            expect(sentence, r.code).toBeTruthy();
            const who = r.mark === 'admins' ? 'Owners and admins read this.' : 'Every giver reads this.';
            expect(section(r.level), `${r.code} under ${HEADING[r.level]}`).toContain(`- ${sentence} ${who}`);
        }
    });

    it('the four words, each with its shape, and the voucher\'s one more line', () => {
        for (const level of RISK_LEVELS) expect(page, level).toContain(`${RISK_SHAPES[level]} ${riskLevelSentence(level)}`);
        expect(page).toContain(String(CREDIT_SIGHT_WORDS.adminsSayMore));
        expect(page).toContain('They owe 900 of 1,000: more than half. Every giver reads this.');
    });

    it('the thresholds are core\'s', () => {
        expect(ALMOST_ALL_TENTHS).toBe(9);
        expect(page).toContain('Almost all means nine tenths or more.');
        expect(DISPUTE_DAYS).toBe(365);
        expect(page).toContain('in the last 12 months');
        expect(page).toContain(`It counts once ${COMPLETION_MIN_ENDED} or more have ended`);
        expect(page).toContain(`It needs ${CANCELLED_MIN} or more, and fewer than 8 in 10 completed.`);
        expect(page).toContain(`It needs at least ${BRANCH_BELOW_MIN}, and at least half.`);
        expect(page).toContain(`It needs ${LOW_TRADES} trades with ${LOW_PARTNERS} people at least, and ${LOW_DAYS_HERE} days here.`);
    });

    it('says how it can be gamed, all eight ways, and that the server enforces nothing from it', () => {
        for (const way of ['Friends trading to look established.', 'Topping up before asking.', 'A new key wipes a bad record.', 'A friendly voucher or a forwarded invite.',
            'Waiting it out.', 'A figure invites false precision.', 'Spending fast to be topped up.', 'Looking, not giving.']) expect(page, way).toContain(way);
        expect(page).toContain('Your community\'s server enforces nothing from this word.');
    });
});

describe('the operator manual and the People page give the voucher numbers the code holds', () => {
    it('running low is under the most one voucher stands behind one person; nothing left under the smallest vouch; no budget over the ceiling', () => {
        const running = formatHundredths(VOUCH_MAX);
        const smallest = formatHundredths(VOUCH_PRESETS[0]!);
        const ceiling = formatHundredths(VOUCHER_BUDGET_MAX);
        const ops = manual('people/running-a-known-community.md');
        expect(ops).toContain(`A voucher is running low when under ${running} Beans are left. ${running} is the most one voucher can stand behind one person`);
        expect(ops).toContain(`Under ${smallest}, the smallest vouch, the row says "Nothing left to vouch with".`);
        expect(ops).toContain(`never above ${ceiling} in hand`);
        const people = guide('talk/people.md');
        expect(people).toContain(`a voucher with under ${running} Beans left can no longer give anyone a full vouch, and with under ${smallest} the app says "Nothing left to vouch with"`);
    });

    it('Ask for more is one tap, no text, no amount, once a week, and lands with the owners and the credit committee', () => {
        const ops = manual('people/running-a-known-community.md');
        expect(ops).toContain('one tap, no text and no amount');
        expect(ops).toContain('One ask in 7 days, topped up or not');
        expect(ops).toContain('It lands in the bell of every owner and committee admin, never the asker\'s');
        expect(guide('talk/people.md')).toContain('You can ask once a week.');
    });

    it('Show credit is for givers only, off at every visit, and the list is the node\'s each time, never kept', () => {
        const people = guide('talk/people.md');
        expect(people).toContain('This is only for people who give credit: the owners, admins and vouchers.');
        expect(people).toContain('It is off every time you open People');
        expect(people).toContain('The list comes from your community\'s server each time and is not kept on your phone');
        expect(manual('people/running-a-known-community.md')).toContain('Off at every visit');
    });
});
