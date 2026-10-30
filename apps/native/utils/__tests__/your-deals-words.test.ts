import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Deals S7: "My Deals" is "Your deals" everywhere a member reads it (Home's card already said so). The bare label is
// core's shared sentence, translated once for both apps; the phrases built around it (the pill's spoken name, the web's
// Close button, the info sheet's title) are the apps' own keys, drafted from each language's word for it.

const root = path.resolve(__dirname, '../../../..');
const readCatalog = (dir: string, lang: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, dir, `${lang}.json`), 'utf8'));
const langs = fs.readdirSync(path.join(root, 'packages/beanpool-core/words')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

describe('the rename in the catalogs', () => {
    it('no catalog of either app or core still has a "My Deals" key or sentence', () => {
        const left: string[] = [];
        for (const dir of ['apps/native/words', 'apps/pwa/words', 'packages/beanpool-core/words']) {
            for (const lang of langs) {
                const file = path.join(root, dir, `${lang}.json`);
                if (!fs.existsSync(file)) continue;
                for (const [key, value] of Object.entries(readCatalog(dir, lang))) {
                    if (key === '_meta') continue;
                    if (/my deals/i.test(key) || /my deals/i.test(JSON.stringify(value))) left.push(`${dir}/${lang}: ${key}`);
                }
            }
        }
        expect(left).toEqual([]);
    });

    it('every language has core\'s "Your deals" for the bare label, and no stale app key beside it', () => {
        for (const lang of langs) {
            expect(readCatalog('packages/beanpool-core/words', lang)['Your deals'], lang).toEqual(expect.any(String));
            expect(readCatalog('apps/native/words', lang)['Your deals'], `${lang} native`).toBeUndefined();
            expect(readCatalog('apps/pwa/words', lang)['Your deals'], `${lang} web`).toBeUndefined();
        }
    });

    it('the web\'s pill is "🤝 Your deals" in every language, built on that language\'s own word', () => {
        for (const lang of langs) {
            const core = readCatalog('packages/beanpool-core/words', lang)['Your deals'] as string;
            expect(readCatalog('apps/pwa/words', lang)['🤝 Your deals'], lang).toContain(core);
        }
    });
});
