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
    ALMOST_ALL_TENTHS, BRANCH_BELOW_MIN, CANCELLED_MIN, COMPLETION_MIN_ENDED, CREDIT_SIGHT_WORDS, DISPUTE_DAYS, GIFT_DAYS, LOW_DAYS_HERE, LOW_PARTNERS,
    LOW_TRADES, RISK_LEVELS, RISK_SHAPES, creditRisk, paidByGifts, riskForVoucher, riskLevelSentence, riskReasonSentence, riskReasons, type CreditRiskFacts,
    type ReasonMark, type RiskLevel, type RiskReason,
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
        [/private from other members in the same way, with one exception/, 'the privacy page counts one exception where the removal vote, the settling admin and the admins\' list follow it'],
        // Amendment 2 (C8): a gift no longer clears the word, and one figure (what a gift paid, 30 days) reaches back.
        [/clears every reason built from what they owe/i, 'the credit-risk page before C8: a gift washed the word'],
        [/an older balance/i, 'the privacy sentence before C8: the gift-paid figure reaches back 30 days'],
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
            'Your balance is private from other members in the same way, with one exception: the people who give credit (below).',
            'A gift that brings someone to zero or above clears every reason built from what they owe, the no-sale ones too, until the Beans go back.',
            '**What no giver sees:** your trades, a history, or an older balance.',
        ]) expect(OLD.some(([re]) => re.test(sentence)), sentence).toBe(true);
    });

    it('the members\' privacy page does not count one exception when the bullets under it add three more', () => {
        const page = guide('settings/privacy.md');
        const only = /## What only you can see\n([\s\S]*?)\n## /.exec(page)?.[1] ?? '';
        expect(only).toContain('except for the people who give credit (below) and the cases that follow.');
        // The cases that follow: the removal vote, the admin who settles a removal, the admins' list in a known community.
        expect(only).toContain('If the community votes on removing you');
        expect(only).toContain('If your account is removed');
        expect(only).toContain('In a known community, the admins also keep a list');
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

    it('says how it can be gamed, all eleven ways, and that the server enforces nothing from it', () => {
        const ways = ['Friends trading to look established.', 'Topping up before asking.', 'A new key wipes a bad record.', 'A friendly voucher or a forwarded invite.',
            'Waiting it out.', 'A figure invites false precision.', 'Spending fast to be topped up.', 'Looking, not giving.',
            // Amendment 2 §5, items 9 to 11.
            'A gift dressed as a sale or a bill.', `Parking the Beans for ${GIFT_DAYS} days.`, 'Paying your people\'s debts before asking.'];
        for (const way of ways) expect(page, way).toContain(`- ${way}`);
        const gamed = /## How it can be gamed\n([\s\S]*?)\n## /.exec(page)?.[1] ?? '';
        expect(gamed.split('\n').filter((l) => l.startsWith('- ')).length).toBe(ways.length);
        expect(page).toContain('Your community\'s server enforces nothing from this word.');
    });

    // The gaming list is said to the giver, so each line is held to what the rules do (deciding review of #3088, findings 1-3:
    // the design's own sentences were wrong, and the page copied them).
    const base: CreditRiskFacts = {
        completed: 10, cancelled: 0, daysHere: 100, balance_c: 0, line_c: 100000, usable_c: 100000, giftPaid_c: 0, frozen: false, ring: false, disputeAgainst: false,
        lastSaleDays: 90, confirmed: false, insideOnly: false, outsideTrades: 0, outsidePartners: 0, branchPeople: 0, branchBelowZero: 0, writtenOff_c: 0,
        debtLinePct: 50, quietDays: 60,
    };
    const codesOf = (f: CreditRiskFacts) => riskReasons(f).map((r) => r.code);

    // Test 34 (amendment 2, slice C8) replaces #3088's "a gift … clears every reason": for GIFT_DAYS days the word reads what
    // they would owe by their own trading, and the page says so in core's own sentences.
    const OWED_RULES = ['over', 'paused', 'almost_all_quiet', 'over_half', 'below_zero_quiet'];
    it('34. the five reasons built from what someone owes, in their second form as core gives it, each under its level with who reads it', () => {
        // Which rules carry a gift is read from core, not from this list: every reason that takes the gift's figure.
        const carried = new Set<string>();
        for (const f of [{ ...base, line_c: 0, usable_c: 0, giftPaid_c: 6000 }, { ...base, usable_c: 20000, giftPaid_c: 30000 }, { ...base, giftPaid_c: 95000 }]) {
            for (const r of riskReasons(f)) if (r.values.gift) carried.add(r.code);
        }
        expect([...carried].sort()).toEqual([...OWED_RULES].sort());
        const gift = /## When a gift of Beans paid the debt\n([\s\S]*?)\n## /.exec(page)?.[1] ?? '';
        const levels = { high: gift.split('At high:')[1]?.split('At medium:')[0] ?? '', medium: gift.split('At medium:')[1]?.split('\nA gift to someone')[0] ?? '' };
        const at = (level: 'high' | 'medium') => levels[level];
        for (const r of rules.filter((x) => OWED_RULES.includes(x.code))) {
            const sentence = riskReasonSentence({ code: r.code as RiskReason['code'], level: r.level, mark: r.mark, values: { ...EXAMPLES[r.code]!, gift: 90000, giftDays: GIFT_DAYS } })!;
            expect(sentence, r.code).toMatch(/^By their own trading .* A gift of Beans paid 900 of it in the last 30 days\.$/);
            const who = r.mark === 'admins' ? 'Owners and admins read this.' : 'Every giver reads this.';
            expect(at(r.level as 'high' | 'medium'), `${r.code} under ${r.level}`).toContain(`- ${sentence} ${who}`);
        }
        expect(gift).toContain(`For ${GIFT_DAYS} days it still reads what they would owe by their own trading, until their own sales have earned it back.`);
        expect(gift).toContain('the balance on their row is the real one, straight away.');
        expect(gift).toContain('The reason never says who sent the Beans or when.');
    });

    it('34. "30 days" is GIFT_DAYS wherever the page says how long a gift counts, and what the page says of a gift is what core does', () => {
        expect(GIFT_DAYS).toBe(30);
        expect(page).toContain(`The balance and the credit line: how much of the line someone is using. Every giver sees this. For ${GIFT_DAYS} days it also counts debt that a gift of Beans paid off (see below).`);
        expect(page).toContain(`A friend can send Beans for an afternoon, and for ${GIFT_DAYS} days a gift does not clear what someone owed either.`);
        expect(page).toContain(`A gift of Beans goes on counting for ${GIFT_DAYS} days. Your community's list of members who owe more than half reads what they owe now; for those ${GIFT_DAYS} days the word also counts debt a gift paid.`);
        expect(page).toContain(`The word does not follow the gift: for ${GIFT_DAYS} days it reads what they would owe by their own trading, and says how much a gift paid.`);
        // Sam owes 900 of 1,000 and has not sold for 90 days: high. A friend sends 900: the row reads 0, the word stays high.
        const sam: CreditRiskFacts = { ...base, completed: 4, balance_c: -90000 };
        const washed: CreditRiskFacts = { ...sam, balance_c: 0, giftPaid_c: paidByGifts(0, [{ delta_c: 90000, gift: true }]) };
        expect(washed.giftPaid_c).toBe(90000);
        expect(creditRisk(sam).level).toBe('high');
        expect(creditRisk(washed).level).toBe('high');
        expect(codesOf(washed)).toEqual(codesOf(sam));
        expect(riskForVoucher(washed).more).toBe(true);
        // Their own sale earns it back at once, and a gift to someone who owes nothing is not counted.
        expect(paidByGifts(0, [{ delta_c: 90000, gift: false }])).toBe(0);
        expect(paidByGifts(10000, [{ delta_c: 10000, gift: true }])).toBe(0);
        expect(page).toContain("A gift to someone who owes nothing is not counted, so nobody's word gets worse because they were sent Beans.");
        // What a gift does not clear: their last sale (no input a gift changes), and a balance above zero is never a reason to trust.
        expect(creditRisk({ ...sam, balance_c: 5000, giftPaid_c: 0 }).level).toBe('not_known');
        expect(page).toContain('A gift is not a sale, so their last sale does not move, and a balance above zero is never a reason to trust.');
        expect(page).toContain('A gift that lifts someone to zero does let them be vouched for again: that rule reads the balance as it is.');
    });

    it('a new account reads not known yet until an admin confirms it, which reads low, so the page does not say "never low"', () => {
        const newcomer: CreditRiskFacts = { ...base, completed: 0, daysHere: 1, lastSaleDays: null };
        expect(creditRisk(newcomer).level).toBe('not_known');
        expect(creditRisk({ ...newcomer, confirmed: true }).level).toBe('low');
        expect(page).toContain('A new account reads not known yet. It reads low only once an admin confirms it, or after real trades with people outside its circle over thirty days.');
        expect(page).not.toMatch(/never low/i);
        expect(LOW_DAYS_HERE).toBe(30);
    });

    it('only owners and admins are told who stands behind someone; the page says a voucher is not', () => {
        const server = readFileSync(join(ROOT, 'apps/server/src/engine/credit-sight.ts'), 'utf8');
        const voucherAnswer = /export interface CreditPersonVoucher \{[\s\S]*?\n\}/.exec(server)?.[0] ?? '';
        const fullAnswer = /export interface CreditPersonFull extends CreditPersonVoucher \{[\s\S]*?\n\}/.exec(server)?.[0] ?? '';
        expect(voucherAnswer).toContain('interface CreditPersonVoucher');
        expect(voucherAnswer).not.toContain('standsBehind');
        expect(fullAnswer).toContain('standsBehind');
        expect(server).toContain("const full = sight !== 'voucher';");
        expect(page).toContain('The card that owners and admins see names who stands behind someone, so they can judge that too. A voucher is not told who.');
        expect(page).not.toContain('so the giver can judge that too');
    });
});

describe('the website goes live when the PR merges, so it names only places that exist', () => {
    /** Non-test source of the apps and of core, where a screen's heading or a route's call would be. */
    const SOURCE_DIRS = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'apps/manager/src', 'packages/beanpool-core/src'];
    function sources(dir: string): string[] {
        return readdirSync(dir).flatMap((name) => {
            const p = join(dir, name);
            if (name === 'node_modules' || name === '__tests__' || name === 'dist') return [];
            if (statSync(p).isDirectory()) return sources(p);
            return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
        });
    }
    const code = () => SOURCE_DIRS.map((d) => join(ROOT, d)).filter(existsSync).flatMap(sources).map((p) => readFileSync(p, 'utf8')).join('\n');

    it('the Ledger panel and the Settings record of looks are on the policy only once an app has them', () => {
        const text = plain(policy());
        // Review of #3088, finding 4: section 9 sent members to a Ledger panel (C6) and a Settings record (C5) no app has. Once
        // C5 or C6 land the name is in the apps and the policy may say it; until then the policy says what the server answers.
        const places: Array<[RegExp, string, string]> = [
            [/What people who give credit see|on your own Ledger/, 'What people who give credit see', 'the Ledger panel (C6)'],
            [/beside the record of balance looks/, 'api/credit/looks', 'the Settings record of looks (C5)'],
        ];
        const all = code();
        const early = places.filter(([said, there]) => said.test(text) && !all.includes(there)).map(([, , name]) => name);
        expect(early).toEqual([]);
        // The policy still says what the server does now: any member can ask, and it is not a look.
        expect(text).toContain('your community\'s server will tell any member, on request, the answer a voucher gets about them. Asking is not recorded as a look.');
        expect(text).toContain('Every owner and admin can read the record from your community\'s server.');
        // The route it names is the one on main, and it records nothing.
        const route = readFileSync(join(ROOT, 'apps/server/src/routes/credit-sight.ts'), 'utf8');
        const me = /router\.get\('\/api\/credit\/me',[\s\S]*?\n {4}\}\);/.exec(route)?.[0] ?? '';
        expect(me).toContain('creditMe(viewer)');
        expect(me).not.toContain('recordLooks');
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
