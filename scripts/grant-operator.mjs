// Grant or revoke operator capability for a member on a treasury.
//
//   NODE_URL=https://test.beanpool.org BEANPOOL_TOKEN='bp_…' \
//     node scripts/grant-operator.mjs <treasury> <callsign-or-pubkey> [--revoke] [--insecure]
//
// BEANPOOL_TOKEN is an owner's automation token with the ADMIN scope (Settings → Automation tokens, made by an owner
// signed in with their key). It is read from the environment only, never an argument: arguments show in `ps`.
// ADMIN_PASSWORD (the node's admin password) still works in its place, as before; with a token it is never sent.

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
if (BEANPOOL_TOKEN && !BEANPOOL_TOKEN.startsWith('bp_')) {
    console.error('✗ BEANPOOL_TOKEN is not an automation token (bp_…): make one in Settings → Automation tokens.');
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

// Fetch members and treasuries to resolve names/callsigns
const [membersRes, treasuriesRes] = await Promise.all([
    fetch(`${NODE_URL}/api/community/members`).catch(() => null),
    fetch(`${NODE_URL}/api/treasuries`).catch(() => null),
]);

const members = (membersRes && membersRes.ok) ? await membersRes.json().catch(() => []) : [];
const treasuryData = (treasuriesRes && treasuriesRes.ok) ? await treasuriesRes.json().catch(() => ({})) : {};
const treasuries = treasuryData.treasuries || [];

const findTreasury = (val) => {
    if (!val) return null;
    const v = val.toLowerCase();
    return treasuries.find((t) => t.publicKey === val || t.name?.toLowerCase() === v || t.callsign?.toLowerCase() === v);
};

const findMember = (val) => {
    if (!val) return null;
    const v = val.toLowerCase();
    return members.find((m) => m.publicKey === val || m.callsign?.toLowerCase() === v);
};

let treasuryTarget;
let memberTarget;

if (treasuryArg) {
    treasuryTarget = treasuryArg;
    memberTarget = positionalArgs[0];
} else if (findTreasury(positionalArgs[1]) && !findTreasury(positionalArgs[0])) {
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

const matchedTreasury = findTreasury(treasuryTarget);
const treasuryPubkey = matchedTreasury ? matchedTreasury.publicKey : treasuryTarget;
const treasuryName = matchedTreasury?.name || matchedTreasury?.callsign || treasuryPubkey;
if (matchedTreasury) {
    console.log(`Found treasury "${treasuryName}": ${treasuryPubkey}`);
}

const matchedMember = findMember(memberTarget);
const pubkey = matchedMember ? matchedMember.publicKey : memberTarget;
const memberCallsign = matchedMember?.callsign || memberTarget;
if (matchedMember) {
    console.log(`Found member "${memberCallsign}": ${pubkey}`);
}

if (!pubkey || !treasuryPubkey) {
    console.error('✗ Missing valid member or treasury identifier.');
    process.exit(1);
}

const adminHeaders = {
    'content-type': 'application/json',
    ...authHeader,
};

let res;
try {
    if (revoke) {
        res = await fetch(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators/${encodeURIComponent(pubkey)}`, {
            method: 'DELETE',
            headers: authHeader,
        });
    } else {
        res = await fetch(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ pubkey }),
        });
    }
} catch (err) {
    console.error(`\n✗ Network error connecting to ${NODE_URL}:`, err.message || err);
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
