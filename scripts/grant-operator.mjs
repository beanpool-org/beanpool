// Grant or revoke operator capability for a member on a node.
//
//   NODE_URL=https://test.beanpool.org ADMIN_PASSWORD='your-admin-password' \
//     node scripts/grant-operator.mjs <callsign-or-pubkey> [--revoke]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const target = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!ADMIN_PASSWORD) {
    console.error('✗ Set ADMIN_PASSWORD env var.');
    process.exit(1);
}

if (!target) {
    console.error('Usage: NODE_URL=... ADMIN_PASSWORD=... node scripts/grant-operator.mjs <callsign-or-pubkey> [--revoke]');
    process.exit(1);
}

// Fetch members to resolve callsign if needed
const membersRes = await fetch(`${NODE_URL}/api/community/members`).catch(() => null);
let pubkey = target;

if (membersRes && membersRes.ok) {
    const members = await membersRes.json();
    const match = members.find((m) => m.callsign?.toLowerCase() === target.toLowerCase() || m.publicKey === target);
    if (match) {
        pubkey = match.publicKey;
        console.log(`Found member "${match.callsign}": ${pubkey}`);
    }
}

const adminHeaders = { 'content-type': 'application/json', 'x-admin-password': ADMIN_PASSWORD };
const res = await fetch(`${NODE_URL}/api/local/admin/users/${encodeURIComponent(pubkey)}/operator`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ granted: !revoke }),
});

const data = await res.json().catch(() => ({}));

if (res.ok && data.success) {
    console.log(`\n✅ ${revoke ? 'Revoked' : 'Granted'} operator capability for ${target} (${pubkey}) on ${NODE_URL}`);
    console.log(`   → Next time this user refreshes the app, they will see the OPERATOR CONTROLS on the Commons tab.`);
} else {
    console.error(`\n✗ Failed (HTTP ${res.status}):`, data.error || JSON.stringify(data));
}
