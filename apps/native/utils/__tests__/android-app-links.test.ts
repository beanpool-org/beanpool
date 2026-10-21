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
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

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
    'bindarrabi.beanpool.org', 'yarravalley.beanpool.org', 'global.beanpool.org',
];

/** The hosts Android checks for an assetlinks.json at install (autoVerify), as written in app.json. */
const verifiedHosts = (): string[] => filters.filter(f => f.autoVerify).flatMap(f => (f.data as DataEl[]).map(d => d.host!));
/** Every host any filter names, verified or not. */
const allHosts = (): string[] => filters.flatMap(f => (f.data as DataEl[]).map(d => d.host!));
const claimedVerified = (url: string) => filters.some(f => f.autoVerify && filterClaims(f, url));

describe('Android app links: invites still open the app', () => {
    it.each(NODE_HOSTS)('%s/?invite=… (every generator’s format: native share + QR, PWA, manager, trampoline)', host => {
        expect(claimed(`https://${host}/?invite=INV-ABCD-EFGH`)).toBe(true);
        expect(claimed(`https://${host}/?invite=BP-ABCD-1234`)).toBe(true);
    });

    it('a node that is not in any list (the wildcard filter)', () => {
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

// No community is named (21 Oct 2026). The app used to list each node's host in a verified filter, and the wildcard
// filter was unverified. A paused node (yarravalley) lost its DNS and failed Play's domain check; on Android 11 and older
// (this app runs from Android 8) one failing host turns verification off for EVERY host the app names, so every node's
// invites went to the app picker on old phones. Communities can also live on any domain (no domain lock-in), which the app
// can never list. So the app names only beanpool.org and *.beanpool.org; Android verifies the wildcard against beanpool.org's
// /.well-known/assetlinks.json, and every node also serves its own. A community on its own domain opens in the browser,
// and the app joins it by invite code or QR.
describe('Android app links: every community under beanpool.org is verified through the wildcard', () => {
    it('no filter names a single community host: only beanpool.org and *.beanpool.org', () => {
        expect([...new Set(allHosts())].sort()).toEqual(['*.beanpool.org', 'beanpool.org']);
    });
    it.each([...NODE_HOSTS, 'newtown.beanpool.org'])('%s invites and shared events reach the app through a verified filter', host => {
        expect(claimedVerified(`https://${host}/?invite=INV-ABCD-EFGH`)).toBe(true);
        expect(claimedVerified(`https://${host}/?post=6f1b0e2c-1111-4a2b-8c3d-000000000001`)).toBe(true);
        expect(claimedVerified(`https://${host}/settings`)).toBe(false);
    });
    it('iOS names the same two, and no single community', () => {
        expect([...appJson.expo.ios.associatedDomains].sort()).toEqual(['applinks:*.beanpool.org', 'applinks:beanpool.org']);
    });
    it('a community on its own domain is not claimed (the app cannot know it at build time)', () => {
        expect(claimed('https://beanpool.example.net/?invite=INV-ABCD-EFGH')).toBe(false);
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

// The global community's smart link (utils/global-link.ts, slice P4): https://beanpool.org/global, which the website's
// global page hands out (apps/website/global.html, #2101). On Android its button is Chrome's intent link naming this app,
// with Google Play as the fallback; the app has to claim the path, verified like /auth/ on the same host
// (beanpool.org/.well-known/assetlinks.json), or the button goes to Google Play even with the app installed.
describe('Android app links: the global community\'s link opens the app', () => {
    it('https://beanpool.org/global is claimed by a verified filter, as the website\'s intent link names it', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../../website/global.html'), 'utf8');
        const intent = /'intent:\/\/([^#']+)#Intent;scheme=(https);package=org\.beanpool\.pillar;/.exec(html);
        expect(intent).not.toBeNull();
        const url = `${intent![2]}://${intent![1]}`;
        expect(url).toBe('https://beanpool.org/global');
        expect(claimedVerified(url)).toBe(true);
        expect(claimedVerified('https://beanpool.org/global?utm_source=x')).toBe(true);
        expect(claimedVerified('https://beanpool.org/global/')).toBe(true);
    });

    it('every path the filter claims on beanpool.org is one the router opens the door for: none lands on Unmatched Route', async () => {
        const { isGlobalLink } = await import('../global-link');
        for (const url of ['https://beanpool.org/global', 'https://beanpool.org/global/', 'https://beanpool.org/global.html',
            'https://beanpool.org/globalx', 'https://beanpool.org/global/more']) {
            expect(claimed(url), url).toBe(true);
            expect(isGlobalLink(url), url).toBe(true);
        }
    });

    it('it widens nothing else: the website\'s other pages and the root still open in the browser', () => {
        for (const url of ['https://beanpool.org/', 'https://beanpool.org/help.html', 'https://beanpool.org/getting-started.html',
            'https://beanpool.org/glob', 'https://beanpool.org/Global', 'https://www.beanpool.org/global']) {
            expect(claimedVerified(url), url).toBe(false);
        }
        // A community's own host keeps its "/" rule only.
        expect(claimed('https://mullum.beanpool.org/global')).toBe(false);
        expect(claimed('https://global.beanpool.org/global')).toBe(false);
    });

    it('iOS: beanpool.org is an associated domain already (the site\'s association file lists /global), the invite and /auth/ paths unchanged', () => {
        expect(appJson.expo.ios.associatedDomains).toContain('applinks:beanpool.org');
        const aasa = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../website/.well-known/apple-app-site-association'), 'utf8'));
        const paths = aasa.applinks.details.flatMap((d: { components: Array<{ '/': string }> }) => d.components.map((c) => c['/']));
        expect(paths).toContain('/global');
        expect(claimed('https://beanpool.org/auth/google?code=x')).toBe(true);
    });
});
