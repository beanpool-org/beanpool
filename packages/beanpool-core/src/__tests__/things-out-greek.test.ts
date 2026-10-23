/**
 * The Tool shed's counts in Greek (tools/things/manifest.ts thingsHomeLines and its row; the phone's shop line): the
 * plural form is chosen by the number of things ({n}), so the word beside the number lent out ({out}) can't agree with
 * it in a language whose adjective does ("1 δανεισμένα" with three things, one out). The Greek says "σε δανεισμό" (on
 * loan), which is the same for one and many.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordsFor, type PluralWord } from '../words.js';
import { THINGS, thingsHomeLines } from '../tools/things/manifest.js';
import type { ThingsDoc } from '../tools/things/doc.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalog = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;

const NOW = Date.parse('2026-10-23T00:00:00.000Z');
const thing = (id: string, out: boolean) => ({
    id, name: `Thing ${id}`, kind: 'tool', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...(out ? { lentTo: { name: 'Ana', since: '2026-10-20' } } : {}),
});

describe('the Tool shed\'s "out" count in Greek', () => {
    const el = wordsFor('el', [catalog('packages/beanpool-core/words/el.json')]);

    it('reads right with one out of three, and with three out of three', () => {
        for (const [doc, line] of [
            [{ v: 1, things: [thing('a', true), thing('b', false), thing('c', false)] }, '3 πράγματα · 1 σε δανεισμό'],
            [{ v: 1, things: [thing('a', true), thing('b', true), thing('c', true)] }, '3 πράγματα · 3 σε δανεισμό'],
        ] as const) {
            const [l] = thingsHomeLines(doc as unknown as ThingsDoc, NOW);
            expect(l, line).toBeDefined();
            const key = l.key as PluralWord;
            expect(el.tn(l.n!, key.one, key.other, l.values)).toBe(line);
        }
        const row = THINGS.row!({ v: 1, things: [thing('a', true), thing('b', false)] } as unknown as ThingsDoc, NOW);
        const rowKey = row!.key as PluralWord;
        expect(el.tn(row!.n!, rowKey.one, rowKey.other, row!.values)).toMatch(/^2 πράγματα · \d+ στο κατάστημά σας · 1 σε δανεισμό$/);
    });

    it('the phone\'s shop line says it the same way', () => {
        const phone = wordsFor('el', [catalog('apps/native/words/el.json')]);
        expect(phone.t('{n} out', { n: 1 }, 'things lent out now')).toBe('1 σε δανεισμό');
        expect(phone.t('{n} out', { n: 4 }, 'things lent out now')).toBe('4 σε δανεισμό');
    });
});
