/**
 * No money screen on the web takes a recipient, an amount or a name from the address (review of #3243, Learn K8 round 2).
 * A link from outside fills the query string and the fragment; a prefilled Send inside the app goes by App's state
 * (`ledgerSend`), which only Learn's Thank tap sets.
 *
 * One table over the web's money screens (the Ledger's Send, an enterprise's pledge, standing deals, the member's deals, the
 * Market, Pay the Commons) x where a prefill can come from (App's state; the address) -> what each may take, read from each
 * screen's source. A screen that starts reading the address goes red here until what it reads is reviewed and listed with its
 * reason. The rendered half (the address opens no form; the shown name is the member list's) is LedgerPage.send-start.test.tsx.
 * The phone's twin is apps/native/utils/__tests__/money-screen-params.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

interface MoneyScreen {
    screen: string;
    file: string;
    /** The query keys it reads from the address, reviewed (none for every screen but one). */
    address: string[];
    /** Why each is there, or that it is still open. */
    why?: string;
}

const SCREENS: MoneyScreen[] = [
    { screen: 'Ledger: Send (Beans, and the Credit line tab)', file: 'pages/LedgerPage.tsx', address: [] },
    { screen: 'An enterprise or project page: its pledge form', file: 'pages/TreasuryDetailPage.tsx', address: [] },
    { screen: 'Standing deals', file: 'components/StandingDeal.tsx', address: [] },
    { screen: 'The member\'s deals', file: 'components/MyDealsModal.tsx', address: [] },
    { screen: 'Market: a listing, its buy and Bills', file: 'pages/MarketplacePage.tsx', address: [] },
    {
        screen: 'Pay the Commons', file: 'components/RepaymentCard.tsx', address: ['payback', 'amount'],
        why: 'OPEN, splits off from #3243: the admin\'s pay-back link (?payback=<code>&amount=<n>) fills in an amount. The recipient is always the Commons and the node refuses more than is left on that debt; the fix drops amount from the link and its words in every language',
    },
];

/** The address keys a source reads: `.get('x')` / `.has('x')` in a file that reads location.search, .hash or .href. */
function addressKeysOf(source: string): string[] {
    if (!/location\.(search|hash|href)/.test(source)) return [];
    return [...new Set([...source.matchAll(/\.(?:get|has)\('([^']+)'\)/g)].map((m) => m[1]))].sort();
}

describe('no money screen takes a recipient, an amount or a name from the address (review of #3243)', () => {
    // (money screen) x (the address): what it reads, as reviewed above.
    it.each(SCREENS.map((s) => [s.screen, s] as const))('%s x the address: reads only what is reviewed', (_, s) => {
        expect(addressKeysOf(read(s.file)), `${s.file}: a new read of the address needs reviewing here first`).toEqual([...s.address].sort());
        if (s.address.length) expect(s.why, s.file).toBeTruthy();
    });

    // (money screen) x (App's state): only the Ledger's Send takes a prefill, and only Learn's Thank sets it.
    it('App\'s state: only Learn\'s Thank sets the Ledger\'s request, and the Ledger takes nothing else from App for it', () => {
        const app = read('App.tsx');
        const sets = [...app.matchAll(/setLedgerSend\(([^)]*)\)/g)].map((m) => m[1]).sort();
        // One from the Thank tap (LearnPage's onThank, where Beans are live), one clearing it once the Ledger took it.
        expect(sets).toEqual(['null', 'send']);
        expect(app).toMatch(/onThank=\{beansMode === 'live' \? \(send\) => \{ setLedgerSend\(send\); setActiveTab\('ledger'\); \} : undefined\}/);
        expect(app).toMatch(/sendStart=\{ledgerSend\} onSendStartTaken=\{clearLedgerSend\}/);
    });

    it('the Ledger names the recipient only from the member list, by key: the request carries no name', () => {
        const ledger = read('pages/LedgerPage.tsx');
        expect(ledger).toMatch(/sendStart\?: \{ to: string; note: string \} \| null;/);
        expect(ledger).not.toMatch(/sendStart\.name|ask\.name/);
        expect(read('pages/LearnPage.tsx')).toMatch(/export interface LearnThank \{ to: string; note: string \}/);
    });
});
