/**
 * Which https URLs the Android app claims (app.json → AndroidManifest intent filters).
 *
 * The bug this pins: every filter used to claim EVERY path on beanpool.org and the node hosts, so the
 * node's /settings, the public website, and even a link to https://beanpool.org from inside the app
 * opened the app instead of the browser.
 *
 * Android merges every <data> element of one intent-filter: the filter matches any of its schemes ×
 * any of its hosts × any of its paths, and a filter with no path attribute at all matches every path.
 * The matcher below applies exactly that, so a path added to one host silently widening another
 * shows up here. Android ignores the query string, so `/?invite=` can only be claimed as path "/".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildSettingsHandoffUrl } from '../node-admin';

// No mocks needed for buildSettingsHandoffUrl, but its module imports these.
import { vi } from 'vitest';
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 } }));
vi.mock('../crypto', () => ({}));

const appJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../app.json'), 'utf8'));
const filters: any[] = appJson.expo.android.intentFilters;

interface DataEl { scheme?: string; host?: string; path?: string; pathPrefix?: string; pathPattern?: string }

function hostMatches(pattern: string, host: string): boolean {
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
    return pattern === host;
}

/** Android's simple glob for pathPattern: `.*` and `.` only, anchored. */
function patternMatches(pattern: string, p: string): boolean {
    const re = '^' + pattern.replace(/[\\^$+?()[\]{}|/]/g, '\\$&').replace(/\.\*/g, '§WILDCARD§').replace(/\./g, '.').replace(/§WILDCARD§/g, '.*') + '$';
    return new RegExp(re).test(p);
}

function filterClaims(filter: any, url: string): boolean {
    const u = new URL(url);
    const data: DataEl[] = filter.data || [];
    const schemes = data.map(d => d.scheme).filter(Boolean) as string[];
    const hosts = data.map(d => d.host).filter(Boolean) as string[];
    const exact = data.map(d => d.path).filter(p => p !== undefined) as string[];
    const prefixes = data.map(d => d.pathPrefix).filter(p => p !== undefined) as string[];
    const patterns = data.map(d => d.pathPattern).filter(p => p !== undefined) as string[];
    if (!schemes.includes(u.protocol.replace(':', ''))) return false;
    if (!hosts.some(h => hostMatches(h, u.hostname))) return false;
    // Android keeps an empty path empty; WHATWG URL turns it into "/". Use the raw spelling.
    const rawPath = url.replace(/^[a-z]+:\/\/[^/?#]+/i, '').split(/[?#]/)[0];
    const anyPathRule = exact.length + prefixes.length + patterns.length > 0;
    if (!anyPathRule) return true;
    return exact.includes(rawPath) || prefixes.some(p => rawPath.startsWith(p)) || patterns.some(p => patternMatches(p, rawPath));
}

const claimed = (url: string) => filters.some(f => filterClaims(f, url));

const NODE_HOSTS = [
    'mullum.beanpool.org', 'castlemaine.beanpool.org', 'test.beanpool.org', 'bris.beanpool.org',
    'melb.beanpool.org', 'review.beanpool.org', 'gippsland.beanpool.org', 'eastgippy.beanpool.org',
    'bindarrabi.beanpool.org', 'yarravalley.beanpool.org',
];

describe('Android app links: invites still open the app', () => {
    it.each(NODE_HOSTS)('%s/?invite=… (every generator’s format: native share + QR, PWA, manager, trampoline)', host => {
        expect(claimed(`https://${host}/?invite=INV-ABCD-EFGH`)).toBe(true);
        expect(claimed(`https://${host}/?invite=BP-ABCD-1234`)).toBe(true);
    });

    it('a node that is not in the list yet (unverified wildcard filter, as before)', () => {
        expect(claimed('https://newtown.beanpool.org/?invite=INV-ABCD-EFGH')).toBe(true);
    });

    // A shared event uses the same shape as an invite for exactly this reason: Android matches on the PATH
    // and ignores the query, so `/?post=` is claimed wherever `/?invite=` is, and the link a member sends
    // from the event screen opens the app rather than the browser.
    it.each(NODE_HOSTS)('%s/?post=… — a shared event opens the app, like an invite does', host => {
        expect(claimed(`https://${host}/?post=6f1b0e2c-1111-4a2b-8c3d-000000000001`)).toBe(true);
    });

    it('the OAuth return pages on beanpool.org are still claimed (unchanged, flows rely on it)', () => {
        expect(claimed('https://beanpool.org/auth/tiktok?code=x&state=y')).toBe(true);
        expect(claimed('https://beanpool.org/auth/instagram?code=x')).toBe(true);
        expect(claimed('https://beanpool.org/auth/facebook#access_token=x')).toBe(true);
    });

    it('every node host Android verifies is also an iOS associated domain', () => {
        const ios: string[] = appJson.expo.ios.associatedDomains;
        const verified = filters.filter(f => f.autoVerify).flatMap(f => f.data.map((d: DataEl) => d.host));
        for (const h of verified) expect(ios).toContain(`applinks:${h}`);
    });
});

describe('Android app links: everything else goes to the browser', () => {
    it.each(NODE_HOSTS)('%s/settings and its sign-in link are NOT claimed', host => {
        expect(claimed(`https://${host}/settings`)).toBe(false);
        expect(claimed(`https://${host}/settings/`)).toBe(false);
        expect(claimed(`https://${host}/settings?token=abc`)).toBe(false);
        expect(claimed(buildSettingsHandoffUrl(`https://${host}`, 'tok', 'moderation'))).toBe(false);
        expect(claimed(`https://${host}/settings-legacy`)).toBe(false);
    });

    it.each(NODE_HOSTS)('%s web-join and the PWA are NOT claimed', host => {
        expect(claimed(`https://${host}/app?invite=INV-ABCD-EFGH&webjoin=1`)).toBe(false);
        expect(claimed(`https://${host}/app`)).toBe(false);
        expect(claimed(`https://${host}/api/node-admin/me`)).toBe(false);
    });

    it('the public website opens in the browser, including a bare https://beanpool.org link from inside the app', () => {
        for (const url of [
            'https://beanpool.org',
            'https://beanpool.org/',
            'https://beanpool.org/?invite=INV-ABCD-EFGH',
            'https://beanpool.org/privacy.html',
            'https://beanpool.org/terms.html',
            'https://beanpool.org/safety.html',
            'https://beanpool.org/terms',
            'https://beanpool.org/i/INV-ABCD-EFGH',
            // www.beanpool.org is not used anywhere; its root would fall under the unverified *.beanpool.org
            // "/" filter, which Android 12+ leaves to the browser and older Android offers as a choice.
            'https://www.beanpool.org/about',
        ]) {
            expect(claimed(url), url).toBe(false);
        }
    });

    it('no filter is left without a path rule (the original bug)', () => {
        for (const f of filters) {
            const data: DataEl[] = f.data || [];
            const hasPathRule = data.some(d => d.path !== undefined || d.pathPrefix !== undefined || d.pathPattern !== undefined);
            expect(hasPathRule, JSON.stringify(f.data)).toBe(true);
            // …and every <data> in a filter carries one, so merging cannot widen a host that has none.
            for (const d of data) {
                expect(d.path !== undefined || d.pathPrefix !== undefined || d.pathPattern !== undefined, JSON.stringify(d)).toBe(true);
            }
        }
    });

    it('beanpool.org is in its own filter, so node paths are never applied to the website', () => {
        for (const f of filters) {
            const hosts = (f.data as DataEl[]).map(d => d.host);
            if (hosts.includes('beanpool.org')) expect(hosts.every(h => h === 'beanpool.org')).toBe(true);
        }
    });
});
