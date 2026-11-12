/**
 * Source guards for the web's credit surfaces (DESIGN-credit-list-fable.md §8 tests 12 and 23; amendment 1 §5.1; the slice's
 * STOP: "as the phone's, for the web's storage and its service worker"). These read the files, so a check here fails the moment
 * a file reaches for what it must not. Each names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Comments say what the code must not do; only code is held to it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CREDIT_FILES = [
    'lib/credit-sight.ts',
    'components/CreditLines.tsx',
    'components/AskForMore.tsx',
    'components/GiveCreditSheet.tsx',
    'components/CreditPeoplePanel.tsx',
    'components/CreditCard.tsx',
    'components/CreditLooksSection.tsx',
];

describe('what the web’s credit files never reach for', () => {
    it('keep nothing: no localStorage, sessionStorage, IndexedDB, Cache API, cookie or service-worker message (a balance on a screen is a look)', () => {
        for (const f of CREDIT_FILES) {
            const c = code(read(f));
            expect(c, f).not.toMatch(/localStorage|sessionStorage|indexedDB|\bcaches\b|document\.cookie|serviceWorker|postMessage/);
        }
        // Red when the credit view is kept for offline.
    });

    it('import no names-list key code: the web holds no key, and Confirm says it is done in the app', () => {
        for (const f of CREDIT_FILES) {
            const c = code(read(f));
            expect(c, f).not.toMatch(/names-list|namesList|NamesList|sealed|entry-key|entryKey|names-key|unlockNames/i);
        }
        // Red when the web gains a confirm path.
    });

    it('write through the node’s own routes only: the vouch, the known floor, the ask and a budget; never a top-up level of its own', () => {
        const all = CREDIT_FILES.map((f) => code(read(f))).join('\n');
        const writes = [...all.matchAll(/request(?:<[^>]*>)?\(\s*'(POST|PUT|PATCH|DELETE)'\s*,\s*[`']([^`']+)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
        expect(writes).toEqual(['POST /api/credit/known-floor', 'POST /api/vouchers/ask']);
        // The vouch and the budget go through the existing writers in lib/api (vouchForMember, setVoucherBudget).
        expect(all).toMatch(/vouchForMember\(/);
        expect(all).toMatch(/setVoucherBudget\(row\.memberPubkey, row\.topUpTo_c\)/);
        // Red when a second writer appears, or the app works out a level.
    });

    it('draw every reason through core: no reason is composed from values in the web', () => {
        for (const f of CREDIT_FILES) {
            const c = code(read(f));
            expect(c, f).not.toMatch(/They owe|By their own trading|more than half|Fewer than half|written off\.|froze their credit/);
        }
        expect(code(read('components/CreditLines.tsx'))).toMatch(/riskReasonSentence\(/);
        // Red when a reason is written out instead of drawn from core's riskReasonSentence.
    });

    it('a plain member’s screens ask for no credit before the node says they give it', () => {
        const panel = code(read('components/CreditPeoplePanel.tsx'));
        // The list is read only inside an effect that waits for `on` and `may` (the node's own answers).
        expect(panel).toMatch(/if \(!on \|\| !may \|\| chip === 'vouchers'\) return;/);
        expect(panel).toMatch(/if \(!on \|\| !full\) return;/);
        // The log and the card are asked of the node only after its role answer.
        expect(code(read('components/CreditLooksSection.tsx'))).toMatch(/node-admin\/me/);
        expect(code(read('components/CreditCard.tsx'))).toMatch(/if \(!owner && myVouching\?\.voucher !== true\) return;/);
    });
});

describe('the service worker caches nothing (the web’s STOP condition)', () => {
    it('public/sw.js has no fetch handler and uses no cache, so no /api/credit answer can be kept by it', () => {
        const sw = code(fs.readFileSync(path.resolve(SRC, '..', 'public', 'sw.js'), 'utf8'));
        expect(sw).not.toMatch(/addEventListener\(\s*['"]fetch['"]|onfetch|respondWith|\bcaches\b|cache\.put|cache\.add/);
        // Red when a fetch handler or a cache is added to the worker.
    });
});
