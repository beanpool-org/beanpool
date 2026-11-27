// The image build's settings that change the image (build.sh): the host network (IPv4, and IPv6), the vault's own
// name, the host profile, and image.json, which records them.
//
//   node image/image-settings.mjs check <network>          prints the setting back, or refuses (exit 2) and says why
//   node image/image-settings.mjs write <network> <file> [<network6>]
//                                                          writes the static form's network file (nothing for dhcp),
//                                                          and prints the setting back
//   node image/image-settings.mjs check6 <network6>        the IPv6 setting: `ra` (default) or static (below)
//   node image/image-settings.mjs check-name <name>        the vault's own DNS name (default vault.beanpool.org)
//   node image/image-settings.mjs write-name <name> <Caddyfile> <api.json>
//                                                          puts the name in the two image files that hold it; prints it
//   node image/image-settings.mjs host <profile> <field>   a host profile's value build.sh needs (host-profiles/)
//   node image/image-settings.mjs host-policy <profile> <measurement>
//                                                          the release's starting host policy (release propose --host-policy)
//   node image/image-settings.mjs image-json <version> <ukiSha256> <roothash> <imageHash> <network>
//                                                          [<network6> <name> <profile> <measurement> <acpi|acpi-off>]
//
// build.sh goes on only when each answer is the one it expects (and checks the file written and image.json), so a run
// that does nothing stops the build instead of building without the setting.
//
// <network> is `dhcp` (the default: the image's own etc/systemd/network/80-wan.network, untouched, so the image is
// byte for byte what it was before the setting existed) or `static:<ipv4>/<prefix>,<gateway>` for a host that hands
// out no address (1984 VPS #1: measured 2026-10-03, no DHCP lease; its Debian has a static address). The static form
// writes 80-wan.network over the DHCP one, with router advertisements kept for IPv6. The setting is public and part
// of the image and its hash: image.json records it, and a rebuild for the comparison passes the same one.
//
// <network6> is `ra` (the default: IPv6 from router advertisements, as the image always was) or
// `static:<ipv6>/<prefix>,<gateway>` for a host that sets its IPv6 address by hand too (Servury, measured 2026-11-26:
// netplan with dhcp6 false). It needs the static IPv4 form (a host with static IPv6 and DHCP IPv4 is not one we have),
// adds the address and gateway to the same file and stops taking router advertisements. The gateway is inside the
// prefix or link-local (fe80::/10, common for a host's router). A global gateway OUTSIDE the prefix, reached on the
// link, is said with `,onlink` after it: `static:<ipv6>/<prefix>,<gateway>,onlink` (Servury again, measured on the live
// box 27 Nov 2026: `default via 2602:f41c::1 dev ens18 ... onlink`, outside 2602:f41c:0:39c::/64). Its file has the
// default route in a [Route] section with GatewayOnLink=yes; a setting without `,onlink` writes the same file as before.
//
// <name> is the vault's own DNS name: Caddy's site (etc/caddy/Caddyfile) and the API's `hosts` (etc/beanpool-vault/
// api.json), which phones sign their requests for. The default, vault.beanpool.org, leaves both files untouched, so a
// default build is byte for byte what it was; any other name is written into both and recorded in image.json.
//
// <profile> names a host profile (host-profiles/<profile>.json; `none` for no profile: the image as it was): the
// confidential host the image is built for, with what the chip measures at launch (the host's firmware, its hash and
// where it comes from, the CPU count and model, the guest features) and the release's floor for that host (the guest
// policy, the minimum firmware levels). build.sh computes the launch measurement from it and records it in image.json
// (`host`) and in host-policy.json. Only the platform reaches the image's bytes (the keyholder's attestor, the SNP
// units): the floor is the signed release's, so raising it never needs a new image.
//
// The firewall (etc/nftables.conf) keeps its DHCP rules in both forms: they only let networkd's client send to the
// DHCP ports, and with a static address networkd sends nothing there, so they are harmless. Leaving the file alone
// keeps the dhcp image the same bytes.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const IPV4 = `${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}`;
const STATIC = new RegExp(`^static:(${IPV4})/([1-9]|[12][0-9]|3[0-2]),(${IPV4})$`);

const toInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

function refuse(value, why) {
    throw new Error(`--network ${JSON.stringify(value)}: ${why}. It is dhcp or static:<ipv4>/<prefix>,<gateway> (e.g. static:192.0.2.10/24,192.0.2.1).`);
}

/** `dhcp` or `static:<ipv4>/<prefix>,<gateway>`, strictly (no leading zeros, no spaces); anything else throws. */
export function parseNetwork(value) {
    if (value === 'dhcp') return { kind: 'dhcp', value };
    if (typeof value !== 'string' || !value.startsWith('static:')) refuse(value, 'not a network setting');
    const m = STATIC.exec(value);
    if (!m) refuse(value, 'not static:<ipv4>/<prefix 1-32>,<ipv4 gateway>');
    const address = m[1];
    const prefix = Number(m[6]);
    const gateway = m[7];
    const a = toInt(address);
    const g = toInt(gateway);
    // Both unicast: with a prefix of /1 to /7 the gateway's first octet can differ from the address's.
    for (const [ip, n] of [[address, a], [gateway, g]]) {
        const first = n >>> 24;
        if (first === 0 || first === 127 || first >= 224) refuse(value, `${ip} is not a host's unicast address`);
    }
    const mask = prefix === 32 ? 0xffffffff : (~(0xffffffff >>> prefix)) >>> 0;
    if (((a & mask) >>> 0) !== ((g & mask) >>> 0)) refuse(value, `the gateway ${gateway} is not inside ${address}/${prefix}`);
    if (a === g) refuse(value, `the gateway ${gateway} is the address itself`);
    if (prefix <= 30) {
        const host = (~mask) >>> 0;
        for (const [ip, n] of [[address, a], [gateway, g]]) {
            if (((n & host) >>> 0) === 0 || ((n & host) >>> 0) === host) refuse(value, `${ip} is the network or broadcast address of /${prefix}`);
        }
    }
    return { kind: 'static', value, address, prefix, gateway };
}

const HEX4 = /^[0-9a-f]{1,4}$/;

/** An IPv6 address in lower case (no zone, no embedded IPv4) as 8 groups, or null. */
function ipv6Groups(text) {
    if (typeof text !== 'string' || !/^[0-9a-f:]+$/.test(text) || text.includes(':::')) return null;
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const part = (h) => (h === '' ? [] : h.split(':'));
    const head = part(halves[0]);
    const tail = halves.length === 2 ? part(halves[1]) : [];
    if (![...head, ...tail].every((g) => HEX4.test(g))) return null;
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    return [...head, ...Array(missing).fill('0'), ...tail].map((g) => parseInt(g, 16));
}

const toBig6 = (groups) => groups.reduce((n, g) => (n << 16n) | BigInt(g), 0n);

function refuse6(value, why) {
    throw new Error(`--network6 ${JSON.stringify(value)}: ${why}. It is ra or static:<ipv6>/<prefix>,<gateway>, with ,onlink after a`
        + ' global gateway outside the prefix (e.g. static:2001:db8::10/64,2001:db8::1 or static:2001:db8:0:1::10/64,2001:db8::1,onlink).');
}

/**
 * `ra` or `static:<ipv6>/<prefix>,<gateway>[,onlink]`, strictly (lower case, no zone, no embedded IPv4); anything else
 * throws. `,onlink` is said, never assumed: it is for a global gateway outside the prefix, and refused for any other
 * (a gateway outside the prefix without it is still a refusal, so a typo in the gateway stays one). The result has
 * `onLink: true` only then, so every setting without it gives the same object, and the same file, as before.
 */
export function parseNetwork6(value) {
    if (value === 'ra') return { kind: 'ra', value };
    if (typeof value !== 'string' || !value.startsWith('static:')) refuse6(value, 'not an IPv6 setting');
    const m = /^static:([0-9a-f:]+)\/([1-9][0-9]{0,2}),([0-9a-f:]+)(,onlink)?$/.exec(value);
    if (!m) refuse6(value, 'not static:<ipv6>/<prefix 1-128>,<ipv6 gateway>[,onlink]');
    const [, address, prefixText, gateway, onLinkText] = m;
    const onLink = onLinkText === ',onlink';
    const prefix = Number(prefixText);
    if (prefix > 128) refuse6(value, 'the prefix is 1 to 128');
    const a = ipv6Groups(address);
    const g = ipv6Groups(gateway);
    if (!a) refuse6(value, `${address} is not an IPv6 address`);
    if (!g) refuse6(value, `${gateway} is not an IPv6 address`);
    const A = toBig6(a);
    const G = toBig6(g);
    const top = (n, bits) => n >> BigInt(128 - bits);
    // The address: global unicast (2000::/3). The gateway: inside the prefix, or link-local (fe80::/10), or, said with
    // ,onlink, global unicast outside the prefix (the host's router reached on the link: Servury, measured 27 Nov 2026).
    if (top(A, 3) !== 1n) refuse6(value, `${address} is not a global unicast address (2000::/3)`);
    const linkLocal = top(G, 10) === 0x3fan;
    if (!linkLocal && top(G, 3) !== 1n) refuse6(value, `${gateway} is neither global unicast nor link-local`);
    if (A === G) refuse6(value, `the gateway ${gateway} is the address itself`);
    const inside = top(A, prefix) === top(G, prefix);
    if (onLink) {
        if (linkLocal) refuse6(value, `the gateway ${gateway} is link-local, always on the link: drop ,onlink`);
        if (inside) refuse6(value, `the gateway ${gateway} is inside ${address}/${prefix}: drop ,onlink (it is for a gateway outside the prefix)`);
    } else if (!linkLocal && !inside) {
        refuse6(value, `the gateway ${gateway} is not inside ${address}/${prefix} (nor link-local); a router outside the prefix that the`
            + ' host reaches on the link is given with ,onlink after it');
    }
    return { kind: 'static', value, address, prefix, gateway, ...(onLink ? { onLink: true } : {}) };
}

/** The default vault name: a setting, not logic. */
export const DEFAULT_VAULT_NAME = 'vault.beanpool.org';

/** A DNS name, lower case: two labels or more, each 1-63 of a-z 0-9 and inner hyphens, 253 in all; anything else throws. */
export function parseName(value) {
    const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    if (typeof value !== 'string' || value.length > 253 || value.split('.').length < 2 || !value.split('.').every((l) => label.test(l))
        || /^[0-9.]+$/.test(value)) {
        throw new Error(`--name ${JSON.stringify(value)}: not a DNS name (lower case, e.g. vault.example.org).`);
    }
    return value;
}

/**
 * The two image files with the name in them: Caddy's site line and the API's `hosts`. Each must hold the default
 * exactly once where it is expected; anything else throws, so a changed file stops the build.
 */
export function nameFiles(name, caddyfile, apiJson) {
    const site = `${DEFAULT_VAULT_NAME} {`;
    const lines = caddyfile.split('\n');
    if (lines.filter((l) => l === site).length !== 1) throw new Error(`the Caddyfile has no single "${site}" line`);
    const hosts = `"hosts": [${JSON.stringify(DEFAULT_VAULT_NAME)}],`;
    if (apiJson.split(hosts).length !== 2) throw new Error(`api.json has no single ${hosts}`);
    return {
        caddyfile: lines.map((l) => (l === site ? `${name} {` : l)).join('\n'),
        apiJson: apiJson.replace(hosts, `"hosts": [${JSON.stringify(name)}],`),
    };
}

// ─── Host profiles ──────────────────────────────────────────────────────────────────────────

const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const HOST_PROFILES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host-profiles');

function refuseProfile(name, why) {
    throw new Error(`--host ${JSON.stringify(name)}: ${why}.`);
}

function exact(o, keys, what, name) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) refuseProfile(name, `${what} is not an object`);
    const extra = Object.keys(o).filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !(k in o) && k !== 'notes');
    if (extra.length) refuseProfile(name, `${what} has fields the build does not know: ${extra.join(', ')}`);
    if (missing.length) refuseProfile(name, `${what} lacks ${missing.join(', ')}`);
}

const byte = (n) => Number.isInteger(n) && n >= 0 && n <= 255;

/**
 * A host profile, checked field by field (host-profiles/<name>.json), or `none` (no profile). Platform sev-snp only,
 * on Milan or Genoa (Turin lays its firmware levels out differently: a Turin host brings its own reader). A profile
 * whose guest policy allows debug (bit 19) or a migration agent (bit 18) is refused: the custodian's tool refuses both
 * whatever a policy says (design §2.3 row 4).
 */
export function readHostProfile(name, dir = HOST_PROFILES) {
    if (name === 'none') return { profile: 'none' };
    if (typeof name !== 'string' || !PROFILE_NAME.test(name)) refuseProfile(name, 'not a profile name');
    let p;
    try {
        p = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    } catch {
        refuseProfile(name, `no readable host-profiles/${name}.json`);
    }
    exact(p, ['profile', 'platform', 'product', 'firmware', 'launch', 'guestPolicy', 'signer', 'minTcb', 'requireAliasCheck', 'notes'], 'the profile', name);
    if (p.profile !== name) refuseProfile(name, `the file names profile ${JSON.stringify(p.profile)}`);
    if (p.platform !== 'sev-snp') refuseProfile(name, 'platform is sev-snp (the only confidential platform this build knows)');
    if (p.product !== 'Milan' && p.product !== 'Genoa') refuseProfile(name, 'product is Milan or Genoa');
    exact(p.firmware, ['name', 'url', 'sha256', 'release', 'source'], 'firmware', name);
    if (typeof p.firmware.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(p.firmware.name)) refuseProfile(name, 'firmware.name is a plain file name');
    if (typeof p.firmware.url !== 'string' || !/^https:\/\/[A-Za-z0-9./_-]+$/.test(p.firmware.url)) refuseProfile(name, 'firmware.url is an https address');
    if (typeof p.firmware.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.firmware.sha256)) refuseProfile(name, 'firmware.sha256 is a SHA-256');
    if (typeof p.firmware.release !== 'string' || typeof p.firmware.source !== 'string') refuseProfile(name, 'firmware.release and .source are text');
    exact(p.launch, ['vcpus', 'vcpuType', 'guestFeatures', 'append'], 'launch', name);
    if (!Number.isInteger(p.launch.vcpus) || p.launch.vcpus < 1 || p.launch.vcpus > 64) refuseProfile(name, 'launch.vcpus is 1 to 64');
    if (typeof p.launch.vcpuType !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(p.launch.vcpuType)) refuseProfile(name, 'launch.vcpuType is a CPU model name');
    if (typeof p.launch.guestFeatures !== 'string' || !/^0x[0-9a-f]{1,16}$/.test(p.launch.guestFeatures)) refuseProfile(name, 'launch.guestFeatures is 0x hex');
    // The UKI carries its own fixed command line; the host passes none (design §2.5: a host command line changes the
    // measurement, and the custodian's tool refuses it).
    if (p.launch.append !== '') refuseProfile(name, 'launch.append is empty: the host passes no command line');
    if (typeof p.guestPolicy !== 'string' || !/^0x[0-9a-f]{1,16}$/.test(p.guestPolicy)) refuseProfile(name, 'guestPolicy is 0x hex');
    const policy = BigInt(p.guestPolicy);
    if ((policy >> 19n) & 1n) refuseProfile(name, 'guestPolicy allows debug (bit 19)');
    if ((policy >> 18n) & 1n) refuseProfile(name, 'guestPolicy allows a migration agent (bit 18)');
    if (p.signer !== 'vcek') refuseProfile(name, 'signer is vcek (the chip\'s own key)');
    exact(p.minTcb, ['bootloader', 'tee', 'snp', 'microcode'], 'minTcb', name);
    if (!Object.values(p.minTcb).every(byte)) refuseProfile(name, 'each minTcb level is 0 to 255');
    if (typeof p.requireAliasCheck !== 'boolean') refuseProfile(name, 'requireAliasCheck is true or false');
    if (p.notes !== undefined && !(Array.isArray(p.notes) && p.notes.every((n) => typeof n === 'string'))) refuseProfile(name, 'notes is a list of text');
    return p;
}

/** 8 bytes as the report holds them (little-endian), in hex. */
function le64hex(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b.toString('hex');
}

/**
 * The release's starting host policy for this profile, this build's UKI and its computed measurement, in design §2.4's
 * shape (src/shared/release.ts HostPolicySevSnp; the custodian's chip check reads it): one host entry with this one
 * launch (`source: computed`), the profile's guest policy as the report's own 8 bytes, its firmware floor and alias-check
 * rule, and no chip yet (the first unlock on a new chip needs the custodian's --accept-new-machine; the next release
 * lists the chip). A release that keeps an older image running until its restart adds that image's launch by hand
 * (apps/vault/README.md, "The host policy").
 */
export function hostPolicy(profile, measurement, ukiSha256) {
    if (profile.profile === 'none') throw new Error('no host profile: the release\'s host policy is {"platform": "none"}');
    if (typeof measurement !== 'string' || !/^[0-9a-f]{96}$/.test(measurement)) throw new Error('the launch measurement is 48 bytes of lower-case hex');
    if (typeof ukiSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ukiSha256)) throw new Error('the UKI\'s SHA-256 is 32 bytes of lower-case hex');
    const t = profile.minTcb;
    return {
        platform: 'sev-snp', signer: profile.signer,
        hosts: [{
            profile: profile.profile, product: profile.product,
            launches: [{ ukiSha256, firmwareSha256: profile.firmware.sha256, measurement, source: 'computed' }],
            policies: [le64hex(BigInt(profile.guestPolicy))],
            minTcb: { bootloader: t.bootloader, tee: t.tee, snp: t.snp, microcode: t.microcode },
            requireAliasCheck: profile.requireAliasCheck,
            chipIds: [],
        }],
    };
}

/** The static form's etc/systemd/network/80-wan.network; null for dhcp (the image's own file stays). */
export function networkFile(network, network6 = { kind: 'ra', value: 'ra' }) {
    if (network.kind === 'dhcp') {
        if (network6.kind !== 'ra') throw new Error('--network6 static needs --network static (a host with static IPv6 and DHCP IPv4 is not one this build knows)');
        return null;
    }
    if (network6.kind === 'static') {
        // ,onlink: the IPv6 default route is its own [Route] section with GatewayOnLink=yes, the only way networkd
        // installs a route through a gateway outside every address's prefix (what the host's own `ip -6 route` shows:
        // `default via <gateway> ... onlink`). Without it, the file is the one it always was.
        const onLink = network6.onLink === true;
        return [
            `# Written by build.sh --network ${network.value} --network6 ${network6.value}, over the DHCP file: the`,
            '# host has no DHCP and sets IPv6 by hand too. The addresses are public and part of the image and its hash. The',
            '# vault\'s own resolver and time come from its config, not from the network.',
            ...(onLink ? ['# The IPv6 gateway is outside the prefix: the default route reaches it on the link (GatewayOnLink=yes).'] : []),
            '[Match]',
            'Type=ether',
            'Kind=!*',
            '',
            '[Network]',
            `Address=${network.address}/${network.prefix}`,
            `Gateway=${network.gateway}`,
            `Address=${network6.address}/${network6.prefix}`,
            ...(onLink ? [] : [`Gateway=${network6.gateway}`]),
            'IPv6AcceptRA=no',
            'LinkLocalAddressing=ipv6',
            '',
            ...(onLink ? ['[Route]', 'Destination=::/0', `Gateway=${network6.gateway}`, 'GatewayOnLink=yes', ''] : []),
        ].join('\n');
    }
    return [
        `# Written by build.sh --network ${network.value}, over the DHCP file: the host has no DHCP (1984 VPS`,
        '# #1, measured 2026-10-03). The address is public and part of the image and its hash. The vault\'s own resolver and',
        '# time come from its config, not from the network.',
        '[Match]',
        'Type=ether',
        'Kind=!*',
        '',
        '[Network]',
        `Address=${network.address}/${network.prefix}`,
        `Gateway=${network.gateway}`,
        'IPv6AcceptRA=yes',
        'LinkLocalAddressing=ipv6',
        '',
        '[IPv6AcceptRA]',
        'UseDNS=no',
        '',
    ].join('\n');
}

/**
 * image.json: {version, ukiSha256, roothash, imageHash}, and each setting only when it is not the default (so a
 * default build's file is as before): `network`, `network6`, `name`, `kernelExtra` (acpi=off), and `host`
 * ({profile, measurement}: the launch measurement this build computed for that host profile).
 */
export function imageJson({ version, ukiSha256, roothash, imageHash, network, network6, name, profile, measurement, acpiOff }) {
    return JSON.stringify({
        version, ukiSha256, roothash, imageHash,
        ...(network.kind === 'dhcp' ? {} : { network: network.value }),
        ...(network6 && network6.kind !== 'ra' ? { network6: network6.value } : {}),
        ...(name && name !== DEFAULT_VAULT_NAME ? { name } : {}),
        ...(acpiOff ? { kernelExtra: 'acpi=off' } : {}),
        ...(profile && profile.profile !== 'none' ? { host: { profile: profile.profile, measurement } } : {}),
    }, null, 2) + '\n';
}

// Run as a program: compared by real path, since build.sh names this file by its logical path (`here` is a plain pwd)
// while import.meta.url is the real one, and the two differ under a symlinked directory (macOS /tmp is one).
function isMain() {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMain()) {
    const [command, ...args] = process.argv.slice(2);
    try {
        if (command === 'check' && args.length === 1) {
            process.stdout.write(`${parseNetwork(args[0]).value}\n`);
        } else if (command === 'write' && (args.length === 2 || args.length === 3)) {
            const network = parseNetwork(args[0]);
            const text = networkFile(network, parseNetwork6(args[2] ?? 'ra'));
            if (text !== null) {
                mkdirSync(path.dirname(args[1]), { recursive: true });
                writeFileSync(args[1], text);
            }
            process.stdout.write(`${network.value}\n`);
        } else if (command === 'check6' && args.length === 1) {
            process.stdout.write(`${parseNetwork6(args[0]).value}\n`);
        } else if (command === 'check-name' && args.length === 1) {
            process.stdout.write(`${parseName(args[0])}\n`);
        } else if (command === 'write-name' && args.length === 3) {
            const name = parseName(args[0]);
            if (name !== DEFAULT_VAULT_NAME) {
                const files = nameFiles(name, readFileSync(args[1], 'utf8'), readFileSync(args[2], 'utf8'));
                writeFileSync(args[1], files.caddyfile);
                writeFileSync(args[2], files.apiJson);
            }
            process.stdout.write(`${name}\n`);
        } else if (command === 'host' && args.length === 2) {
            const p = readHostProfile(args[0]);
            const fields = {
                profile: p.profile, platform: p.platform ?? 'none',
                'firmware-name': p.firmware?.name, 'firmware-url': p.firmware?.url, 'firmware-sha256': p.firmware?.sha256,
                vcpus: p.launch?.vcpus, 'vcpu-type': p.launch?.vcpuType, 'guest-features': p.launch?.guestFeatures,
            };
            if (!Object.hasOwn(fields, args[1]) || fields[args[1]] === undefined) throw new Error(`--host ${args[0]}: no ${args[1]}`);
            process.stdout.write(`${fields[args[1]]}\n`);
        } else if (command === 'host-policy' && args.length === 3) {
            process.stdout.write(`${JSON.stringify(hostPolicy(readHostProfile(args[0]), args[1], args[2]), null, 2)}\n`);
        } else if (command === 'image-json' && (args.length === 5 || args.length === 10)) {
            const [version, ukiSha256, roothash, imageHash, net, net6 = 'ra', name = DEFAULT_VAULT_NAME, profile = 'none', measurement = '', acpi = 'acpi'] = args;
            const p = readHostProfile(profile);
            if (p.profile !== 'none' && !/^[0-9a-f]{96}$/.test(measurement)) throw new Error('image-json: a host profile needs its 48-byte launch measurement');
            if (acpi !== 'acpi' && acpi !== 'acpi-off') throw new Error('image-json: the last field is acpi or acpi-off');
            process.stdout.write(imageJson({
                version, ukiSha256, roothash, imageHash, network: parseNetwork(net), network6: parseNetwork6(net6), name: parseName(name),
                profile: p, measurement, acpiOff: acpi === 'acpi-off',
            }));
        } else {
            process.stderr.write('usage: image-settings.mjs check <network> | write <network> <file> [<network6>] | check6 <network6> | check-name <name>'
                + ' | write-name <name> <Caddyfile> <api.json> | host <profile> <field> | host-policy <profile> <measurement> <ukiSha256>'
                + ' | image-json <version> <ukiSha256> <roothash> <imageHash> <network> [<network6> <name> <profile> <measurement> <acpi|acpi-off>]\n');
            process.exit(2);
        }
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
    }
}
