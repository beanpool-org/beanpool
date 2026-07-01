#!/usr/bin/env node
/**
 * BeanPool Network Diagnostic Suite v1.1.0
 *
 * Standalone, zero-dependency diagnostic CLI and local visual Web Dashboard
 * for probing, comparing, and troubleshooting live BeanPool nodes.
 *
 * Usage CLI:
 *   node scripts/bp-diagnose.mjs identity --all-nodes --pubkey HEX
 *   node scripts/bp-diagnose.mjs identity --node URL --callsign NAME
 *   node scripts/bp-diagnose.mjs identity --all-nodes --transfer "beanpool://..." --pin 1234
 *   node scripts/bp-diagnose.mjs mirror URL1 URL2
 *   node scripts/bp-diagnose.mjs mirror --all-nodes
 *   node scripts/bp-diagnose.mjs marketplace --node URL
 *   node scripts/bp-diagnose.mjs network --all-nodes
 *   node scripts/bp-diagnose.mjs auth --node https://localhost:8443
 *
 * Usage Web Dashboard:
 *   node scripts/bp-diagnose.mjs dashboard [--port 3000]
 *
 * All operations are strictly read-only (GET requests + local decryption).
 * Accepts self-signed TLS certificates for dev/test node compatibility.
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ===================== CONSTANTS =====================

const VERSION = '1.1.0';

const DEFAULT_NODES = [
    'https://test.beanpool.org',
    'https://test-mirror.beanpool.org',
    'https://review.beanpool.org',
    'https://mullum1.beanpool.org',
    'https://mullum2.beanpool.org',
];

const TIMEOUT_MS = 8000;
const STALE_DAYS = 90;

// ===================== TERMINAL STYLING =====================

const ESC = '\x1b[';
const C = {
    reset:   `${ESC}0m`,
    bold:    `${ESC}1m`,
    dim:     `${ESC}2m`,
    green:   `${ESC}32m`,
    red:     `${ESC}31m`,
    amber:   `${ESC}33m`,
    cyan:    `${ESC}36m`,
};

const log = {
    ok:   (msg) => console.log(`  ${C.green}✅ ${msg}${C.reset}`),
    warn: (msg) => console.log(`  ${C.amber}⚠️  ${msg}${C.reset}`),
    fail: (msg) => console.log(`  ${C.red}❌ ${C.bold}${msg}${C.reset}`),
    info: (msg) => console.log(`  ${C.cyan}🔍 ${msg}${C.reset}`),
    hint: (msg) => console.log(`  ${C.dim}💡 ${msg}${C.reset}`),
    head: (msg) => console.log(`\n${C.bold}${C.cyan}${msg}${C.reset}`),
    sub:  (msg) => console.log(`  ${C.dim}${msg}${C.reset}`),
    line: (msg) => console.log(`  ${msg || ''}`),
};

// ===================== CLI PARSER =====================

function parseArgs() {
    const raw = process.argv.slice(2);
    const subcommand = raw[0] || null;
    const positionals = [];
    const flags = {};

    for (let i = 1; i < raw.length; i++) {
        if (raw[i].startsWith('--')) {
            const key = raw[i];
            // Next arg is a value if it exists and isn't another flag
            if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
                flags[key] = raw[++i];
            } else {
                flags[key] = true;
            }
        } else {
            positionals.push(raw[i]);
        }
    }

    return { subcommand, positionals, flags };
}

function resolveNodes(flags) {
    if (flags['--nodes']) {
        return flags['--nodes'].split(',').map(u => u.trim());
    }
    return DEFAULT_NODES;
}

// ===================== HTTP UTILITIES =====================

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            agent,
            timeout: TIMEOUT_MS,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'BeanPool-Diagnostic-Suite/1.1.0',
            },
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function getCertExpiry(hostname) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname,
            port: 443,
            method: 'HEAD',
            rejectUnauthorized: false,
            timeout: TIMEOUT_MS,
        }, (res) => {
            const cert = res.socket?.getPeerCertificate?.();
            res.resume();
            resolve(cert?.valid_to ? new Date(cert.valid_to) : null);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// ===================== TABLE FORMATTER =====================

function printTable(headers, rows, widths) {
    let hdr = '   ';
    headers.forEach((h, i) => hdr += h.padEnd(widths[i]));
    log.line(hdr);
    log.line('   ' + '─'.repeat(widths.reduce((a, b) => a + b, 0)));
    for (const row of rows) {
        let line = '   ';
        row.forEach((cell, i) => {
            // Strip ANSI codes for padding calculation
            const stripped = String(cell ?? '—').replace(/\x1b\[[0-9;]*m/g, '');
            const padded = String(cell ?? '—') + ' '.repeat(Math.max(0, widths[i] - stripped.length));
            line += padded;
        });
        log.line(line);
    }
}

// ===================== TRANSFER CODE DECRYPTOR =====================

function decryptTransferCode(uri, pin) {
    // Extract the base64 payload
    let b64;
    const httpsMatch = uri.match(/[?&]import=(.+?)(?:&|$)/);
    const legacyMatch = uri.match(/beanpool:\/\/import\?d=(.+)/);
    if (httpsMatch) {
        b64 = decodeURIComponent(httpsMatch[1]);
    } else if (legacyMatch) {
        b64 = decodeURIComponent(legacyMatch[1]);
    } else {
        throw new Error('Invalid import URI — expected beanpool://import?d=... or ?import=...');
    }

    const combined = Buffer.from(b64, 'base64');

    // Attempt 1: AES-GCM (PWA scheme)
    // Structure: 12-byte IV + ciphertext + 16-byte auth tag
    // Key: PBKDF2(SHA-256, pin, salt, 100000 iters) → 256-bit
    try {
        const iv = combined.slice(0, 12);
        const encryptedWithTag = combined.slice(12);
        // Web Crypto AES-GCM appends the 16-byte auth tag to ciphertext
        const authTag = encryptedWithTag.slice(-16);
        const ciphertext = encryptedWithTag.slice(0, -16);

        const salt = Buffer.from('beanpool-identity-transfer-v1', 'utf8');
        const key = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        const identity = JSON.parse(plaintext.toString('utf8'));
        if (identity.publicKey && identity.privateKey && identity.callsign) {
            return { identity, scheme: 'AES-GCM (PWA)' };
        }
    } catch {
        // AES-GCM failed (InvalidTag or parse error) — fall through to XOR
    }

    // Attempt 2: XOR cipher (Native/expo-crypto scheme)
    // Structure: raw XOR ciphertext (no IV prefix)
    // Key: SHA256('beanpool-v1:' + pin) → SHA256(hash1 + ':beanpool-transfer:' + pin) → 32 bytes
    try {
        const hash1 = crypto.createHash('sha256').update(`beanpool-v1:${pin}`).digest('hex');
        const hash2 = crypto.createHash('sha256').update(`${hash1}:beanpool-transfer:${pin}`).digest('hex');
        const key = Buffer.from(hash2, 'hex');

        const plaintext = Buffer.alloc(combined.length);
        for (let i = 0; i < combined.length; i++) {
            plaintext[i] = combined[i] ^ key[i % key.length];
        }

        const identity = JSON.parse(plaintext.toString('utf8'));
        if (identity.publicKey && identity.privateKey && identity.callsign) {
            return { identity, scheme: 'XOR (Native)' };
        }
    } catch {
        // XOR also failed
    }

    throw new Error('Decryption failed — wrong PIN or corrupted transfer code');
}

// ===================== HELPERS =====================

function daysAgo(dateStr) {
    const d = new Date(dateStr);
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function shortKey(key) {
    if (!key || key.length < 16) return key || '—';
    return `${key.slice(0, 6)}...${key.slice(-6)}`;
}

function hostFromUrl(url) {
    try { return new URL(url).hostname; }
    catch { return url; }
}

function asArray(data) {
    if (Array.isArray(data)) return data;
    return data?.members || data?.posts || data?.data || data?.friends || data?.ratings || [];
}

// ===================== PROGRAMMATIC CORE ENGINE =====================

async function probeIdentityOnNode(nodeUrl, pubkey) {
    const result = {
        node: hostFromUrl(nodeUrl),
        isMember: false,
        callsign: '—',
        balance: '—',
        friends: '—',
        rating: '—',
    };

    try {
        const membership = await fetchJSON(`${nodeUrl}/api/community/membership/${pubkey}`);
        result.isMember = membership.isMember === true;
        if (membership.callsign) result.callsign = membership.callsign;
    } catch {
        result.callsign = '⛔';
        return result;
    }

    if (!result.isMember) return result;

    try {
        const profile = await fetchJSON(`${nodeUrl}/api/profile/${pubkey}`);
        if (profile.callsign) result.callsign = profile.callsign;
    } catch {}

    try {
        const bal = await fetchJSON(`${nodeUrl}/api/ledger/balance/${pubkey}`);
        result.balance = typeof bal.balance === 'number' ? `${bal.balance}B` : '—';
    } catch {}

    try {
        const arr = asArray(await fetchJSON(`${nodeUrl}/api/friends/${pubkey}`));
        const guardians = arr.filter(f => f.isGuardian || f.is_guardian);
        result.friends = `${arr.length} (${guardians.length}G)`;
    } catch {}

    try {
        const arr = asArray(await fetchJSON(`${nodeUrl}/api/ratings/${pubkey}`));
        if (arr.length > 0) {
            const avg = (arr.reduce((s, r) => s + (r.stars || 0), 0) / arr.length).toFixed(1);
            result.rating = `${avg}★ (${arr.length})`;
        } else {
            result.rating = 'none';
        }
    } catch {}

    return result;
}

async function runIdentityQuery({ pubkey, callsign, transfer, pin, nodes }) {
    let targetPubkey = pubkey || null;
    let targetCallsign = callsign || null;
    let decryptedInfo = null;

    if (transfer) {
        if (!pin) {
            throw new Error('Transfer code lookup requires a PIN');
        }
        const { identity, scheme } = decryptTransferCode(transfer, pin);
        targetPubkey = identity.publicKey;
        targetCallsign = identity.callsign;
        decryptedInfo = {
            callsign: identity.callsign,
            publicKey: identity.publicKey,
            createdAt: identity.createdAt,
            scheme,
            daysAgo: daysAgo(identity.createdAt)
        };
    }

    if (targetCallsign && !targetPubkey) {
        const results = [];
        for (const nodeUrl of nodes) {
            try {
                const arr = asArray(await fetchJSON(`${nodeUrl}/api/members`));
                const target = targetCallsign.toLowerCase();
                const matched = arr.filter(m =>
                    m.callsign?.toLowerCase().includes(target)
                );
                results.push({
                    node: hostFromUrl(nodeUrl),
                    url: nodeUrl,
                    success: true,
                    matches: matched.map(m => ({
                        callsign: m.callsign,
                        publicKey: m.publicKey,
                        joinedAt: m.joinedAt,
                        homeNodeUrl: m.homeNodeUrl
                    }))
                });
            } catch (err) {
                results.push({
                    node: hostFromUrl(nodeUrl),
                    url: nodeUrl,
                    success: false,
                    error: err.message
                });
            }
        }
        return { mode: 'callsign', results, searchString: targetCallsign };
    }

    if (targetPubkey) {
        const settled = await Promise.allSettled(
            nodes.map(n => probeIdentityOnNode(n, targetPubkey))
        );
        const results = settled.map((r, i) => {
            if (r.status === 'fulfilled') {
                return { ...r.value, url: nodes[i] };
            } else {
                return {
                    node: hostFromUrl(nodes[i]),
                    url: nodes[i],
                    isMember: false,
                    callsign: '⛔',
                    balance: '—',
                    friends: '—',
                    rating: '—',
                    error: r.reason?.message || 'Error'
                };
            }
        });
        return {
            mode: 'pubkey',
            publicKey: targetPubkey,
            callsign: targetCallsign,
            decryptedInfo,
            results
        };
    }

    throw new Error('No lookup criteria provided.');
}

async function runNetworkSweep(nodes) {
    return Promise.all(
        nodes.map(async (nodeUrl) => {
            const host = hostFromUrl(nodeUrl);
            const result = {
                url: nodeUrl,
                host,
                status: '⛔ DOWN',
                rawStatus: 'down',
                version: '—',
                members: '—',
                posts: '—',
                tls: '—',
            };

            try {
                const info = await fetchJSON(`${nodeUrl}/api/community/info`);
                result.status = info.memberCount > 1 ? '🟢 UP' : '🟡 NEW';
                result.rawStatus = info.memberCount > 1 ? 'up' : 'new';
                result.members = String(info.memberCount);
                result.posts = String(info.postCount);
            } catch {
                return result;
            }

            try {
                const ver = await fetchJSON(`${nodeUrl}/api/version`);
                result.version = typeof ver === 'string' ? ver : ver?.version || '?';
            } catch {}

            try {
                const expiry = await getCertExpiry(host);
                if (expiry) {
                    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    const dateStr = expiry.toISOString().slice(0, 10);
                    result.tls = daysLeft < 14 ? `${dateStr} ⚠️` : dateStr;
                    result.tlsDaysLeft = daysLeft;
                }
            } catch {}

            return result;
        })
    );
}

async function runMirrorComparison(nodeA, nodeB) {
    const hostA = hostFromUrl(nodeA);
    const hostB = hostFromUrl(nodeB);

    let pass = 0, warn = 0, fail = 0;
    const checks = {
        version: { status: 'pending', details: '' },
        counts: { status: 'pending', details: [] },
        members: { status: 'pending', details: { totalShared: 0, missingOnA: [], missingOnB: [] } },
        profiles: { status: 'pending', details: { checked: 0, drifts: [] } },
        posts: { status: 'pending', details: { totalShared: 0, missingOnA: [], missingOnB: [], drifts: [] } }
    };

    // 1. Version check
    try {
        const [verA, verB] = await Promise.all([
            fetchJSON(`${nodeA}/api/version`).catch(() => null),
            fetchJSON(`${nodeB}/api/version`).catch(() => null),
        ]);
        const vA = typeof verA === 'string' ? verA : verA?.version || '?';
        const vB = typeof verB === 'string' ? verB : verB?.version || '?';
        if (vA === vB) {
            checks.version = { status: 'ok', details: `Version match: ${vA}`, version: vA };
            pass++;
        } else {
            checks.version = { status: 'warn', details: `Version skew: ${hostA}=${vA}, ${hostB}=${vB}`, versionA: vA, versionB: vB };
            warn++;
        }
    } catch {
        checks.version = { status: 'fail', details: 'Could not compare versions' };
        fail++;
    }

    // 2. Community info counts
    try {
        const [infoA, infoB] = await Promise.all([
            fetchJSON(`${nodeA}/api/community/info`),
            fetchJSON(`${nodeB}/api/community/info`),
        ]);

        const countDetails = [];
        for (const [label, key] of [['Member', 'memberCount'], ['Post', 'postCount'], ['Transaction', 'transactionCount']]) {
            const a = infoA[key] ?? '?';
            const b = infoB[key] ?? '?';
            if (a === b) {
                countDetails.push({ label, match: true, count: a });
                pass++;
            } else {
                countDetails.push({ label, match: false, countA: a, countB: b, drift: Math.abs(a - b) });
                warn++;
            }
        }
        checks.counts = {
            status: countDetails.every(c => c.match) ? 'ok' : 'warn',
            details: countDetails
        };
    } catch (err) {
        checks.counts = { status: 'fail', error: err.message };
        fail++;
    }

    // 3. Member identity parity & 4. Profile drift
    try {
        const [membersA, membersB] = await Promise.all([
            fetchJSON(`${nodeA}/api/members`).then(asArray),
            fetchJSON(`${nodeB}/api/members`).then(asArray),
        ]);

        const setA = new Set(membersA.map(m => m.publicKey));
        const setB = new Set(membersB.map(m => m.publicKey));

        const missingOnB = membersA.filter(m => !setB.has(m.publicKey)).map(m => ({ callsign: m.callsign || '?', publicKey: m.publicKey }));
        const missingOnA = membersB.filter(m => !setA.has(m.publicKey)).map(m => ({ callsign: m.callsign || '?', publicKey: m.publicKey }));

        if (missingOnA.length === 0 && missingOnB.length === 0) {
            checks.members = { status: 'ok', details: `Member parity: all ${setA.size} identities match`, total: setA.size };
            pass++;
        } else {
            checks.members = {
                status: 'warn',
                details: `${missingOnA.length + missingOnB.length} missing`,
                missingOnA,
                missingOnB
            };
            warn++;
        }

        // Shared member profiles check
        const shared = membersA.filter(m => setB.has(m.publicKey));
        const memberMapB = new Map(membersB.map(m => [m.publicKey, m]));
        const drifts = [];

        for (const a of shared) {
            const b = memberMapB.get(a.publicKey);
            if (!b) continue;
            const issues = [];
            if (a.callsign !== b.callsign) issues.push(`callsign: "${a.callsign}" vs "${b.callsign}"`);
            if (a.status !== b.status) issues.push(`status: "${a.status}" vs "${b.status}"`);
            if ((a.avatarUrl || null) !== (b.avatarUrl || null)) issues.push('avatar differs');
            if (issues.length > 0) {
                drifts.push({ callsign: a.callsign, publicKey: a.publicKey, issues });
            }
        }

        if (drifts.length === 0) {
            checks.profiles = { status: 'ok', details: `Profile consistency: ${shared.length} shared members in sync`, checked: shared.length };
            pass++;
        } else {
            checks.profiles = {
                status: 'warn',
                details: `${drifts.length} member(s) have stale profile data`,
                checked: shared.length,
                drifts
            };
            warn++;
        }

    } catch (err) {
        checks.members = { status: 'fail', error: err.message };
        checks.profiles = { status: 'fail', error: err.message };
        fail += 2;
    }

    // 5. Post parity & 6. Post status drift
    try {
        const [postsA, postsB] = await Promise.all([
            fetchJSON(`${nodeA}/api/marketplace/posts`).then(asArray),
            fetchJSON(`${nodeB}/api/marketplace/posts`).then(asArray),
        ]);

        const postSetA = new Set(postsA.map(p => p.id));
        const postSetB = new Set(postsB.map(p => p.id));

        const postMissingOnB = postsA.filter(p => !postSetB.has(p.id)).map(p => ({ title: p.title || '?', id: p.id }));
        const postMissingOnA = postsB.filter(p => !postSetA.has(p.id)).map(p => ({ title: p.title || '?', id: p.id }));

        const sharedPosts = postsA.filter(p => postSetB.has(p.id));
        const postMapB = new Map(postsB.map(p => [p.id, p]));
        const drifts = [];

        for (const a of sharedPosts) {
            const b = postMapB.get(a.id);
            if (!b) continue;
            if (a.status !== b.status || Boolean(a.active) !== Boolean(b.active)) {
                drifts.push({
                    title: a.title,
                    id: a.id,
                    statusA: a.status,
                    activeA: a.active,
                    statusB: b.status,
                    activeB: b.active
                });
            }
        }

        if (postMissingOnA.length === 0 && postMissingOnB.length === 0) {
            checks.posts = {
                status: drifts.length === 0 ? 'ok' : 'warn',
                details: `Post parity: all ${postSetA.size} listings match`,
                total: postSetA.size,
                drifts
            };
            if (drifts.length === 0) pass++; else warn++;
        } else {
            checks.posts = {
                status: 'warn',
                details: `${postMissingOnA.length + postMissingOnB.length} posts missing`,
                missingOnA: postMissingOnA,
                missingOnB: postMissingOnB,
                drifts
            };
            warn++;
        }

        if (drifts.length === 0 && postMissingOnA.length === 0 && postMissingOnB.length === 0) {
            pass++;
        }
    } catch (err) {
        checks.posts = { status: 'fail', error: err.message };
        fail++;
    }

    const overallStatus = fail > 0 ? 'broken' : (warn > 0 ? 'drifting' : 'in_sync');

    return {
        nodeA,
        nodeB,
        hostA,
        hostB,
        checks,
        summary: { pass, warn, fail, status: overallStatus }
    };
}

async function runMarketplaceAudit(nodeUrl) {
    let members, posts;
    try {
        [members, posts] = await Promise.all([
            fetchJSON(`${nodeUrl}/api/members`).then(asArray),
            fetchJSON(`${nodeUrl}/api/marketplace/posts`).then(asArray),
        ]);
    } catch (err) {
        throw new Error(`Failed to fetch data: ${err.message}`);
    }

    const memberKeys = new Set(members.map(m => m.publicKey));
    const orphaned = posts.filter(p => p.authorPublicKey && !memberKeys.has(p.authorPublicKey)).map(p => ({ title: p.title || '?', author: p.authorPublicKey }));

    const activePosts = posts.filter(p => p.active && p.status === 'active');
    const stale = activePosts.filter(p => p.createdAt && daysAgo(p.createdAt) > STALE_DAYS).map(p => ({ title: p.title || '?', age: daysAgo(p.createdAt) }));

    const zombies = posts.filter(p => !p.active && p.status === 'active').map(p => ({ title: p.title || '?', author: p.authorPublicKey }));

    const zeroPrice = activePosts.filter(p => p.credits === 0).map(p => ({ title: p.title || '?', author: p.authorPublicKey }));

    return {
        nodeUrl,
        host: hostFromUrl(nodeUrl),
        totalMembers: members.length,
        totalPosts: posts.length,
        orphaned,
        stale,
        zombies,
        zeroPrice
    };
}

// ===================== MODULE HANDLERS (CLI VIEW) =====================

async function handleIdentity(flags) {
    let pubkey = flags['--pubkey'] || null;
    let callsign = flags['--callsign'] || null;
    let transfer = flags['--transfer'] || null;
    let pin = flags['--pin'] || null;

    const useAllNodes = flags['--all-nodes'] === true;
    const singleNode = flags['--node'] || DEFAULT_NODES[0];
    const nodes = useAllNodes ? resolveNodes(flags) : [singleNode];

    try {
        const result = await runIdentityQuery({ pubkey, callsign, transfer, pin, nodes });

        if (result.mode === 'callsign') {
            log.head(`🔍 Searching for callsign "${result.searchString}" across ${nodes.length} node(s)`);
            log.line('');
            for (const r of result.results) {
                if (r.success) {
                    if (r.matches.length > 0) {
                        log.ok(`${r.node}: ${r.matches.length} match(es)`);
                        for (const m of r.matches) {
                            log.line(`      ${m.callsign} | ${shortKey(m.publicKey)} | joined ${m.joinedAt || '?'} | ${m.homeNodeUrl || 'primary'}`);
                        }
                    } else {
                        log.warn(`${r.node}: no matches`);
                    }
                } else {
                    log.fail(`${r.node}: ${r.error}`);
                }
            }
        } else if (result.mode === 'pubkey') {
            const label = result.callsign ? `${result.callsign} (${shortKey(result.publicKey)})` : shortKey(result.publicKey);
            log.head(`🔍 Identity Diagnostic for: ${label}`);
            if (result.decryptedInfo) {
                log.ok(`Transfer code decrypted via ${result.decryptedInfo.scheme}`);
                log.line(`   Callsign:    ${result.decryptedInfo.callsign}`);
                log.line(`   Public Key:  ${result.decryptedInfo.publicKey}`);
                log.line(`   Created:     ${result.decryptedInfo.createdAt} (${result.decryptedInfo.daysAgo} days ago)`);
                log.line('');
            }

            const rows = result.results.map(d => {
                const memberIcon = d.callsign === '⛔'
                    ? `${C.red}⛔ Down${C.reset}`
                    : d.isMember
                        ? `${C.green}✅ Yes${C.reset}`
                        : `${C.red}❌ No${C.reset}`;
                return [d.node, memberIcon, d.callsign, d.balance, d.friends, d.rating];
            });

            printTable(
                ['Node', 'Member?', 'Callsign', 'Balance', 'Friends', 'Rating'],
                rows,
                [28, 12, 14, 10, 14, 14]
            );

            log.line('');
            const settled = result.results.filter(r => r.callsign !== '⛔');
            const found = settled.filter(r => r.isMember);
            if (found.length === 0) {
                log.warn('Identity exists NOWHERE. This key was never registered on any live node.');
                log.hint('Generate an invite code and register via the Join flow.');
            } else {
                log.ok(`Identity found on ${found.length}/${settled.length} reachable node(s).`);
            }
        }
    } catch (err) {
        log.fail(err.message);
        process.exit(1);
    }
}

async function handleMirror(flags, positionals) {
    const useAllNodes = flags['--all-nodes'] === true;
    const pairs = [];

    if (useAllNodes) {
        const nodes = resolveNodes(flags);
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                pairs.push([nodes[i], nodes[j]]);
            }
        }
    } else if (positionals.length >= 2) {
        pairs.push([positionals[0], positionals[1]]);
    } else {
        log.fail('Mirror comparison requires two node URLs or --all-nodes');
        log.hint('Usage: bp-diagnose.mjs mirror https://nodeA https://nodeB');
        process.exit(1);
    }

    for (const [nodeA, nodeB] of pairs) {
        try {
            const comparison = await runMirrorComparison(nodeA, nodeB);
            const { hostA, hostB, checks, summary } = comparison;

            log.head(`🪞 Mirror Consistency: ${hostA} ↔ ${hostB}`);
            log.line('');

            // Version
            if (checks.version.status === 'ok') {
                log.ok(checks.version.details);
            } else if (checks.version.status === 'warn') {
                log.warn(checks.version.details);
            } else {
                log.fail(checks.version.details);
            }

            // Counts
            if (checks.counts.status === 'ok') {
                log.ok('All entity census counts match');
            } else if (checks.counts.status === 'warn') {
                checks.counts.details.forEach(c => {
                    if (c.match) {
                        log.ok(`${c.label} count: ${c.count}`);
                    } else {
                        log.warn(`${c.label} count: ${c.countA} vs ${c.countB} (drift: ${c.drift})`);
                    }
                });
            } else {
                log.fail(`Counts comparison failed: ${checks.counts.error}`);
            }

            // Members
            if (checks.members.status === 'ok') {
                log.ok(checks.members.details);
            } else if (checks.members.status === 'warn') {
                log.warn(`Member parity: ${checks.members.details}`);
                checks.members.missingOnB.slice(0, 5).forEach(m => {
                    log.line(`      ${C.red}Missing on ${hostB}:${C.reset} ${m.callsign} (${shortKey(m.publicKey)})`);
                });
                checks.members.missingOnA.slice(0, 5).forEach(m => {
                    log.line(`      ${C.red}Missing on ${hostA}:${C.reset} ${m.callsign} (${shortKey(m.publicKey)})`);
                });
            } else {
                log.fail(`Member parity check failed: ${checks.members.error}`);
            }

            // Profile Drift
            if (checks.profiles.status === 'ok') {
                log.ok(checks.profiles.details);
            } else if (checks.profiles.status === 'warn') {
                log.warn(checks.profiles.details);
                checks.profiles.drifts.slice(0, 5).forEach(d => {
                    log.line(`      ${d.callsign} (${shortKey(d.publicKey)}): ${d.issues.join(', ')}`);
                });
            }

            // Posts
            if (checks.posts.status === 'ok') {
                log.ok(checks.posts.details);
            } else if (checks.posts.status === 'warn') {
                if (checks.posts.missingOnA || checks.posts.missingOnB) {
                    log.warn(`Post parity: ${checks.posts.details}`);
                    checks.posts.missingOnB.slice(0, 5).forEach(p => {
                        log.line(`      ${C.red}Missing on ${hostB}:${C.reset} "${p.title}" (${shortKey(p.id)})`);
                    });
                    checks.posts.missingOnA.slice(0, 5).forEach(p => {
                        log.line(`      ${C.red}Missing on ${hostA}:${C.reset} "${p.title}" (${shortKey(p.id)})`);
                    });
                }
                if (checks.posts.drifts && checks.posts.drifts.length > 0) {
                    log.warn(`Post status drift: ${checks.posts.drifts.length} items skewing`);
                    checks.posts.drifts.slice(0, 5).forEach(d => {
                        log.line(`      Drift: "${d.title}" — ${hostA}: ${d.statusA}/${d.activeA ? 'act' : 'inact'}, ${hostB}: ${d.statusB}/${d.activeB ? 'act' : 'inact'}`);
                    });
                }
            } else {
                log.fail(`Post check failed: ${checks.posts.error}`);
            }

            log.line('');
            const statusLabel = summary.status === 'broken'
                ? `${C.red}${C.bold}BROKEN${C.reset}`
                : summary.status === 'drifting'
                    ? `${C.amber}DRIFTING${C.reset}`
                    : `${C.green}IN SYNC${C.reset}`;
            log.line(`   Summary: ${C.green}${summary.pass} ✅${C.reset}  ${C.amber}${summary.warn} ⚠️${C.reset}  ${C.red}${summary.fail} ❌${C.reset} — Mirror is ${statusLabel}`);
            log.line('');

        } catch (err) {
            log.fail(`Mirror check failed: ${err.message}`);
        }
    }
}

async function handleMarketplace(flags) {
    const nodeUrl = flags['--node'] || DEFAULT_NODES[0];
    try {
        const audit = await runMarketplaceAudit(nodeUrl);

        log.head(`🏪 Marketplace Health: ${audit.host}`);
        log.line('');
        log.sub(`Loaded ${audit.totalMembers} members, ${audit.totalPosts} posts`);
        log.line('');

        let pass = 0, warn = 0;

        // Orphaned
        if (audit.orphaned.length === 0) {
            log.ok('No orphaned posts');
            pass++;
        } else {
            log.warn(`${audit.orphaned.length} orphaned post(s)`);
            audit.orphaned.slice(0, 5).forEach(p => log.line(`      "${p.title}" by ${shortKey(p.author)}`));
            warn++;
        }

        // Stale
        if (audit.stale.length === 0) {
            log.ok(`No stale active listings (all < ${STALE_DAYS} days)`);
            pass++;
        } else {
            log.warn(`${audit.stale.length} stale listings active`);
            audit.stale.slice(0, 5).forEach(p => log.line(`      "${p.title}" — ${p.age} days old`));
            warn++;
        }

        // Zombie
        if (audit.zombies.length === 0) {
            log.ok('No zombie listings (active flags in sync)');
            pass++;
        } else {
            log.warn(`${audit.zombies.length} zombie listing(s) (inactive but active status)`);
            audit.zombies.slice(0, 5).forEach(z => log.line(`      "${z.title}" by ${shortKey(z.author)}`));
            warn++;
        }

        // Zero Price
        if (audit.zeroPrice.length === 0) {
            log.ok('No zero-price active posts');
            pass++;
        } else {
            log.warn(`${audit.zeroPrice.length} active posts with 0 credits`);
            audit.zeroPrice.slice(0, 5).forEach(p => log.line(`      "${p.title}" by ${shortKey(p.author)}`));
            warn++;
        }

        log.line('');
        log.line(`   Summary: ${C.green}${pass} ✅${C.reset}  ${C.amber}${warn} ⚠️${C.reset}`);

    } catch (err) {
        log.fail(err.message);
    }
}

async function handleNetwork(flags) {
    const nodes = resolveNodes(flags);
    log.head(`🌐 Network Topology Scan (${nodes.length} nodes)`);
    log.line('');

    try {
        const swept = await runNetworkSweep(nodes);
        const rows = swept.map(d => [d.host, d.status, d.version, d.members, d.posts, d.tls]);

        printTable(
            ['Node', 'Status', 'Version', 'Members', 'Posts', 'TLS Expires'],
            rows,
            [28, 10, 12, 10, 8, 16]
        );

        const versions = swept.map(r => r.version).filter(v => v !== '—' && v !== '?');
        const unique = new Set(versions);
        if (unique.size > 1) {
            log.line('');
            log.warn(`Version skew detected: ${[...unique].join(', ')}`);
        }
    } catch (err) {
        log.fail(`Sweep execution failed: ${err.message}`);
    }
}

async function handleAuth(flags) {
    const nodeUrl = flags['--node'] || 'https://localhost:8443';
    log.head(`🛡️  Auth Boundary Verification: ${hostFromUrl(nodeUrl)}`);
    log.line('');
    log.sub('Delegating to verify-auth-boundary.mjs...');
    log.line('');

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(scriptDir, 'verify-auth-boundary.mjs');

    return new Promise((resolve) => {
        execFile('node', [scriptPath, nodeUrl], { timeout: 60000 }, (err, stdout, stderr) => {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (err && err.code) {
                log.fail(`Auth boundary verification exited with code ${err.code}`);
            }
            resolve();
        });
    });
}

// ===================== MODULE: DASHBOARD SERVER (PROXY BACKEND) =====================

async function handleDashboard(flags) {
    const rawPort = flags['--port'] || '3000';
    const port = parseInt(rawPort, 10);
    if (isNaN(port)) {
        log.fail(`Invalid port specified: ${rawPort}`);
        process.exit(1);
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const dashboardHtmlPath = path.join(scriptDir, 'dashboard.html');

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://localhost:${port}`);
        const pathname = urlObj.pathname;

        const setJSONHeaders = () => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        };

        if (req.method === 'OPTIONS') {
            setJSONHeaders();
            res.statusCode = 200;
            res.end();
            return;
        }

        try {
            if (pathname === '/' || pathname === '/index.html') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                try {
                    const html = await fs.promises.readFile(dashboardHtmlPath, 'utf8');
                    res.statusCode = 200;
                    res.end(html);
                } catch (err) {
                    res.statusCode = 500;
                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head><title>Asset Error | BeanPool Diagnostics</title></head>
                        <body style="font-family: system-ui, -apple-system, sans-serif; padding: 40px; background: #0b0c10; color: #f1f3f9; line-height: 1.6;">
                            <div style="max-width: 600px; margin: 0 auto; background: #161a23; padding: 30px; border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.2); box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                                <h2 style="color: #ef4444; margin-top: 0; display: flex; align-items: center; gap: 10px;">⚠️ Dashboard Assets Missing</h2>
                                <p>Could not read the visual interface file <code>dashboard.html</code> at path:</p>
                                <pre style="background: #0f111a; padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); overflow-x: auto; font-family: monospace; color: #f59e0b;">${dashboardHtmlPath}</pre>
                                <p>Please ensure that both <code>bp-diagnose.mjs</code> and <code>dashboard.html</code> are located together inside the <code>scripts/</code> directory.</p>
                                <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 20px 0;"/>
                                <p style="color: #8c9ba5; font-size: 0.85em; margin-bottom: 0;">Error details: ${err.message}</p>
                            </div>
                        </body>
                        </html>
                    `);
                }
                return;
            }

            if (pathname === '/api/proxy/network') {
                setJSONHeaders();
                const nodes = resolveNodes(flags);
                const results = await runNetworkSweep(nodes);
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, data: results }));
                return;
            }

            if (pathname === '/api/proxy/identity') {
                setJSONHeaders();
                const pubkey = urlObj.searchParams.get('pubkey');
                const callsign = urlObj.searchParams.get('callsign');
                const transfer = urlObj.searchParams.get('transfer');
                const pin = urlObj.searchParams.get('pin');
                const nodes = resolveNodes(flags);

                const report = await runIdentityQuery({ pubkey, callsign, transfer, pin, nodes });
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, data: report }));
                return;
            }

            if (pathname === '/api/proxy/mirror') {
                setJSONHeaders();
                const nodeA = urlObj.searchParams.get('nodeA');
                const nodeB = urlObj.searchParams.get('nodeB');
                if (!nodeA || !nodeB) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, error: 'Missing parameters nodeA and nodeB' }));
                    return;
                }

                const comparison = await runMirrorComparison(nodeA, nodeB);
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, data: comparison }));
                return;
            }

            if (pathname === '/api/proxy/marketplace') {
                setJSONHeaders();
                const targetNode = urlObj.searchParams.get('node') || resolveNodes(flags)[0];
                const audit = await runMarketplaceAudit(targetNode);
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, data: audit }));
                return;
            }

            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));

        } catch (err) {
            setJSONHeaders();
            res.statusCode = 500;
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });

    server.listen(port, () => {
        console.log(`\n${C.bold}${C.green}🌱 BeanPool Network Diagnostic Dashboard active!${C.reset}`);
        console.log(`   ${C.cyan}👉 Local Dashboard URL:${C.reset} ${C.bold}http://localhost:${port}${C.reset}`);
        console.log(`   ${C.dim}Mode: Zero-Dependency CORS Proxy & Visualizer${C.reset}`);
        console.log(`   ${C.dim}Press Ctrl+C to terminate${C.reset}\n`);
    });
}

// ===================== HELP TEXT =====================

function printHelp() {
    console.log(`
${C.bold}${C.cyan}🌱 BeanPool Network Diagnostic Suite v${VERSION}${C.reset}
${C.dim}   [Mode: Strict Read-Only Diagnostics]${C.reset}

${C.bold}Usage CLI:${C.reset}
  node scripts/bp-diagnose.mjs <command> [options]

${C.bold}Usage Visual Web Dashboard:${C.reset}
  node scripts/bp-diagnose.mjs dashboard [options]

${C.bold}Commands:${C.reset}
  ${C.green}identity${C.reset}      Look up a member by callsign, public key, or transfer code
  ${C.green}mirror${C.reset}        Compare two nodes for sync drift
  ${C.green}marketplace${C.reset}   Sanity-check marketplace listings on a node
  ${C.green}network${C.reset}       Health sweep across all known nodes
  ${C.green}auth${C.reset}          Verify auth boundary (delegates to verify-auth-boundary.mjs)
  ${C.green}dashboard${C.reset}     Launch local HTTP server hosting dynamic Web Dashboard UI

${C.bold}Identity Options:${C.reset}
  --callsign NAME       Search by callsign (partial, case-insensitive)
  --pubkey HEX          Look up by full public key
  --transfer URI        Decrypt a beanpool://import transfer code (requires --pin)
  --pin DIGITS          PIN for transfer code decryption
  --node URL            Target a single node (default: ${DEFAULT_NODES[0]})
  --all-nodes           Scan all known nodes
  --nodes URL,URL,...   Override default node list

${C.bold}Mirror Options:${C.reset}
  mirror URL1 URL2      Compare two specific nodes
  --all-nodes           Compare all node pairs

${C.bold}Marketplace Options:${C.reset}
  --node URL            Target node (default: ${DEFAULT_NODES[0]})

${C.bold}Network Options:${C.reset}
  --all-nodes           Scan all known nodes (default behaviour)
  --nodes URL,URL,...   Override default node list

${C.bold}Dashboard Options:${C.reset}
  --port PORT           Local port to run the web server on (default: 3000)
  --nodes URL,URL,...   Override default node list for web proxy fetches

${C.bold}Examples:${C.reset}
  ${C.dim}# Launch the web dashboard server${C.reset}
  node scripts/bp-diagnose.mjs dashboard --port 3000

  ${C.dim}# Find where a member is registered via CLI${C.reset}
  node scripts/bp-diagnose.mjs identity --all-nodes --pubkey 5dd929...720440

  ${C.dim}# Check if two mirrors are in sync via CLI${C.reset}
  node scripts/bp-diagnose.mjs mirror https://test.beanpool.org https://review.beanpool.org
`);
}

// ===================== MAIN =====================

async function main() {
    const { subcommand, positionals, flags } = parseArgs();

    if (!subcommand || flags['--help'] || subcommand === 'help') {
        printHelp();
        process.exit(0);
    }

    if (subcommand !== 'dashboard') {
        console.log(`\n${C.bold}${C.cyan}🌱 BeanPool Network Diagnostic Suite v${VERSION}${C.reset}`);
        console.log(`${C.dim}   [Mode: Strict Read-Only Diagnostics]${C.reset}\n`);
    }

    switch (subcommand) {
        case 'identity':
            await handleIdentity(flags);
            break;
        case 'mirror':
            await handleMirror(flags, positionals);
            break;
        case 'marketplace':
            await handleMarketplace(flags);
            break;
        case 'network':
            await handleNetwork(flags);
            break;
        case 'auth':
            await handleAuth(flags);
            break;
        case 'dashboard':
            await handleDashboard(flags);
            break;
        default:
            log.fail(`Unknown command: ${subcommand}`);
            printHelp();
            process.exit(1);
    }

    if (subcommand !== 'dashboard') {
        console.log('');
    }
}

main().catch(err => {
    console.error(`${C.red}❌ Critical error: ${err.message}${C.reset}`);
    process.exit(1);
});
