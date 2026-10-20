import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_LANGS } from '../src/guide.mjs';

const HEADERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/website/_headers');

/** The path rules of a Cloudflare Pages _headers file: every line that starts with "/". */
function rules(text) {
    return text.split('\n').filter((l) => l.startsWith('/')).map((l) => l.trim());
}

/** Whether a rule matches a path: "*" stands for any run of characters, as Cloudflare Pages reads it. */
function matches(rule, p) {
    const re = new RegExp(`^${rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(p);
}

// Cloudflare joins the values of every rule that matches a path: two rules giving Access-Control-Allow-Origin "*" send
// "*, *", which browsers refuse, so the web app could never read that language's guide (#2266 review, measured).
test('every guide.json the web app fetches matches exactly one _headers rule', () => {
    const all = rules(fs.readFileSync(HEADERS, 'utf8'));
    const paths = ['/guide/guide.json', ...GUIDE_LANGS.filter((l) => l !== 'en').map((l) => `/guide/${l}/guide.json`)];
    assert.ok(paths.length > 2, 'the language list is there');
    for (const p of paths) {
        const hit = all.filter((r) => matches(r, p));
        assert.equal(hit.length, 1, `${p} matches ${hit.length} rules: ${hit.join(', ')}`);
    }
});
