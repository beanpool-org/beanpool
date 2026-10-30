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
 * Connected at global.beanpool.org, with the lines on putting the same account on a phone (W1): both lines, whole,
 * inside the card, at 4.5:1 or more.
 *
 * "Where your account can be brought back from" (vault rethink VR1) on the real Settings page: opened, and with the
 * confirm of removing the server's last copy, with the words and without, light and dark (see WAYS_CASES below). With the
 * copy a community keeps for its admins (VR3), and the section that turns it on (ADMINS_CASES).
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
        const where = box?.querySelector('[data-testid="signin-recovery-where"]');
        const wayBackOf = {
            ...(wayBack ? { wayBackText: wayBack.textContent, wayBackContrast: onCard(wayBack) } : { wayBackText: null, wayBackContrast: 0 }),
            ...(where ? { whereText: where.textContent, whereContrast: onCard(where) } : { whereText: null, whereContrast: 0 }),
        };
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
    // The phone lines (W1), under a connected sign-in at global.beanpool.org.
    const phoneCard = document.querySelector('[data-testid="case-phone"] [data-testid="signin-recovery"]');
    const phoneLines = phoneCard?.querySelector('[data-testid="signin-recovery-phone-later"]');
    let phone = null;
    if (phoneCard && phoneLines) {
        const pr = phoneLines.getBoundingClientRect();
        const cr = phoneCard.getBoundingClientRect();
        const fg = lum(rgb(getComputedStyle(phoneLines).color));
        const bg = lum(rgb(getComputedStyle(phoneCard).backgroundColor));
        phone = {
            lines: phoneLines.querySelectorAll('p').length,
            text: phoneLines.textContent,
            insideCard: pr.left >= cr.left - 0.5 && pr.right <= cr.right + 0.5 && pr.bottom <= cr.bottom + 0.5,
            clipped: phoneLines.scrollHeight > phoneLines.clientHeight + 1 || phoneLines.scrollWidth > phoneLines.clientWidth + 1,
            contrast: Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100,
        };
    }
    return { overflow: out, pageScrollsSideways: document.documentElement.scrollWidth > vw, cases, phone };
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
                // Where the copy is (vault rethink VR0): this community's server keeps it, or none; never the key vault.
                const connected = !id.startsWith('case-none');
                if (!k.whereText) { failures.push(`${shot}: no line saying where the copy is (${id})`); continue; }
                if (!(connected ? /server keeps the copy of your account/ : /server keeps no copy of your account/).test(k.whereText)) failures.push(`${shot}: where the copy is reads "${k.whereText}" (${id})`);
                if (/key vault|Iceland/.test(k.whereText)) failures.push(`${shot}: the web app names the key vault (${id})`);
                if (k.whereContrast < 4.5) failures.push(`${shot}: the line on where the copy is is too faint (${id}, ${k.whereContrast}:1, under 4.5:1)`);
            }
            if (!m.phone) failures.push(`${shot}: no lines on putting the account on a phone (case-phone)`);
            else {
                if (m.phone.lines !== 2 || !/choose Global community/.test(m.phone.text) || !/Recover with Social/.test(m.phone.text)) {
                    failures.push(`${shot}: the phone lines read "${m.phone.text}" (${m.phone.lines})`);
                }
                if (!m.phone.insideCard) failures.push(`${shot}: the phone lines reach outside their card`);
                if (m.phone.clipped) failures.push(`${shot}: the phone lines are cut off`);
                if (m.phone.contrast < 4.5) failures.push(`${shot}: the phone lines are too faint (${m.phone.contrast}:1, under 4.5:1)`);
            }
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            for (const o of m.overflow) failures.push(`${shot}: ${o}`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            const one = m.cases['case-one'];
            console.log(`${shot}: sentence ${one.lines} lines at ${one.fontPx}px, contrast ${one.contrast}:1, `
                + `line above ${one.wayBackContrast}:1 (without the words ${m.cases['case-one-nowords'].wayBackContrast}:1), `
                + `phone lines ${m.phone?.contrast ?? '-'}:1, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
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
    // "Where your account can be brought back from" (vault rethink VR1): the section opened on the real Settings page, and
    // for a server that keeps a copy the confirm of removing it (its last copy, so the 12 words line is in it), with the
    // words and without, light and dark, at 320px and 1.3x text. Every text in the section at 4.5:1 on what it is drawn
    // on (3:1 from 18.66px bold), every button 44px tall, nothing past the viewport, and the vault named only as managed in
    // the phone app.
    const WAYS_CASES = [
        { name: 'words-google', words: true, enrolled: ['google'] },
        { name: 'nowords-google', words: false, enrolled: ['google'] },
        { name: 'words-none', words: true, enrolled: [] },
    ];
    for (const theme of ['light', 'dark']) {
        for (const wc of WAYS_CASES) {
            const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme });
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/recovery/shares/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enrolledSso: wc.enrolled }) });
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/settings-recovery-harness.html?words=${wc.words ? 1 : 0}`, { waitUntil: 'networkidle' });
            await page.evaluate((t) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = '130%';
            }, theme);
            await page.waitForSelector('[data-testid="signin-recovery"]');
            await page.getByRole('button', { name: /Where your account can be brought back from/ }).click();
            await page.waitForSelector('[data-testid="ways-back"]');
            if (wc.enrolled.length) {
                await page.getByRole('button', { name: "Remove the Google copy at this community's server" }).click();
                await page.waitForSelector('[data-testid="ways-back-confirm"]');
            }
            await page.evaluate(() => document.fonts.ready);
            const shot = `ways-back-${wc.name}-${theme}.png`;
            const section = page.locator('[data-testid="ways-back"]').locator('xpath=..');
            await section.screenshot({ path: path.join(OUT_DIR, shot) });
            const m = await page.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                const out = [];
                const rgba = (s) => { const p = (s.match(/[\d.]+/g) || []).map(Number); return p.length >= 3 ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null; };
                const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
                const backdrop = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const c = rgba(getComputedStyle(e).backgroundColor);
                        if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
                    }
                    let base = { r: 255, g: 255, b: 255, a: 1 };
                    for (const l of layers.reverse()) base = over(l, base);
                    return base;
                };
                const box = document.querySelector('[data-testid="ways-back"]');
                for (const el of document.querySelectorAll('#root *')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 && r.height === 0) continue;
                    if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
                }
                const faint = [];
                for (const el of box.querySelectorAll('*')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    if (/^[\p{Extended_Pictographic}️\s]+$/u.test(el.textContent)) continue;
                    const cs = getComputedStyle(el);
                    const fg = rgba(cs.color);
                    if (!fg) continue;
                    const bg = backdrop(el);
                    const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                    const ratio = (a + 0.05) / (b + 0.05);
                    const size = parseFloat(cs.fontSize);
                    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                    if (ratio < (large ? 3 : 4.5)) faint.push(`"${el.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)}:1`);
                }
                const short = [...box.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height < 43.5).map((b) => b.textContent.trim());
                return {
                    overflow: out,
                    pageScrollsSideways: document.documentElement.scrollWidth > vw,
                    faint,
                    short,
                    vault: box.querySelector('[data-testid="ways-back-vault"]')?.textContent ?? null,
                    text: box.textContent,
                    wordsFirst: box.querySelector('[data-testid="ways-back-words-first"]')?.textContent ?? null,
                };
            });
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            for (const o of m.overflow) failures.push(`${shot}: ${o}`);
            for (const f of m.faint) failures.push(`${shot}: too faint to read: ${f}`);
            for (const s of m.short) failures.push(`${shot}: the button "${s}" is under 44px tall`);
            if (m.vault !== "Copies in BeanPool's key vault are managed in the phone app.") failures.push(`${shot}: the vault line reads ${JSON.stringify(m.vault)}`);
            if (/Iceland|since/.test(m.text)) failures.push(`${shot}: the web app says more of the key vault than that it is managed in the phone app`);
            if (wc.enrolled.length && !m.wordsFirst) failures.push(`${shot}: removing the server's last copy doesn't ask about the 12 words first`);
            if (wc.enrolled.length && !wc.words && !/This browser has no 12 words/.test(m.wordsFirst ?? '')) failures.push(`${shot}: without the words, the line reads ${JSON.stringify(m.wordsFirst)}`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            console.log(`${shot}: ${m.faint.length} faint, ${m.short.length} short buttons, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
            await context.close();
        }
    }

    // "Your community's admins" (vault rethink VR3) at a community that keeps copies itself (`recoveryCopies: server`):
    // the Ways back list with the copy its admins can bring the member back from (alone, then the confirm of removing it,
    // the last copy, so the 12 words line is in it; and beside a sign-in's copy), and the section that turns it on (off,
    // and on since a date). Both boxes: every text at 4.5:1 on what it is drawn on, every button 44px, nothing past the
    // viewport; the list never says "Keeps no copy" while the copy is kept.
    const SINCE = '2026-10-29T04:05:06.000Z';
    const ADMINS_CASES = [
        { name: 'admins-only-confirm', enrolled: [], kept: true, confirm: true },
        { name: 'admins-and-google', enrolled: ['google'], kept: true, confirm: false },
        { name: 'admins-off', enrolled: [], kept: false, confirm: false },
    ];
    for (const theme of ['light', 'dark']) {
        for (const ac of ADMINS_CASES) {
            const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme });
            await context.route('**/*', (route) => {
                const url = route.request().url();
                const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                if (url.includes('/api/recovery/shares/status')) return json({ enrolledSso: ac.enrolled, communityCopy: ac.kept ? { since: SINCE } : null });
                if (url.includes('/api/recovery/community-copy/status')) return json({ kept: ac.kept, since: ac.kept ? SINCE : null, offered: true });
                if (url.includes('/api/community/info')) return json({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', recoveryCopies: 'server' });
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/settings-recovery-harness.html?words=1`, { waitUntil: 'networkidle' });
            await page.evaluate((t) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = '130%';
            }, theme);
            await page.waitForSelector('[data-testid="community-admins-section"]');
            if (ac.kept) await page.waitForSelector('[data-testid="community-admins-on"]');
            await page.getByRole('button', { name: /Where your account can be brought back from/ }).click();
            await page.waitForSelector('[data-testid="ways-back"]');
            if (ac.confirm) {
                await page.getByRole('button', { name: "Remove the copy at this community's server that its admins can bring you back from" }).click();
                await page.waitForSelector('[data-testid="ways-back-confirm"]');
            }
            await page.evaluate(() => document.fonts.ready);
            const shot = `community-admins-${ac.name}-${theme}.png`;
            await page.locator('[data-testid="ways-back"]').locator('xpath=..').screenshot({ path: path.join(OUT_DIR, shot) });
            await page.locator('[data-testid="community-admins-section"]').screenshot({ path: path.join(OUT_DIR, shot.replace('community-admins-', 'community-admins-section-')) });
            const m = await page.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                const out = [];
                const rgba = (s) => { const p = (s.match(/[\d.]+/g) || []).map(Number); return p.length >= 3 ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null; };
                const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
                const backdrop = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const c = rgba(getComputedStyle(e).backgroundColor);
                        if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
                    }
                    let base = { r: 255, g: 255, b: 255, a: 1 };
                    for (const l of layers.reverse()) base = over(l, base);
                    return base;
                };
                for (const el of document.querySelectorAll('#root *')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 && r.height === 0) continue;
                    if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
                }
                const boxes = [document.querySelector('[data-testid="ways-back"]'), document.querySelector('[data-testid="community-admins-section"]')];
                const faint = [];
                const short = [];
                for (const box of boxes) {
                    for (const el of box.querySelectorAll('*')) {
                        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                        if (/^[\p{Extended_Pictographic}\uFE0F\s]+$/u.test(el.textContent)) continue;
                        const cs = getComputedStyle(el);
                        const fg = rgba(cs.color);
                        if (!fg) continue;
                        const bg = backdrop(el);
                        const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                        const ratio = (a + 0.05) / (b + 0.05);
                        const size = parseFloat(cs.fontSize);
                        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
                        if (ratio < (large ? 3 : 4.5)) faint.push(`"${el.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)}:1`);
                    }
                    for (const b of box.querySelectorAll('button')) if (b.getBoundingClientRect().height < 43.5) short.push(b.textContent.trim());
                }
                const list = boxes[0];
                return {
                    overflow: out,
                    pageScrollsSideways: document.documentElement.scrollWidth > vw,
                    faint,
                    short,
                    listed: !!list.querySelector('[data-testid="ways-back-admins-copy"]'),
                    keepsNone: /Keeps no copy of your account/.test(list.textContent),
                    wordsFirst: list.querySelector('[data-testid="ways-back-words-first"]')?.textContent ?? null,
                };
            });
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            for (const o of m.overflow) failures.push(`${shot}: ${o}`);
            for (const f of m.faint) failures.push(`${shot}: too faint to read: ${f}`);
            for (const sh of m.short) failures.push(`${shot}: the button "${sh}" is under 44px tall`);
            if (m.listed !== ac.kept) failures.push(`${shot}: the copy for the admins is ${m.listed ? '' : 'not '}listed`);
            if (ac.kept && m.keepsNone) failures.push(`${shot}: "Keeps no copy" while the server keeps one`);
            if (ac.confirm && !m.wordsFirst) failures.push(`${shot}: removing the last copy doesn't ask about the 12 words first`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            console.log(`${shot}: listed ${m.listed}, ${m.faint.length} faint, ${m.short.length} short buttons, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
            await context.close();
        }
    }

    // Where members' copies go (vault rethink VR2): at a community that keeps no copies (its info says `recoveryCopies:
    // none`), Settings' sign-in line says so where it says where the copy is, with none kept here and with one kept from
    // before. The line whole, inside the card, at 4.5:1 or more, light and dark, at 320px and 1.3x text.
    const RULE_CASES = [
        { name: 'none-not-connected', enrolled: [], where: "This community keeps no copies of members' accounts: your 12 words are your way back here." },
        { name: 'none-connected', enrolled: ['google'], where: "This community's server keeps the copy of your account that your sign-in opens. This community keeps no new copies now. This one stays until you remove it." },
    ];
    for (const theme of ['light', 'dark']) {
        for (const rc of RULE_CASES) {
            const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme });
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/recovery/shares/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enrolledSso: rc.enrolled }) });
                if (url.includes('/api/community/info')) {
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', recoveryCopies: 'none' }) });
                }
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/settings-recovery-harness.html?words=1`, { waitUntil: 'networkidle' });
            await page.evaluate((t) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = '130%';
            }, theme);
            await page.waitForSelector('[data-testid="signin-recovery-where"]');
            await page.waitForFunction((want) => document.querySelector('[data-testid="signin-recovery-where"]')?.textContent === want, rc.where, { timeout: 5000 }).catch(() => {});
            await page.evaluate(() => document.fonts.ready);
            const shot = `copies-rule-${rc.name}-${theme}.png`;
            await page.locator('[data-testid="signin-recovery"]').screenshot({ path: path.join(OUT_DIR, shot) });
            const m = await page.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                const rgba = (s) => { const p = (s.match(/[\d.]+/g) || []).map(Number); return p.length >= 3 ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null; };
                const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
                const backdrop = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const c = rgba(getComputedStyle(e).backgroundColor);
                        if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
                    }
                    let base = { r: 255, g: 255, b: 255, a: 1 };
                    for (const l of layers.reverse()) base = over(l, base);
                    return base;
                };
                const where = document.querySelector('[data-testid="signin-recovery-where"]');
                const card = document.querySelector('[data-testid="signin-recovery"]');
                const r = where.getBoundingClientRect();
                const c = card.getBoundingClientRect();
                const fg = rgba(getComputedStyle(where).color);
                const bg = backdrop(where);
                const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
                return {
                    text: where.textContent,
                    ratio: (a + 0.05) / (b + 0.05),
                    inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5,
                    clipped: where.scrollWidth > where.clientWidth + 1,
                    pageScrollsSideways: document.documentElement.scrollWidth > vw,
                };
            });
            if (m.text !== rc.where) failures.push(`${shot}: the line reads ${JSON.stringify(m.text)}`);
            if (m.ratio < 4.5) failures.push(`${shot}: the line is ${m.ratio.toFixed(2)}:1`);
            if (!m.inside || m.clipped) failures.push(`${shot}: the line is outside its card or cut`);
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            console.log(`${shot}: ${JSON.stringify(m.text)} at ${m.ratio.toFixed(2)}:1, inside ${m.inside}`);
            await context.close();
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
