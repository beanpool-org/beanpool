// Grant or revoke operator capability for a member on a treasury.
//
//   NODE_URL=https://test.beanpool.org BEANPOOL_TOKEN='bp_…' \
//     node scripts/grant-operator.mjs <treasury> <callsign-or-pubkey> [--revoke] [--insecure]
//
// BEANPOOL_TOKEN is an owner's automation token with the ADMIN scope (Settings → Automation tokens, made by an owner
// signed in with their key). It is read from the environment only, never an argument: arguments show in `ps`.
// ADMIN_PASSWORD (the node's admin password) still works in its place, as before; with a token it is never sent.

import { automationTokenProblem, headerValueProblem, fetchNoRedirect } from './automation-token.mjs';

const insecure = process.argv.includes('--insecure');
if (insecure) {
    console.warn('⚠️  Warning: TLS certificate verification is disabled (--insecure). Do not use this in production.');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const BEANPOOL_TOKEN = process.env.BEANPOOL_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const revoke = process.argv.includes('--revoke');

if (!BEANPOOL_TOKEN && !ADMIN_PASSWORD) {
    console.error('✗ Set BEANPOOL_TOKEN (an owner\'s automation token, admin scope) or, as before, ADMIN_PASSWORD.');
    process.exit(1);
}
// Checked whole before any request, and never repeated: see automation-token.mjs.
const credentialProblem = BEANPOOL_TOKEN ? automationTokenProblem('BEANPOOL_TOKEN', BEANPOOL_TOKEN) : headerValueProblem('ADMIN_PASSWORD', ADMIN_PASSWORD);
if (credentialProblem) {
    console.error(`✗ ${credentialProblem}`);
    process.exit(1);
}
// The token alone, or the password alone: never both.
const authHeader = BEANPOOL_TOKEN ? { authorization: `Bearer ${BEANPOOL_TOKEN}` } : { 'x-admin-password': ADMIN_PASSWORD };

// Parse arguments
let treasuryArg = null;
const treasuryFlagIdx = process.argv.indexOf('--treasury');
if (treasuryFlagIdx !== -1 && process.argv[treasuryFlagIdx + 1] && !process.argv[treasuryFlagIdx + 1].startsWith('--')) {
    treasuryArg = process.argv[treasuryFlagIdx + 1];
}

const positionalArgs = [];
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--revoke' || arg === '--insecure') continue;
    if (arg === '--treasury') {
        if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
            i++;
        }
        continue;
    }
    positionalArgs.push(arg);
}

const minPositional = treasuryArg ? 1 : 2;
if (positionalArgs.length < minPositional) {
    console.error('Usage: NODE_URL=... BEANPOOL_TOKEN=bp_... node scripts/grant-operator.mjs <treasury> <callsign-or-pubkey> [--revoke] [--insecure]');
    console.error('       NODE_URL=... BEANPOOL_TOKEN=bp_... node scripts/grant-operator.mjs <callsign-or-pubkey> --treasury <treasury> [--revoke] [--insecure]');
    console.error('       (an owner\'s automation token with the admin scope; ADMIN_PASSWORD=... still works in its place)');
    process.exit(1);
}

// Names are looked up on the admin reads the credential opens: the treasury list, and the member list the manager
// reads (POST /api/local/admin/data). /api/community/members and /api/treasuries are members-only on a node with read
// auth on (the default), so an unsigned ask of them was refused, and the name went out as if it were a key.
// A public key (64 hex) is used as given and needs no lookup.
const isKey = (v) => /^[0-9a-f]{64}$/i.test(v);

async function adminRead(what, method, route) {
    let res;
    try {
        res = await fetchNoRedirect(`${NODE_URL}${route}`, {
            method,
            headers: method === 'POST' ? { 'content-type': 'application/json', ...authHeader } : authHeader,
            ...(method === 'POST' ? { body: '{}' } : {}),
        });
    } catch (err) {
        console.error(err?.redirect ? `✗ ${err.message} Nothing was changed.` : `✗ Could not reach ${NODE_URL} to read the ${what}: ${err?.cause?.code || err?.message || err}. Nothing was changed.`);
        process.exit(1);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
        console.error(`✗ Reading the ${what} failed (HTTP ${res.status}): ${body?.error || res.statusText}. Nothing was changed.`);
        process.exit(1);
    }
    return body;
}

const nameArgs = treasuryArg ? [treasuryArg] : positionalArgs.slice(0, 2);
const treasuries = nameArgs.every(isKey) ? [] : ((await adminRead('treasury list', 'GET', '/api/local/admin/treasury')).treasuries || []);

const treasuriesNamed = (val) => {
    const v = val.toLowerCase();
    return treasuries.filter((t) => t.publicKey === val || t.name?.toLowerCase() === v || t.callsign?.toLowerCase() === v);
};

let treasuryTarget;
let memberTarget;

if (treasuryArg) {
    treasuryTarget = treasuryArg;
    memberTarget = positionalArgs[0];
} else if (treasuriesNamed(positionalArgs[1]).length && !treasuriesNamed(positionalArgs[0]).length) {
    treasuryTarget = positionalArgs[1];
    memberTarget = positionalArgs[0];
} else {
    treasuryTarget = positionalArgs[0];
    memberTarget = positionalArgs[1];
}

if (!treasuryTarget || !memberTarget) {
    console.error('✗ Both treasury and member (callsign or pubkey) must be specified.');
    process.exit(1);
}

/** The one match for `val`, or a plain stop: none, or more than one (then their keys, so one can be given). */
function onlyMatch(kind, val, matches) {
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) console.error(`✗ No ${kind} is called "${val}" on ${NODE_URL}. Check the spelling, or give the public key.`);
    else console.error(`✗ ${matches.length} ${kind === 'member' ? 'members' : 'treasuries'} are called "${val}": give the public key of the one you mean.\n${matches.map((m) => `   ${m.publicKey}`).join('\n')}`);
    process.exit(1);
}

let treasuryPubkey = treasuryTarget;
let treasuryName = treasuryTarget;
if (!isKey(treasuryTarget)) {
    const matchedTreasury = onlyMatch('treasury', treasuryTarget, treasuriesNamed(treasuryTarget));
    treasuryPubkey = matchedTreasury.publicKey;
    treasuryName = matchedTreasury.name || matchedTreasury.callsign || treasuryPubkey;
    console.log(`Found treasury "${treasuryName}": ${treasuryPubkey}`);
}

let pubkey = memberTarget;
let memberCallsign = memberTarget;
if (!isKey(memberTarget)) {
    const members = (await adminRead('member list', 'POST', '/api/local/admin/data')).members || [];
    const v = memberTarget.toLowerCase();
    const matchedMember = onlyMatch('member', memberTarget, members.filter((m) => m.callsign?.toLowerCase() === v));
    pubkey = matchedMember.publicKey;
    memberCallsign = matchedMember.callsign || memberTarget;
    console.log(`Found member "${memberCallsign}": ${pubkey}`);
}


const adminHeaders = {
    'content-type': 'application/json',
    ...authHeader,
};

let res;
try {
    if (revoke) {
        res = await fetchNoRedirect(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators/${encodeURIComponent(pubkey)}`, {
            method: 'DELETE',
            headers: authHeader,
        });
    } else {
        res = await fetchNoRedirect(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ pubkey }),
        });
    }
} catch (err) {
    if (err?.redirect) console.error(`\n✗ ${err.message}`);
    else console.error(`\n✗ Network error connecting to ${NODE_URL}:`, err.message || err);
    process.exit(1);
}

const data = await res.json().catch(() => ({}));

if (res.ok && data.success) {
    console.log(`\n✅ ${revoke ? 'Revoked' : 'Granted'} operator capability for ${memberCallsign} (${pubkey}) on treasury "${treasuryName}" (${treasuryPubkey}) on ${NODE_URL}`);
    console.log(`   → Next time this user refreshes the app, they will see operator controls for this treasury on the Commons tab.`);
} else {
    console.error(`\n✗ Failed (HTTP ${res.status}):`, data.error || JSON.stringify(data));
    process.exit(1);
}
