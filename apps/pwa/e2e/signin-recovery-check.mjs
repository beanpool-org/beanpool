/**
 * MEASURES Settings' "Sign-in recovery" line (G11-c) and the recovery seal's sentence under a connected sign-in (S3) in
 * a real Chromium layout at the documented floor, 320px with 1.3x text (and a 260px stress case), light and dark:
 * nothing may reach past the viewport, the page may not scroll sideways, the sentence must be under both connected
 * sign-ins and not under the one that isn't, whole (not clipped), wrapped, and at 4.5:1 contrast or more. Photographs
 * each case to e2e/shots/.
 *
 * A browser without its 12 words (restored from a sign-in copy that carried none): the line says they aren't saved
 * here, never "as your 12 words do", "use only your 12 words" or "are the way back", and the line above the sentence
 * is at 4.5:1 too, with the words and without. Then the whole Account & Identity section of the real Settings page
 * (settings-recovery-harness), with the words and without, connected and not: the "You haven't saved your recovery
 * phrase yet" banner only with the words, View Recovery Phrase saying "Not saved in this browser" without them, and
 * the words screen without them saying so instead of asking to write down words it can't show. Photographed too.
 *
 * Nothing here touches a BeanPool node: the line takes the node's answer as a prop, and any /api or /ws request is
 * aborted and counted, so a stray fetch fails the run instead of escaping.
 *
 *   node e2e/signin-recovery-check.mjs     # exits non-zero on any problem
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory.
 */
/* global process, console, document, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

const CASES = [
    { name: 'phone-320-130pc', width: 320, height: 900, fontScale: 1.3 },
    { name: 'STRESS-narrow-260-130pc', width: 260, height: 1100, fontScale: 1.3 },
];

/** Runs in the page: overflow, sideways scroll, and the sentence under each case. */
const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`${el.tagName.toLowerCase()} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cases = {};
    for (const id of ['case-one', 'case-many', 'case-none', 'case-one-nowords', 'case-none-nowords']) {
        const box = document.querySelector(`[data-testid="${id}"]`);
        const card = box?.querySelector('[data-testid="signin-recovery"]');
        const line = box?.querySelector('[data-testid="signin-recovery-openers"]');
        const wayBack = box?.querySelector('[data-testid="signin-recovery-way-back"]');
        const cardBg = card ? lum(rgb(getComputedStyle(card).backgroundColor)) : 0;
        const onCard = (el) => {
            const fg = lum(rgb(getComputedStyle(el).color));
            return Math.round(((Math.max(fg, cardBg) + 0.05) / (Math.min(fg, cardBg) + 0.05)) * 100) / 100;
        };
        const wayBackOf = wayBack ? { wayBackText: wayBack.textContent, wayBackContrast: onCard(wayBack) } : { wayBackText: null, wayBackContrast: 0 };
        if (!line) { cases[id] = { line: false, ...wayBackOf }; continue; }
        const lr = line.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(line).lineHeight);
        const fg = lum(rgb(getComputedStyle(line).color));
        const bg = cardBg;
        cases[id] = {
            ...wayBackOf,
            line: true,
            text: line.textContent,
            insideCard: lr.left >= cr.left - 0.5 && lr.right <= cr.right + 0.5 && lr.bottom <= cr.bottom + 0.5,
            clipped: line.scrollHeight > line.clientHeight + 1 || line.scrollWidth > line.clientWidth + 1,
            lines: Math.round(lr.height / lineHeight),
            fontPx: parseFloat(getComputedStyle(line).fontSize),
            contrast: Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100,
        };
    }
    return { overflow: out, pageScrollsSideways: document.documentElement.scrollWidth > vw, cases };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) {
        for (const c of CASES) {
            const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: theme });
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/signin-recovery-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate(([t, scale]) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, [theme, c.fontScale]);
            await page.waitForSelector('[data-testid="signin-recovery"]');
            await page.evaluate(() => document.fonts.ready);

            const shot = `signin-recovery-${c.name}-${theme}.png`;
            await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: true });
            const m = await page.evaluate(MEASURE);
            for (const id of ['case-one', 'case-many']) {
                const k = m.cases[id];
                if (!k.line) { failures.push(`${shot}: no sentence under the connected sign-in (${id})`); continue; }
                if (!k.insideCard) failures.push(`${shot}: the sentence reaches outside its card (${id})`);
                if (k.clipped) failures.push(`${shot}: the sentence is cut off (${id})`);
                if (k.lines < 2) failures.push(`${shot}: the sentence did not wrap (${id}, ${k.lines} line)`);
                if (!/can open the copy/.test(k.text)) failures.push(`${shot}: unexpected text (${id}) "${k.text}"`);
                if (k.contrast < 4.5) failures.push(`${shot}: the sentence is too faint to read (${id}, ${k.contrast}:1, under 4.5:1)`);
            }
            if (m.cases['case-none'].line) failures.push(`${shot}: a sentence under "not connected"`);
            // Without the words: who can open the copy, never "use only your 12 words"; and the line above says what is true.
            const oneNoWords = m.cases['case-one-nowords'];
            if (!oneNoWords.line) failures.push(`${shot}: no sentence under the connected sign-in without the words`);
            else if (/use only your 12 words/.test(oneNoWords.text)) failures.push(`${shot}: "use only your 12 words" on a browser without them`);
            if (m.cases['case-none-nowords'].line) failures.push(`${shot}: a sentence under "not connected" without the words`);
            for (const id of ['case-one', 'case-many', 'case-none', 'case-one-nowords', 'case-none-nowords']) {
                const k = m.cases[id];
                const noWords = id.endsWith('-nowords');
                if (!k.wayBackText) { failures.push(`${shot}: no line under the heading (${id})`); continue; }
                if (k.wayBackContrast < 4.5) failures.push(`${shot}: the line under the heading is too faint (${id}, ${k.wayBackContrast}:1, under 4.5:1)`);
                if (noWords && !/aren't saved in this browser/.test(k.wayBackText)) failures.push(`${shot}: without the words, "${k.wayBackText}" (${id})`);
                if (noWords && /as your 12 words do|are the way back to this account/.test(k.wayBackText)) failures.push(`${shot}: promises words this browser hasn't got: "${k.wayBackText}" (${id})`);
            }
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            for (const o of m.overflow) failures.push(`${shot}: ${o}`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            const one = m.cases['case-one'];
            console.log(`${shot}: sentence ${one.lines} lines at ${one.fontPx}px, contrast ${one.contrast}:1, `
                + `line above ${one.wayBackContrast}:1 (without the words ${m.cases['case-one-nowords'].wayBackContrast}:1), `
                + `${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
            await context.close();
        }
    }

    // The whole Account & Identity section of the real Settings page, and the words screen, with the words and without.
    const SETTINGS_CASES = [
        { name: 'words-connected', words: true, enrolled: ['google'] },
        { name: 'nowords-connected', words: false, enrolled: ['google'] },
        { name: 'nowords-not-connected', words: false, enrolled: [] },
    ];
    for (const theme of ['light', 'dark']) {
        for (const sc of SETTINGS_CASES) {
            for (const screenName of ['section', 'words-screen']) {
                const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const url = route.request().url();
                    if (url.includes('/api/recovery/shares/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enrolledSso: sc.enrolled }) });
                    if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                    return route.continue();
                });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                const query = `words=${sc.words ? 1 : 0}${screenName === 'words-screen' ? '&mode=seed' : ''}`;
                await page.goto(`${base}/e2e/settings-recovery-harness.html?${query}`, { waitUntil: 'networkidle' });
                await page.evaluate((t) => {
                    document.documentElement.classList.toggle('dark', t === 'dark');
                    document.documentElement.classList.toggle('dark-theme', t === 'dark');
                    document.documentElement.style.fontSize = '130%';
                }, theme);
                const shot = `settings-recovery-${sc.name}-${screenName}-${theme}.png`;
                if (screenName === 'section') {
                    await page.waitForSelector('[data-testid="signin-recovery"]');
                    await page.evaluate(() => document.fonts.ready);
                    // The section: its heading and everything under it (SettingsPage's "ACCOUNT & IDENTITY" block).
                    const section = page.getByText('ACCOUNT & IDENTITY', { exact: true }).locator('xpath=..');
                    await section.screenshot({ path: path.join(OUT_DIR, shot) });
                } else {
                    await page.waitForSelector('text=Recovery Phrase');
                    await page.evaluate(() => document.fonts.ready);
                    await page.waitForTimeout(200);
                    await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: true });
                }
                const m = await page.evaluate(() => {
                    const vw = document.documentElement.clientWidth;
                    const out = [];
                    for (const el of document.querySelectorAll('#root *')) {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 && r.height === 0) continue;
                        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
                    }
                    const text = document.getElementById('root').textContent;
                    return {
                        overflow: out,
                        pageScrollsSideways: document.documentElement.scrollWidth > vw,
                        banner: /You haven't saved your recovery phrase yet/.test(text),
                        rowNotHere: /View Recovery PhraseNot saved in this browser/.test(text),
                        rowSeed: /View your 12-word backup seed/.test(text),
                        wayBack: document.querySelector('[data-testid="signin-recovery-way-back"]')?.textContent ?? null,
                        notHere: document.querySelector('[data-testid="seed-not-here"]')?.textContent ?? null,
                        writeThemDown: /Write these words on paper/.test(text),
                        wordsShown: /abandon/.test(text),
                        oldPromise: /generated without seed phrase storage/.test(text),
                    };
                });
                if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
                for (const o of m.overflow) failures.push(`${shot}: ${o}`);
                if (screenName === 'section') {
                    if (m.banner !== sc.words) failures.push(`${shot}: the "save your recovery phrase" banner is ${m.banner ? 'there' : 'missing'}`);
                    if (sc.words ? !m.rowSeed : !m.rowNotHere) failures.push(`${shot}: View Recovery Phrase reads wrong for ${sc.words ? 'a browser with the words' : 'one without'}`);
                    if (!sc.words && !/aren't saved in this browser/.test(m.wayBack ?? '')) failures.push(`${shot}: the sign-in line reads "${m.wayBack}"`);
                } else if (sc.words) {
                    if (!m.wordsShown || !m.writeThemDown || m.notHere) failures.push(`${shot}: the words screen with the words reads wrong`);
                } else {
                    if (!m.notHere || m.wordsShown || m.writeThemDown || m.oldPromise) failures.push(`${shot}: the words screen without the words reads wrong: ${JSON.stringify(m)}`);
                }
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${shot}: banner ${m.banner}, row ${m.rowNotHere ? '"Not saved in this browser"' : m.rowSeed ? '"View your 12-word backup seed"' : '-'}, `
                    + `line ${JSON.stringify(m.wayBack)}${m.notHere ? `, words screen ${JSON.stringify(m.notHere)}` : ''}, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`(${blocked} /api or /ws requests aborted at the browser)`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ the sentence is under both connected sign-ins, whole and wrapped; both lines read at 4.5:1; a browser without its 12 words is never told they are here; nothing reaches past the viewport');
