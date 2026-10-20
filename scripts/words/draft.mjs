#!/usr/bin/env node
// draft.mjs — translation drafting tools (DESIGN-translation-fable.md §5, §7 row S8).
//
//   node scripts/words/draft.mjs --report [--langs <list>]
//     Per language, counts of MISSING and STALE for app words (core, native, pwa),
//     guide titles, guide pages, and website pages (hook). Exits 0 always.
//     Prints summary: "words:draft: N missing, M stale across L languages".
//
//   node scripts/words/draft.mjs --briefs <dir> [--langs <list>] [--max-keys N]
//     For each language with work, writes a self-contained brief file for an AGY Flash run
//     embedding the shared style rules (STYLE.md), listing exact keys/pages with English and
//     source hashes, and commit/push steps per catalog/page. Deterministic output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, catalogLangs, extractRepo, loadCoreChecks } from './words.mjs';
import { GUIDE_LANGS, guideBodyHash, loadGuide, parseGuideMarkdown } from '../../packages/beanpool-guide/src/guide.mjs';
import { checkGuideTitles, draftGuideTitles, guideSourceHash, readGuideTitles } from '../../packages/beanpool-guide/src/titles.mjs';

export const APP_CATALOG_DEFS = Object.freeze([
    { name: 'core', folder: 'packages/beanpool-core/words' },
    { name: 'native', folder: 'apps/native/words' },
    { name: 'pwa', folder: 'apps/pwa/words' },
]);

export const SAFETY_MONEY_PATTERNS = Object.freeze([
    { name: 'recovery', pattern: /\brecovery\b/i },
    { name: '12 words', pattern: /\b(12[- ]words?|twelve[- ]words?)\b/i },
    { name: 'sign-in', pattern: /\b(sign[- ]?in|signing[- ]?in)\b/i },
    { name: 'delete/remove', pattern: /\b(delete|remove|leaving[- ]or[- ]deleting)\b/i },
    { name: 'Beans amounts', pattern: /\b(\d+\s*beans|beans\s*(amount|balance|fee|limit|transfer|credit|fund|pool|circulation|trading)|(amount|balance|fee|limit|transfer|credit|fund|pool|circulation|trading)\s*(of\s*)?beans)\b/i },
    { name: 'limits', pattern: /\b(limits?|maximum|minimum|cap|threshold)\b/i },
    { name: 'privacy', pattern: /\b(who[- ]can[- ]see|who[- ]sees|privacy|private|what[- ]the[- ]admins[- ]can[- ]see)\b/i },
]);

/** Return true if text matches any SAFETY/MONEY pattern. */
export function isSafetyOrMoney(text) {
    if (!text || typeof text !== 'string') return false;
    return SAFETY_MONEY_PATTERNS.some((p) => p.pattern.test(text));
}

/** Check website pages translation status (hook for slice S6). */
export async function scanWebsitePages(root = ROOT, _langs = null) {
    const hookFile = path.join(root, 'apps/website/scripts/pages.mjs');
    if (fs.existsSync(hookFile)) {
        try {
            const hook = await import(hookFile);
            if (typeof hook.checkWebsitePages === 'function') {
                return hook.checkWebsitePages(root, _langs);
            }
        } catch {
            // fall through to skipped
        }
    }
    return {
        implemented: false,
        message: 'website pages: skipped (S6 not yet implemented)',
        missing: 0,
        stale: 0,
        byLang: {},
    };
}

/** Scan app words for missing and orphaned keys per catalog. */
export async function scanAppWords({ root = ROOT, catalogDefs = APP_CATALOG_DEFS, langs = null, extracted = null } = {}) {
    const { callKey } = await loadCoreChecks(ROOT);
    extracted ??= extractRepo(root);
    const targetLangs = langs ?? (await catalogLangs(ROOT));

    // Map catalog folder -> { keys: Set, sources: Map(key -> [file:line]) }
    const byFolder = new Map();
    for (const def of catalogDefs) {
        byFolder.set(def.folder, { keys: new Set(), sources: new Map() });
    }

    for (const pkg of extracted) {
        if (!pkg.words || !byFolder.has(pkg.words)) continue;
        const entry = byFolder.get(pkg.words);
        for (const call of pkg.calls) {
            const key = callKey(call);
            if (!key) continue;
            entry.keys.add(key);
            if (!entry.sources.has(key)) entry.sources.set(key, []);
            entry.sources.get(key).push(call.at);
        }
    }

    const result = {};
    for (const lang of targetLangs) {
        result[lang] = { missing: 0, stale: 0, orphaned: 0, byCatalog: {}, items: [] };
        for (const def of catalogDefs) {
            const folderData = byFolder.get(def.folder);
            const sourceKeys = folderData?.keys ?? new Set();
            const sourceLocations = folderData?.sources ?? new Map();

            const file = path.join(root, def.folder, `${lang}.json`);
            let catalog = null;
            if (fs.existsSync(file)) {
                try {
                    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
                } catch {
                    catalog = null;
                }
            }

            const catMissing = [];
            const catOrphaned = [];

            if (catalog === null) {
                // Whole file missing
                for (const key of [...sourceKeys].sort()) {
                    const item = {
                        catalog: def.name,
                        folder: def.folder,
                        key,
                        sources: sourceLocations.get(key) ?? [],
                        sourceHash: guideSourceHash(key),
                        safety: isSafetyOrMoney(key),
                    };
                    catMissing.push(item);
                    result[lang].items.push(item);
                }
            } else {
                for (const key of [...sourceKeys].sort()) {
                    if (catalog[key] === undefined) {
                        const item = {
                            catalog: def.name,
                            folder: def.folder,
                            key,
                            sources: sourceLocations.get(key) ?? [],
                            sourceHash: guideSourceHash(key),
                            safety: isSafetyOrMoney(key),
                        };
                        catMissing.push(item);
                        result[lang].items.push(item);
                    }
                }
                for (const key of Object.keys(catalog).sort()) {
                    if (key === '_meta') continue;
                    if (!sourceKeys.has(key)) {
                        catOrphaned.push({
                            catalog: def.name,
                            folder: def.folder,
                            key,
                            safety: isSafetyOrMoney(key),
                        });
                    }
                }
            }

            result[lang].byCatalog[def.name] = {
                missing: catMissing.length,
                stale: 0,
                orphaned: catOrphaned.length,
                missingKeys: catMissing,
                orphanedKeys: catOrphaned,
            };
            result[lang].missing += catMissing.length;
            result[lang].orphaned += catOrphaned.length;
        }
    }

    return result;
}

/** Scan guide titles and summaries using beanpool-guide. */
export function scanGuideTitles({ root = ROOT, langs = null } = {}) {
    const contentDir = path.join(root, 'packages/beanpool-guide/content');
    const guide = loadGuide(contentDir);
    const read = readGuideTitles(contentDir);
    const { counts, stale } = checkGuideTitles(guide, read);
    const targetLangs = langs ?? GUIDE_LANGS;

    const result = {};
    for (const lang of targetLangs) {
        const c = counts[lang] ?? { translated: 0, stale: 0, missing: 0, total: 0 };
        const staleItems = stale[lang] ?? [];
        const staleKeySet = new Set(staleItems.map((s) => s.key));

        const draft = draftGuideTitles(guide, read.files[lang]);
        const missingItems = [];
        for (const [group, entries] of Object.entries(draft)) {
            for (const [id, fields] of Object.entries(entries)) {
                for (const [field, val] of Object.entries(fields)) {
                    const key = `${group}.${id}.${field}`;
                    if (!staleKeySet.has(key)) {
                        missingItems.push({
                            key,
                            english: val.text,
                            sourceHash: val.sourceHash,
                            safety: isSafetyOrMoney(key) || isSafetyOrMoney(val.text),
                        });
                    }
                }
            }
        }

        const formattedStale = staleItems.map((s) => ({
            key: s.key,
            english: s.english,
            sourceHash: guideSourceHash(s.english),
            safety: isSafetyOrMoney(s.key) || isSafetyOrMoney(s.english),
        }));

        result[lang] = {
            missing: c.missing,
            stale: c.stale,
            missingItems,
            staleItems: formattedStale,
        };
    }

    return { guide, read, byLang: result };
}

/** Scan guide pages for missing and stale (source-hash behind) files. */
export function scanGuidePages({ root = ROOT, langs = null, guide = null } = {}) {
    const contentDir = path.join(root, 'packages/beanpool-guide/content');
    guide ??= loadGuide(contentDir);
    const targetLangs = langs ?? GUIDE_LANGS;

    const result = {};
    for (const lang of targetLangs) {
        let missing = 0;
        let stale = 0;
        const missingPages = [];
        const stalePages = [];

        for (const g of guide.guides) {
            const pagePath = path.join(contentDir, lang, g.section, `${g.slug}.md`);
            const enHash = guideBodyHash(g);
            const safety = isSafetyOrMoney(g.slug) || isSafetyOrMoney(g.title);

            if (!fs.existsSync(pagePath)) {
                missing++;
                missingPages.push({
                    section: g.section,
                    slug: g.slug,
                    title: g.title,
                    sourceHash: enHash,
                    status: 'missing',
                    safety,
                });
            } else {
                try {
                    const raw = fs.readFileSync(pagePath, 'utf8');
                    const parsed = parseGuideMarkdown(raw, pagePath, { isTranslated: true });
                    if (parsed.sourceHash !== enHash) {
                        stale++;
                        stalePages.push({
                            section: g.section,
                            slug: g.slug,
                            title: g.title,
                            sourceHash: enHash,
                            currentHash: parsed.sourceHash,
                            status: 'stale',
                            safety,
                        });
                    }
                } catch {
                    // Unparseable or invalid translated file treated as stale
                    stale++;
                    stalePages.push({
                        section: g.section,
                        slug: g.slug,
                        title: g.title,
                        sourceHash: enHash,
                        status: 'stale',
                        safety,
                    });
                }
            }
        }

        result[lang] = {
            missing,
            stale,
            missingPages,
            stalePages,
        };
    }

    return result;
}

/** Complete drafting status across all sources. */
export async function draftStatus({ root = ROOT, langs = null, catalogDefs = APP_CATALOG_DEFS, extracted = null } = {}) {
    const allLangs = langs ?? (await catalogLangs(ROOT));
    const [appWords, guideTitlesResult, website] = await Promise.all([
        scanAppWords({ root, langs: allLangs, catalogDefs, extracted }),
        scanGuideTitles({ root, langs: allLangs }),
        scanWebsitePages(root, allLangs),
    ]);
    const guidePages = scanGuidePages({ root, langs: allLangs, guide: guideTitlesResult.guide });

    const perLang = {};
    let totalMissing = 0;
    let totalStale = 0;

    for (const lang of allLangs) {
        const aw = appWords[lang] ?? { missing: 0, stale: 0, orphaned: 0, byCatalog: {}, items: [] };
        const gt = guideTitlesResult.byLang[lang] ?? { missing: 0, stale: 0, missingItems: [], staleItems: [] };
        const gp = guidePages[lang] ?? { missing: 0, stale: 0, missingPages: [], stalePages: [] };
        const ws = website.byLang?.[lang] ?? { missing: 0, stale: 0 };

        const langMissing = aw.missing + gt.missing + gp.missing + ws.missing;
        const langStale = aw.stale + gt.stale + gp.stale + ws.stale;
        totalMissing += langMissing;
        totalStale += langStale;

        let safetyCount = 0;
        for (const item of aw.items) if (item.safety) safetyCount++;
        for (const item of gt.missingItems) if (item.safety) safetyCount++;
        for (const item of gt.staleItems) if (item.safety) safetyCount++;
        for (const item of gp.missingPages) if (item.safety) safetyCount++;
        for (const item of gp.stalePages) if (item.safety) safetyCount++;

        perLang[lang] = {
            lang,
            appWords: aw,
            guideTitles: gt,
            guidePages: gp,
            website: ws,
            missing: langMissing,
            stale: langStale,
            orphaned: aw.orphaned,
            safetyMoney: safetyCount,
            hasWork: langMissing > 0 || langStale > 0,
        };
    }

    const languagesWithWork = Object.values(perLang).filter((l) => l.hasWork).length;
    const summaryLine = `words:draft: ${totalMissing} missing, ${totalStale} stale across ${languagesWithWork} languages`;

    return {
        root,
        langs: allLangs,
        perLang,
        website,
        totalMissing,
        totalStale,
        languagesWithWork,
        summaryLine,
    };
}

/** Print the drafting report (always exits 0). */
export async function reportDraft({ root = ROOT, langs = null } = {}) {
    const status = await draftStatus({ root, langs });

    if (status.website?.message) {
        console.log(status.website.message);
        console.log('');
    }

    for (const lang of status.langs) {
        const l = status.perLang[lang];
        console.log(`${lang}:`);
        console.log('  app words:');
        for (const def of APP_CATALOG_DEFS) {
            const cat = l.appWords.byCatalog[def.name] ?? { missing: 0, stale: 0, orphaned: 0 };
            console.log(`    ${def.name}: ${cat.missing} missing, ${cat.stale} stale, ${cat.orphaned} orphaned`);
        }
        console.log(`  guide titles: ${l.guideTitles.missing} missing, ${l.guideTitles.stale} stale`);
        console.log(`  guide pages: ${l.guidePages.missing} missing, ${l.guidePages.stale} stale`);
        console.log(`  safety/money: ${l.safetyMoney} missing/stale needing meaning-check`);
    }

    console.log('');
    console.log(status.summaryLine);
    return 0;
}

/** Write self-contained brief files for AGY Flash. */
export async function writeBriefs({ root = ROOT, dir, langs = null, maxKeys = null, catalogDefs = APP_CATALOG_DEFS, extracted = null } = {}) {
    if (!dir) {
        console.error('words:draft --briefs requires a destination directory: --briefs <dir>');
        return 2;
    }

    const outDir = path.resolve(root, dir);
    fs.mkdirSync(outDir, { recursive: true });

    const status = await draftStatus({ root, langs, catalogDefs, extracted });
    const rulesFile = path.join(root, 'scripts/words/STYLE.md');
    const styleRules = fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8') : '';

    const written = [];
    for (const lang of status.langs) {
        const l = status.perLang[lang];
        if (!l.hasWork) continue;

        const briefLines = [];
        briefLines.push(`# Translation Drafting Brief: ${lang.toUpperCase()}`);
        briefLines.push('');
        briefLines.push(`Target Language: **${lang}** (AGY Flash drafting run).`);
        briefLines.push('BeanPool is a community app where people trade with "Beans", post Offers and Needs, and decide things together.');
        briefLines.push('Work ONLY in your assigned worktree and branch. Never contact any BeanPool server.');
        briefLines.push('Never merge, deploy, or open a pull request (the director merges after meaning-check). Stage named files only.');
        briefLines.push('');
        briefLines.push(`## Work Summary for ${lang}`);
        briefLines.push(`- App words missing: core (${l.appWords.byCatalog.core?.missing ?? 0}), native (${l.appWords.byCatalog.native?.missing ?? 0}), pwa (${l.appWords.byCatalog.pwa?.missing ?? 0})`);
        briefLines.push(`- Guide titles: ${l.guideTitles.missing} missing, ${l.guideTitles.stale} stale`);
        briefLines.push(`- Guide pages: ${l.guidePages.missing} missing, ${l.guidePages.stale} stale`);
        briefLines.push(`- Safety/Money items requiring strict fidelity: ${l.safetyMoney}`);
        briefLines.push('');
        briefLines.push('---');
        briefLines.push('');
        briefLines.push('## Style Rules and Glossary');
        briefLines.push('');
        briefLines.push(styleRules.trim());
        briefLines.push('');
        briefLines.push('---');
        briefLines.push('');
        briefLines.push('## Exact Items to Draft');
        briefLines.push('');

        // App Words
        let keysRemaining = maxKeys !== null && maxKeys > 0 ? maxKeys : Infinity;
        briefLines.push('### 1. App Words');
        for (const def of APP_CATALOG_DEFS) {
            const cat = l.appWords.byCatalog[def.name];
            const missing = cat?.missingKeys ?? [];
            briefLines.push(`\n#### Catalog: ${def.folder}/${lang}.json (${missing.length} missing)\n`);
            if (missing.length === 0) {
                briefLines.push('_All keys up to date._\n');
                continue;
            }

            const toList = missing.slice(0, keysRemaining);
            keysRemaining -= toList.length;

            for (const item of toList) {
                const src = item.sources.slice(0, 2).join(', ');
                const tag = item.safety ? ' [SAFETY/MONEY]' : '';
                briefLines.push(`- **Key**: ${JSON.stringify(item.key)}${tag}`);
                briefLines.push(`  - Source Hash: \`${item.sourceHash}\``);
                if (src) briefLines.push(`  - Context: \`${src}\``);
            }
            if (missing.length > toList.length) {
                briefLines.push(`\n_...and ${missing.length - toList.length} more keys (capped by --max-keys)._\n`);
            }
        }

        // Guide Titles
        briefLines.push('\n### 2. Guide Titles and Summaries');
        briefLines.push(`File: \`packages/beanpool-guide/content/${lang}/manifest.json\`\n`);
        const titleItems = [
            ...l.guideTitles.missingItems.map((it) => ({ ...it, status: 'MISSING' })),
            ...l.guideTitles.staleItems.map((it) => ({ ...it, status: 'STALE' })),
        ].sort((a, b) => a.key.localeCompare(b.key));

        if (titleItems.length === 0) {
            briefLines.push('_All guide titles up to date._\n');
        } else {
            for (const item of titleItems) {
                const tag = item.safety ? ' [SAFETY/MONEY]' : '';
                briefLines.push(`- **${item.key}** (${item.status})${tag}`);
                briefLines.push(`  - English: ${JSON.stringify(item.english)}`);
                briefLines.push(`  - Source Hash: \`${item.sourceHash}\``);
            }
        }

        // Guide Pages
        briefLines.push('\n### 3. Guide Pages');
        const pageItems = [
            ...l.guidePages.missingPages.map((p) => ({ ...p, status: 'MISSING' })),
            ...l.guidePages.stalePages.map((p) => ({ ...p, status: 'STALE' })),
        ].sort((a, b) => `${a.section}/${a.slug}`.localeCompare(`${b.section}/${b.slug}`));

        if (pageItems.length === 0) {
            briefLines.push('_All guide pages up to date._\n');
        } else {
            for (const page of pageItems) {
                const tag = page.safety ? ' [SAFETY/MONEY]' : '';
                briefLines.push(`- **${page.section}/${page.slug}** (${page.status})${tag}`);
                briefLines.push(`  - Title: ${JSON.stringify(page.title)}`);
                briefLines.push(`  - Source Hash: \`${page.sourceHash}\``);
                briefLines.push(`  - Target File: \`packages/beanpool-guide/content/${lang}/${page.section}/${page.slug}.md\``);
            }
        }

        briefLines.push('');
        briefLines.push('---');
        briefLines.push('');
        briefLines.push('## Commit and Push Sequence');
        briefLines.push('');
        briefLines.push('### A. App Words Catalogs');
        briefLines.push('Edit each catalog in order: `core`, then `native`, then `pwa`. After editing each:');
        briefLines.push('1. Run structural check: `node scripts/words/words.mjs check` (must exit 0).');
        briefLines.push('2. `git add <catalog-file>`');
        briefLines.push('3. `git commit -m "Words: <lang> <catalog> (machine draft)"`');
        briefLines.push('4. `git push -u origin <branch>`');
        briefLines.push('');
        briefLines.push('### B. Guide Titles');
        briefLines.push('Edit `packages/beanpool-guide/content/<lang>/manifest.json`.');
        briefLines.push('1. Check: `node packages/beanpool-guide/scripts/build.mjs --check`');
        briefLines.push('2. `git add packages/beanpool-guide/content/<lang>/manifest.json`');
        briefLines.push('3. `git commit -m "Guide titles: <lang> (machine draft)"`');
        briefLines.push('4. `git push -u origin <branch>`');
        briefLines.push('');
        briefLines.push('### C. Guide Pages');
        briefLines.push('For each page:');
        briefLines.push('1. Draft scaffold: `node packages/beanpool-guide/scripts/titles.mjs --draft-page <lang> <slug> > packages/beanpool-guide/content/<lang>/<section>/<slug>.md`');
        briefLines.push('2. Translate body under front matter in full. Keep front matter untouched.');
        briefLines.push('3. Check: `node packages/beanpool-guide/scripts/build.mjs --check`');
        briefLines.push('4. `git add packages/beanpool-guide/content/<lang>/<section>/<slug>.md`');
        briefLines.push('5. `git commit -m "Guide page: <lang> <slug> (machine draft)"`');
        briefLines.push('6. `git push -u origin <branch>`');
        briefLines.push('');
        briefLines.push('### D. Finish');
        briefLines.push('When all items are drafted: verify `node scripts/words/words.mjs check` ok, then STOP. Do not open a PR.');
        briefLines.push('');

        const briefContent = briefLines.join('\n');
        const briefPath = path.join(outDir, `brief-${lang}.md`);
        fs.writeFileSync(briefPath, briefContent);
        written.push(briefPath);
    }

    console.log(`words:draft — wrote ${written.length} brief(s) in ${outDir}`);
    return 0;
}

/** CLI Entrypoint */
export async function draftCli(argv = process.argv.slice(2), root = ROOT) {
    let mode = null;
    let briefsDir = null;
    let langs = null;
    let maxKeys = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--report') {
            mode = 'report';
        } else if (arg === '--briefs') {
            mode = 'briefs';
            briefsDir = argv[++i];
        } else if (arg === '--langs') {
            const raw = argv[++i] ?? '';
            langs = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        } else if (arg === '--max-keys') {
            const n = parseInt(argv[++i], 10);
            if (!Number.isNaN(n) && n > 0) maxKeys = n;
        }
    }

    if (mode === 'report') {
        return reportDraft({ root, langs });
    }
    if (mode === 'briefs') {
        return writeBriefs({ root, dir: briefsDir, langs, maxKeys });
    }

    console.error('usage: node scripts/words/draft.mjs --report [--langs <l1,l2>] | --briefs <dir> [--langs <l1,l2>] [--max-keys N]');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await draftCli(process.argv.slice(2));
}
