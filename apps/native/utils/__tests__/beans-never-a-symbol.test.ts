/**
 * Beans are never a symbol (memory currency-display-beans; GLOSSARY.csv "Beans": no currency symbol is used). New Post's fee
 * line said "1.5% fee: You will receive 4.93 B." on the phone and on the web (seen in video-02, 25 Nov): it says Beans now.
 *
 * Reads every words key the phone, the web app and core hand to t()/tn()/word() in their sources, and finds each one that
 * writes an amount followed by a bare "B" (or the Cyrillic "Б"). Those still left are the older lines named in LEFT, for a
 * words round of their own; the list only shrinks, and a new one goes red here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const SOURCES = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/pwa/src', 'packages/beanpool-core/src'];

/** Lines that still write "B" after an amount, each fixed in a words round of its own (small follow-ups 20). Only shrinks. */
const LEFT = [
    '-{amount} B',
    '{amount} B',
    '{amount}B',
    'You can only send beans you hold — your balance is {balance}B.',
    'This is a free listing (0 B). No credits transferred.',
    'In active economies, members spend earned credits quickly (staying in the fee-free green zone under 200B). Holding fees alone are insufficient to cover defaults.',
    'Transferring {n} B to {name}',
    'Nothing is held until the lender says yes. Then {total} B go into a Trust Wallet, and once it is back the lender receives {net} B (net of 1.5% transaction fee {owned} to fund the Commons Pool).',
    'By proceeding, you commit {total} B ({duration}) to a Trust Wallet. When finalized, the provider will receive {net} B (net of 1.5% transaction fee {owned} to fund the Commons Pool).',
    'By proceeding, you commit {total} B to a Trust Wallet. When finalized, the provider will receive {net} B (net of 1.5% transaction fee {owned} to fund the Commons Pool).',
].sort();

/** An amount written as a placeholder or a number, then a bare B: "{amount} B", "{n}B.", "4.93 B". */
const AMOUNT_THEN_B = /(?:\{\w+\}|\d)\s?[BБ](?![\p{L}\p{N}])/u;

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            out.push(...sourceFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Each single-quoted, double-quoted or plain back-quoted first argument of t(), tn(), word() or wordn(). */
function wordsKeys(source: string): string[] {
    const keys: string[] = [];
    const call = /\b(?:t|tn|word|wordn)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`)/g;
    for (const m of source.matchAll(call)) keys.push((m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1'));
    return keys;
}

function keysWritingB(): string[] {
    const found = new Set<string>();
    for (const dir of SOURCES) {
        for (const file of sourceFiles(path.join(ROOT, dir))) {
            for (const key of wordsKeys(fs.readFileSync(file, 'utf8'))) if (AMOUNT_THEN_B.test(key)) found.add(key);
        }
    }
    return [...found].sort();
}

describe('Beans are never a symbol', () => {
    it('the rule reads a bare B after an amount, and nothing else', () => {
        for (const yes of ['{amount} B.', '4.93 B', '{n}B', '{amount} Б.']) expect(AMOUNT_THEN_B.test(yes), yes).toBe(true);
        for (const no of ['{amount} Beans.', '{n} Bills', '12 Bytes', 'Plan B', '{amount} Бобы']) expect(AMOUNT_THEN_B.test(no), no).toBe(false);
    });

    it("New Post's fee line says Beans on the phone and on the web", () => {
        const phone = fs.readFileSync(path.join(ROOT, 'apps/native/app/new-listing.tsx'), 'utf8');
        const web = fs.readFileSync(path.join(ROOT, 'apps/pwa/src/pages/MapPage.tsx'), 'utf8');
        for (const source of [phone, web]) {
            expect(wordsKeys(source)).toContain('1.5% fee: You will receive {amount} Beans.');
            expect(wordsKeys(source)).toContain('1.5% fee: Fulfiller receives {amount} Beans.');
        }
    });

    it('no words key in the phone, the web app or core writes B after an amount, but the older lines named here', () => {
        expect(keysWritingB()).toEqual(LEFT);
    });

    it("each language's fee line carries the language's own word for Beans, never a B", () => {
        for (const dir of ['apps/native/words', 'apps/pwa/words']) {
            for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => /^[A-Za-z-]+\.json$/.test(f))) {
                const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, dir, file), 'utf8')) as Record<string, string>;
                for (const key of ['1.5% fee: You will receive {amount} Beans.', '1.5% fee: Fulfiller receives {amount} Beans.']) {
                    const value = catalog[key];
                    expect(value, `${dir}/${file}: ${key}`).toBeTypeOf('string');
                    expect(AMOUNT_THEN_B.test(value), `${dir}/${file}: ${value}`).toBe(false);
                    expect(value, `${dir}/${file}`).toContain('{amount}');
                }
                expect(catalog['1.5% fee: You will receive {amount} B.'], `${dir}/${file}: old key`).toBeUndefined();
            }
        }
    });
});
