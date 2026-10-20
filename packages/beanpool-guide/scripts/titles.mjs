#!/usr/bin/env node
// The guide's titles and summaries in other languages (src/titles.mjs): what the drafting round has to do.
//
//   node scripts/titles.mjs                  per language: lines translated, stale and missing, then every stale line
//                                            (drafted from English that has changed since; the apps show the English).
//                                            Exit 1 only when a titles file does not check (scripts/build.mjs --check
//                                            refuses the same), never for stale or missing lines.
//   node scripts/titles.mjs --draft <lang>   the lines <lang> is missing or holds stale, in its file's shape, with the
//                                            English as "text" and today's sourceHash: translate each "text" and merge
//                                            the entries into content/<lang>/manifest.json.
//   node scripts/titles.mjs --draft-page <lang> <slug>
//                                            the English page's front matter and body with source-hash, ready to
//                                            translate into content/<lang>/<section>/<slug>.md.
//
// Run from anywhere: pnpm --filter @beanpool/guide titles. The draft is JSON for a file or an agent, so run it with node
// (node packages/beanpool-guide/scripts/titles.mjs --draft <lang> > draft.json): pnpm --filter prints its own banner
// before it, even with -s.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGuide, GUIDE_LANGS } from '../src/guide.mjs';
import { readGuideTitles, checkGuideTitles, draftGuideTitles, draftGuidePage } from '../src/titles.mjs';

const CONTENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content');
const USAGE = 'Usage: node scripts/titles.mjs [--draft <lang> | --draft-page <lang> <slug>]';

function main(args) {
    const guide = loadGuide(CONTENT_DIR);
    const read = readGuideTitles(CONTENT_DIR);
    if (args[0] === '--draft') {
        const lang = args[1];
        if (args.length !== 2 || !GUIDE_LANGS.includes(lang)) {
            console.error(`${USAGE}\n<lang> is one of ${GUIDE_LANGS.join(', ')}`);
            return 2;
        }
        console.log(JSON.stringify(draftGuideTitles(guide, read.files[lang]), null, 2));
        return 0;
    }
    if (args[0] === '--draft-page') {
        const lang = args[1];
        const slug = args[2];
        if (args.length !== 3 || !GUIDE_LANGS.includes(lang) || !slug) {
            console.error(`${USAGE}\n<lang> is one of ${GUIDE_LANGS.join(', ')}`);
            return 2;
        }
        try {
            process.stdout.write(draftGuidePage(CONTENT_DIR, lang, slug));
            return 0;
        } catch (e) {
            console.error(e.message);
            return 1;
        }
    }
    if (args.length) {
        console.error(USAGE);
        return 2;
    }
    const { problems, stale, counts } = checkGuideTitles(guide, read);
    for (const lang of GUIDE_LANGS) {
        const c = counts[lang];
        console.log(`${lang.padEnd(8)} ${String(c.translated).padStart(3)} of ${c.total} translated, ${String(c.stale).padStart(3)} stale, ${String(c.missing).padStart(3)} missing`);
    }
    for (const lang of GUIDE_LANGS) {
        for (const s of stale[lang]) console.log(`stale ${lang} ${s.key}: the English is now ${JSON.stringify(s.english)}`);
    }
    if (problems.length) {
        console.error(`\nThe titles do not check:\n${problems.map(p => `  - ${p}`).join('\n')}`);
        return 1;
    }
    return 0;
}

process.exitCode = main(process.argv.slice(2));
