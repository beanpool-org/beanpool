// Grant or revoke operator capability for a member on a treasury.
//
//   NODE_URL=https://test.beanpool.org ADMIN_PASSWORD='your-admin-password' \
//     node scripts/grant-operator.mjs <treasury> <callsign-or-pubkey> [--revoke]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const revoke = process.argv.includes('--revoke');

if (!ADMIN_PASSWORD) {
    console.error('✗ Set ADMIN_PASSWORD env var.');
    process.exit(1);
}

// Parse arguments
let treasuryArg = null;
const treasuryFlagIdx = process.argv.indexOf('--treasury');
if (treasuryFlagIdx !== -1 && process.argv[treasuryFlagIdx + 1]) {
    treasuryArg = process.argv[treasuryFlagIdx + 1];
}

const positionalArgs = [];
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--revoke') continue;
    if (arg === '--treasury') { i++; continue; }
    positionalArgs.push(arg);
}

if (!treasuryArg && positionalArgs.length < 2) {
    console.error('Usage: NODE_URL=... ADMIN_PASSWORD=... node scripts/grant-operator.mjs <treasury> <callsign-or-pubkey> [--revoke]');
    console.error('       NODE_URL=... ADMIN_PASSWORD=... node scripts/grant-operator.mjs <callsign-or-pubkey> --treasury <treasury> [--revoke]');
    process.exit(1);
}

// Fetch members and treasuries to resolve names/callsigns
const [membersRes, treasuriesRes] = await Promise.all([
    fetch(`${NODE_URL}/api/community/members`).catch(() => null),
    fetch(`${NODE_URL}/api/treasuries`).catch(() => null),
]);

const members = (membersRes && membersRes.ok) ? await membersRes.json() : [];
const treasuryData = (treasuriesRes && treasuriesRes.ok) ? await treasuriesRes.json() : {};
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

const adminHeaders = {
    'content-type': 'application/json',
    'x-admin-password': ADMIN_PASSWORD,
};

let res;
if (revoke) {
    res = await fetch(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators/${encodeURIComponent(pubkey)}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': ADMIN_PASSWORD },
    });
} else {
    res = await fetch(`${NODE_URL}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ pubkey }),
    });
}

const data = await res.json().catch(() => ({}));

if (res.ok && data.success) {
    console.log(`\n✅ ${revoke ? 'Revoked' : 'Granted'} operator capability for ${memberCallsign} (${pubkey}) on treasury "${treasuryName}" (${treasuryPubkey}) on ${NODE_URL}`);
    console.log(`   → Next time this user refreshes the app, they will see operator controls for this treasury on the Commons tab.`);
} else {
    console.error(`\n✗ Failed (HTTP ${res.status}):`, data.error || JSON.stringify(data));
}
