/**
 * The store badges on beanpool.org and in the web app are Apple's and Google's OWN files, never a redrawing (both
 * programmes forbid changing a badge in any way). The server's invite page embeds the same two files in
 * apps/server/src/routes/store-badge-art.ts with the SHA-256 of each owner's file (STORE_BADGE_SHA256). These read that
 * constant from the file (not a copy of it) and hold every copy on disk to it:
 *
 *   - the website's two files (apps/website/assets/) and the web app's two (apps/pwa/public/assets/) hash to the constant,
 *     so an edit, a re-save or a re-export of any of them, even a reformat, fails;
 *   - all 25 home pages of the website (the English one, and the generated page of each language) and each language's
 *     source page show the badges as <img> of those files, Apple's first, the same 40 px height, with alt text and with no
 *     inline <svg> or <text> (the home-made imitation this replaced), and every <img> points at a file that exists.
 *
 * The web app's card is checked in UsePhoneAppCard.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const ART = path.join(REPO, 'apps/server/src/routes/store-badge-art.ts');
const WEBSITE = path.join(REPO, 'apps/website');
const WEBSITE_SRC = path.join(REPO, 'apps/website-src/content');
const PWA_ASSETS = path.join(REPO, 'apps/pwa/public/assets');

const FILES = { appStore: 'app-store-badge.svg', googlePlay: 'google-play-badge.svg' } as const;

function recordedHashes(): { appStore: string; googlePlay: string } {
    const text = fs.readFileSync(ART, 'utf8');
    const block = /STORE_BADGE_SHA256\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(text);
    expect(block, 'STORE_BADGE_SHA256 is in store-badge-art.ts').not.toBeNull();
    const pick = (key: string) => {
        const m = new RegExp(`${key}:\\s*'([0-9a-f]{64})'`).exec(block![1]);
        expect(m, `${key} is a SHA-256 in STORE_BADGE_SHA256`).not.toBeNull();
        return m![1];
    };
    return { appStore: pick('appStore'), googlePlay: pick('googlePlay') };
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the store badge files are the owners\' files, unmodified', () => {
    const want = recordedHashes();

    for (const [where, dir] of [['the website', path.join(WEBSITE, 'assets')], ['the web app', PWA_ASSETS]] as const) {
        it(`${where}'s Apple badge is the file recorded in store-badge-art.ts`, () => {
            expect(sha256(path.join(dir, FILES.appStore))).toBe(want.appStore);
        });
        it(`${where}'s Google Play badge is the file recorded in store-badge-art.ts`, () => {
            expect(sha256(path.join(dir, FILES.googlePlay))).toBe(want.googlePlay);
        });
    }

    it('the two recorded hashes are not the same file', () => {
        expect(want.appStore).not.toBe(want.googlePlay);
    });
});

/** Every home page: the English one, each language's generated page and each language's source page. */
function homePages(): Array<{ label: string; file: string; prefix: string }> {
    // `prefix` is how the page reaches apps/website/assets/: a source page is written as if it stood in the website's
    // root (website-build.mjs rewrites its relative paths), a generated language page stands one folder down.
    const pages = [{ label: 'index.html', file: path.join(WEBSITE, 'index.html'), prefix: '' }];
    for (const lang of fs.readdirSync(WEBSITE_SRC).sort()) {
        pages.push({ label: `apps/website-src/content/${lang}/index.html`, file: path.join(WEBSITE_SRC, lang, 'index.html'), prefix: '' });
        pages.push({ label: `apps/website/${lang}/index.html`, file: path.join(WEBSITE, lang, 'index.html'), prefix: '../' });
    }
    return pages;
}

describe('every home page of the website shows the owners\' badges as pictures', () => {
    const pages = homePages();

    it('covers the English page and all 24 languages, source and generated (49 pages)', () => {
        expect(pages).toHaveLength(49);
        for (const p of pages) expect(fs.existsSync(p.file), p.label).toBe(true);
    });

    for (const { label, file, prefix } of pages) {
        it(`${label}: Apple's badge first, then Google's, each an <img> of the owner's file at 40 px`, () => {
            const html = fs.readFileSync(file, 'utf8');
            const links = [...html.matchAll(/<a\b[^>]*class="hero-store-badge"[^>]*>([\s\S]*?)<\/a>/g)];
            expect(links, 'two badge links').toHaveLength(2);

            const [apple, google] = links;
            expect(apple[0]).toContain('href="https://apps.apple.com/');
            expect(google[0]).toContain('href="https://play.google.com/');

            for (const [link, name] of [[apple, FILES.appStore], [google, FILES.googlePlay]] as const) {
                const inner = link[1];
                // The picture is the file, nothing is drawn in the page.
                expect(inner, 'no inline svg').not.toMatch(/<svg\b/i);
                expect(inner, 'no text drawn on the badge').not.toMatch(/<text\b/i);
                const imgs = [...inner.matchAll(/<img\b[^>]*>/g)];
                expect(imgs, 'exactly one picture').toHaveLength(1);
                const img = imgs[0][0];
                const src = /\ssrc="([^"]+)"/.exec(img)?.[1] ?? '';
                // Relative to the page, so a node or a mirror that serves the folder needs nothing of ours.
                expect(src, 'a relative path to the owner\'s file').toBe(`${prefix}assets/${name}`);
                expect(fs.existsSync(path.join(WEBSITE, 'assets', name)), `${src} exists`).toBe(true);
                expect(/\salt="([^"]+)"/.exec(img)?.[1], 'alt text').toBeTruthy();
                expect(img).toMatch(/\sheight="40"/);
                expect(img).toMatch(/\swidth="\d+"/);
            }
            // No request to a store's servers for the picture.
            expect(html).not.toMatch(/<img\b[^>]*\ssrc="https?:\/\/[^"]*(?:apple|google)\.com/i);
        });
    }
});

describe('the website stylesheet draws nothing over the badges', () => {
    const css = fs.readFileSync(path.join(WEBSITE, 'style.css'), 'utf8');
    it('has no rule for an svg inside a badge link, and no hover movement, glow or fade on it', () => {
        expect(css).not.toMatch(/\.hero-store-badge\s+svg/);
        const rules = [...css.matchAll(/\.hero-store-badge[^{]*\{([^}]*)\}/g)].map(m => m[1]).join('\n');
        expect(rules).not.toMatch(/transform|filter|opacity|animation|transition/);
        expect(rules).toMatch(/padding:\s*10px/);
        expect(rules).toMatch(/height:\s*40px/);
    });
});
