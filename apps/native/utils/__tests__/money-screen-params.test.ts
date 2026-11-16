/**
 * No money screen on the phone takes a recipient, an amount or a name from the route (review of #3243, Learn K8 round 2).
 * Route params also come from outside the app: app/+native-intent.ts hands any path it doesn't know to Expo Router as it is,
 * and beanpool:// is registered, so `beanpool://ledger?sendTo=…&sendName=Ada` reaches the Ledger's params. A prefilled Send
 * inside the app goes by the in-memory hand-over (utils/send-handoff.ts), which only a tap in the app can write.
 *
 * One table over every money screen (Send, Pay the Commons, an enterprise's pledge and console, a listing's buy and its deal,
 * Bills, Show credit, a shop) x where a prefill can come from (the in-app hand-over; a deep link's route params) -> what each
 * may take, read from each screen's source. A screen that starts reading a new route param goes red here until the param is
 * reviewed and listed with its reason; a recipient, an amount or a name among them must be one this table lists and explains.
 * The rendered half (a link's params open no form; the shown name is the member list's) is ledger-send-start-render.test.ts.
 * The web's twin is apps/pwa/src/pages/money-screens-address.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(APP, file), 'utf8');

/** Params that would carry a recipient, an amount, a name or a note: none may reach a money form from the route. */
const MONEY_WORDS = new Set(['sendTo', 'sendName', 'sendNote', 'to', 'recipient', 'payee', 'amount', 'price', 'name', 'callsign', 'avatar', 'note', 'memo']);

interface MoneyScreen {
    screen: string;
    file: string;
    /** Every route param the screen reads, reviewed. */
    routeParams: string[];
    /** The ones among them that are MONEY_WORDS, and why each is safe (or, `open`, why it is not yet). */
    moneyWords: Record<string, string>;
    /** Whether the screen takes the in-app hand-over (only Send does). */
    handOver: boolean;
}

const SCREENS: MoneyScreen[] = [
    {
        screen: 'Ledger: Send (Beans, and the Credit line tab)', file: 'app/(tabs)/ledger.tsx', routeParams: [], moneyWords: {}, handOver: true,
    },
    {
        screen: 'An enterprise or project page: its pledge form', file: 'app/treasury-detail.tsx',
        routeParams: ['publicKey', 'id', 'name', 'avatar'],
        moneyWords: {
            name: 'shown only until the node reads the enterprise by its key; the pledge form exists only for one the node returns, under its name',
            avatar: 'as name',
        },
        handOver: false,
    },
    {
        screen: 'An enterprise\'s console: releases and bids', file: 'app/treasury-manage.tsx',
        routeParams: ['publicKey', 'id', 'name'],
        moneyWords: { name: 'shown only until the node reads the enterprise by its key; each release names the node\'s deal and its peer' },
        handOver: false,
    },
    {
        screen: 'Pay the Commons', file: 'app/pay-commons.tsx', routeParams: ['code', 'amount'],
        moneyWords: {
            amount: 'OPEN, splits off from #3243: the admin\'s pay-back link (beanpool://pay-commons?code=…&amount=…) fills in an amount. The recipient is always the Commons and the node refuses more than is left on that debt; the fix drops amount from the link and its words in every language',
        },
        handOver: false,
    },
    { screen: 'A listing and its deal: buy, pay, release', file: 'app/post/[id].tsx', routeParams: ['id', 'txId', 'cameFor', 'kind'], moneyWords: {}, handOver: false },
    { screen: 'Market: Bills and deals', file: 'app/(tabs)/market.tsx', routeParams: ['tab', 'dealsTab', 'bill', 'filter', 'q', 'new', 'tag', 'free'], moneyWords: {}, handOver: false },
    { screen: 'People: Show credit', file: 'app/(tabs)/people.tsx', routeParams: ['view', 'from', 'credit', 'voucher'], moneyWords: {}, handOver: false },
    { screen: 'A shop', file: 'app/shop/[id].tsx', routeParams: ['id'], moneyWords: {}, handOver: false },
];

/** The route params a screen reads: every key of every useLocalSearchParams<{ … }>() in it. */
function routeParamsOf(source: string): string[] {
    const keys = new Set<string>();
    for (const m of source.matchAll(/useLocalSearchParams<\{([^}]*)\}>/g)) {
        for (const k of m[1].matchAll(/(\w+)\??\s*:/g)) keys.add(k[1]);
    }
    return [...keys].sort();
}

/** Every source file of the app's screens and components (not tests). */
function appSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
            const rel = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(rel); continue; }
            if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
        }
    };
    for (const dir of ['app', 'components', 'utils']) walk(dir);
    return out;
}

describe('no money screen takes a recipient, an amount or a name from the route (review of #3243)', () => {
    // (money screen) x (deep link): the params it reads, as reviewed above.
    it.each(SCREENS.map((s) => [s.screen, s] as const))('%s x deep link: reads only its reviewed params, and no other kind of read', (_, s) => {
        const source = read(s.file);
        expect(routeParamsOf(source), `${s.file}: a new route param needs reviewing here first`).toEqual([...s.routeParams].sort());
        // Only typed reads, so the table above sees every key: no untyped read, no global params, no reading the link itself.
        expect(source).not.toMatch(/useLocalSearchParams\(\)|useLocalSearchParams<Record|useGlobalSearchParams|Linking\.(getInitialURL|addEventListener)|useURL\(/);
        const moneyWords = s.routeParams.filter((p) => MONEY_WORDS.has(p)).sort();
        expect(moneyWords, `${s.file}: a recipient, an amount or a name from the route must be explained here`).toEqual(Object.keys(s.moneyWords).sort());
    });

    // (money screen) x (in-app hand-over): only Send takes it, and only Learn's Thank tap writes it.
    it.each(SCREENS.map((s) => [s.screen, s.handOver ? 'takes it' : 'takes none', s] as const))('%s x in-app hand-over: %s', (_, __, s) => {
        expect(read(s.file).includes('takeSendRequest('), s.file).toBe(s.handOver);
    });

    it('the hand-over is taken only by the Ledger and written only by a tap on Learn\'s Thank', () => {
        const sources = appSources();
        const using = (call: string) => sources.filter((f) => f !== path.join('utils', 'send-handoff.ts') && read(f).includes(call)).sort();
        expect(using('takeSendRequest(')).toEqual([path.join('app', '(tabs)', 'ledger.tsx')]);
        expect(using('handOverSend(')).toEqual([path.join('components', 'learn', 'KnowledgeDetail.tsx')]);
    });

    it('the Ledger holds no name of its own for the recipient: it shows the member list\'s (membersMap, by key), nothing else', () => {
        const ledger = read('app/(tabs)/ledger.tsx');
        expect(ledger).toContain('const selectedMember = sendTo ? membersMap.get(sendTo) : undefined;');
        expect(ledger).not.toMatch(/sendToName|sendName/);
    });

    it('the deep links still reach the router as they are (so this table is the guard that matters)', () => {
        // If +native-intent ever drops unknown paths, this test says so and the table above can be revisited, not the reverse.
        expect(read('app/+native-intent.ts')).toMatch(/return path;\s*\n\s*\}\s*$/m);
    });
});
