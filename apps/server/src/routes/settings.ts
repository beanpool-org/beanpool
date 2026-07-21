/**
 * Settings, Deep Links, Root Redirect, Version, Node Config routes.
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';
import {
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    getNodeRole, getMemberStats,
} from '../state-engine.js';
import {
    getLocalConfig, saveLocalConfig, verifyPassword,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS,
} from '../local-config.js';
import { initDirectoryPublisher, pushDirectoryNow } from '../directory-publisher.js';
import type { RouteDeps } from './types.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve('public');

export function createSettingsRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

// ===================== UNIVERSAL DEEP LINKS (AASA / ASSETLINKS) =====================
// Apple App Site Association
router.get('/.well-known/apple-app-site-association', async (ctx) => {
    // IMPORTANT: Set APPLE_TEAM_ID in your .env to the 10-character Team ID of the new Apple Developer Account.
    // Failing to do so will break Universal Links (deep linking) for the iOS app.
    const teamId = process.env.APPLE_TEAM_ID || '485XM2R33S'; // Fallback to original Assignor Team ID
    const bundleId = 'org.beanpool.pillar';

    ctx.type = 'application/json';
    ctx.body = {
        applinks: {
            details: [
                {
                    appIDs: [`${teamId}.${bundleId}`],
                    components: [
                        {
                            "/": "/",
                            "?": { "invite": "*" },
                            "comment": "Match invite links with query parameters"
                        },
                        {
                            "/": "/app*",
                            "comment": "Match legacy app paths"
                        }
                    ]
                }
            ]
        }
    };
});

// Android App Links
router.get('/.well-known/assetlinks.json', async (ctx) => {
    // Fallback to the known SHA256 of org.beanpool.pillar if env is missing
    const sha256 = process.env.ANDROID_CERT_SHA256 || 'FA:55:52:D6:8C:4A:D6:19:2F:AD:A6:A7:78:39:B4:E8:4D:50:FE:E9:FD:6C:C5:DF:6B:0F:51:E7:CB:DC:03:2B';
    const packageName = 'org.beanpool.pillar';

    ctx.type = 'application/json';
    ctx.body = [
        {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
                namespace: "android_app",
                package_name: packageName,
                sha256_cert_fingerprints: [sha256]
            }
        }
    ];
});

// ===================== SETTINGS PAGE =====================

router.get('/settings', async (ctx) => {
    const publicPath = path.join(__dirname, '../public/settings.html');
    const staticPath = path.join(__dirname, '../static/settings.html');
    const resolvedPath = fs.existsSync(publicPath) ? publicPath : staticPath;

    if (fs.existsSync(resolvedPath)) {
        ctx.type = 'html';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = fs.createReadStream(resolvedPath);
    } else {
        ctx.status = 404;
        ctx.body = 'Settings page not found. Ensure settings.html is in the public directory.';
    }
});

router.get('/settings.js', async (ctx) => {
    const publicPath = path.join(__dirname, '../public/settings.js');
    const staticPath = path.join(__dirname, '../static/settings.js');
    const resolvedPath = fs.existsSync(publicPath) ? publicPath : staticPath;

    if (fs.existsSync(resolvedPath)) {
        ctx.type = 'application/javascript';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = fs.createReadStream(resolvedPath);
    } else {
        ctx.status = 404;
        ctx.body = '// settings.js not found';
    }
});


// ===================== ROOT REDIRECT =====================
// Redirect root to the PWA app — existing users auto-login via IndexedDB identity
// Preserve query params (e.g. ?invite=BP-XXXX-XXXX) for invite URL flow
router.get('/', async (ctx) => {
    const query = ctx.querystring ? `?${ctx.querystring}` : '';
    ctx.redirect(`/app${query}`);
});

// ===================== NODE CONFIG =====================

router.get('/api/node/config', async (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = getNodeConfig();
});

router.post('/api/local/admin/node/config', async (ctx) => {
    console.log("updateNodeConfig hit!", (ctx as any).requestBody);
    if (!(await checkAdminAuth(ctx as any))) {
        console.log("Auth failed for updateNodeConfig");
        return;
    }
    const { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours } = (ctx as any).requestBody || {};
    console.log("Updating node config:", { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
    ctx.body = updateNodeConfig({ publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
    
    // Re-initialize the publisher with the new interval
    if (directoryPushIntervalHours !== undefined) {
        initDirectoryPublisher();
    }
});

router.post('/api/local/admin/directory/push', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) {
        ctx.status = 401;
        return;
    }
    ctx.body = await pushDirectoryNow();
});

// Local directory info endpoint (used by settings preview)
// No CORS headers - should only be called from same origin (admin PWA)
router.get('/api/directory/info', async (ctx) => {
    const info = getDirectoryInfo();
    if (!info) {
        ctx.status = 403;
        ctx.body = { error: 'This node has opted out of the directory' };
        return;
    }
    ctx.body = info;
});


// ===================== VERSION & UPDATES =====================

// Read version from root package.json
function getVersion(): string {
    // Priority: APP_VERSION env (from Docker build arg) > .version file > package.json
    if (process.env.APP_VERSION) return process.env.APP_VERSION;
    try {
        const versionFile = path.resolve('/app/.version');
        if (fs.existsSync(versionFile)) {
            return fs.readFileSync(versionFile, 'utf-8').trim();
        }
    } catch { /* fall through */ }
    try {
        let pkgPath = path.resolve('package.json');
        if (!fs.existsSync(pkgPath)) {
            pkgPath = path.resolve('../../package.json');
        }
        const rootPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return rootPkg.version || '0.0.0';
    } catch { return '0.0.0'; }
}

// Get git commit hash
function getCommitHash(): string {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { return 'unknown'; }
}

// ===================== BACKGROUND UPDATE CHECKER =====================
let cachedUpdateInfo: {
    updateAvailable: boolean;
    latestVersion: string;
    releaseNotes: string;
    releaseUrl: string;
    publishedAt: string;
    lastChecked: string;
} | null = null;

async function backgroundUpdateCheck() {
    try {
        const response = await fetch(
            'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
        );
        if (response.ok) {
            const release = await response.json() as any;
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const currentVersion = getVersion();
            cachedUpdateInfo = {
                updateAvailable: semverGreater(latestVersion, currentVersion),
                latestVersion,
                releaseNotes: release.body || '',
                releaseUrl: release.html_url || '',
                publishedAt: release.published_at || '',
                lastChecked: new Date().toISOString(),
            };
        } else {
            // Fallback to tags
            const tagsResponse = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (tagsResponse.ok) {
                const tags = await tagsResponse.json() as any[];
                const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                const currentVersion = getVersion();
                cachedUpdateInfo = {
                    updateAvailable: semverGreater(latestTag, currentVersion),
                    latestVersion: latestTag,
                    releaseNotes: '',
                    releaseUrl: '',
                    publishedAt: '',
                    lastChecked: new Date().toISOString(),
                };
            }
        }
        if (cachedUpdateInfo?.updateAvailable) {
            console.log(`[Update] New version available: v${cachedUpdateInfo.latestVersion} (current: v${getVersion()})`);
        }
    } catch (e: any) {
        console.log(`[Update] Background check failed: ${e.message || 'unknown error'}`);
    }
}

// Run initial check after 30s startup delay, then every 6 hours
setTimeout(() => backgroundUpdateCheck(), 30000);
setInterval(() => backgroundUpdateCheck(), 6 * 60 * 60 * 1000);

router.get('/api/version', (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = {
        version: getVersion(),
        commit: getCommitHash(),
        buildTime: new Date().toISOString(),
        node: process.env.CF_RECORD_NAME || 'local',
        // Include cached update info if available
        ...(cachedUpdateInfo ? {
            updateAvailable: cachedUpdateInfo.updateAvailable,
            latestVersion: cachedUpdateInfo.latestVersion,
            lastUpdateCheck: cachedUpdateInfo.lastChecked,
        } : {}),
    };
});

// ===================== THRESHOLDS API =====================

router.post('/api/admin/thresholds', async (ctx) => {
    const config = getLocalConfig();
    const { password, ...updates } = (ctx as any).requestBody || {};
    if (!password || !config.adminHash || !config.salt ||
        !verifyPassword(password, config.adminHash, config.salt)) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid password' };
        return;
    }
    // Only allow known threshold keys
    const allowed = Object.keys(DEFAULT_THRESHOLDS);
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k) && typeof v === 'number') {
            filtered[k] = v;
        }
    }
    const result = updateThresholds(filtered);
    ctx.body = { thresholds: result };
});

router.post('/api/admin/thresholds/get', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { thresholds: getThresholds(), defaults: DEFAULT_THRESHOLDS };
});

function semverGreater(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

router.post('/api/admin/check-update', async (ctx) => {
    const config = getLocalConfig();
    const { password } = (ctx as any).requestBody || {};
    if (!password || !config.adminHash || !config.salt ||
        !verifyPassword(password, config.adminHash, config.salt)) {
        ctx.status = 401;
        ctx.body = { error: 'Invalid password' };
        return;
    }
    try {
        const response = await fetch(
            'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
        );
        if (response.ok) {
            const release = await response.json() as any;
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const currentVersion = getVersion();
            const isNewer = semverGreater(latestVersion, currentVersion);
            ctx.body = {
                currentVersion,
                latestVersion,
                updateAvailable: isNewer,
                releaseUrl: release.html_url || '',
                releaseNotes: release.body || '',
                publishedAt: release.published_at || '',
            };
        } else {
            // No releases yet — check tags instead
            const tagsResponse = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (tagsResponse.ok) {
                const tags = await tagsResponse.json() as any[];
                const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                const currentVersion = getVersion();
                ctx.body = {
                    currentVersion,
                    latestVersion: latestTag,
                    updateAvailable: semverGreater(latestTag, currentVersion),
                    releaseUrl: '',
                    releaseNotes: '',
                    publishedAt: '',
                };
            } else {
                ctx.body = {
                    currentVersion: getVersion(),
                    latestVersion: '',
                    updateAvailable: false,
                    error: 'Could not reach GitHub',
                };
            }
        }
    } catch (e: any) {
        ctx.body = {
            currentVersion: getVersion(),
            latestVersion: '',
            updateAvailable: false,
            error: e.message || 'Failed to check',
        };
    }
});

// NOTE: /api/admin/update (signal-file approach) has been removed.
// Updates are notification-only — admin runs `docker compose pull && docker compose up -d` manually.

// ===================== MIDDLEWARE =====================

// Serve PWA at /app
router.get('/app', async (ctx) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
        ctx.type = 'html';
        ctx.body = fs.createReadStream(indexPath);
    }
});

    return router;
}
