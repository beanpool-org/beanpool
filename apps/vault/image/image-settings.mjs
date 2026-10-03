// The image build's settings that change the image (build.sh): the host network, and image.json, which records it.
//
//   node image/image-settings.mjs check <network>          prints the setting back, or refuses (exit 2) and says why
//   node image/image-settings.mjs write <network> <file>   writes the static form's network file (nothing for dhcp)
//   node image/image-settings.mjs image-json <version> <ukiSha256> <roothash> <imageHash> <network>
//
// <network> is `dhcp` (the default: the image's own etc/systemd/network/80-wan.network, untouched, so the image is
// byte for byte what it was before the setting existed) or `static:<ipv4>/<prefix>,<gateway>` for a host that hands
// out no address (1984 VPS #1: measured 2026-10-03, no DHCP lease; its Debian has a static address). The static form
// writes 80-wan.network over the DHCP one, with router advertisements kept for IPv6. The setting is public and part
// of the image and its hash: image.json records it, and a rebuild for the comparison passes the same one.
//
// The firewall (etc/nftables.conf) keeps its DHCP rules in both forms: they only let networkd's client send to the
// DHCP ports, and with a static address networkd sends nothing there, so they are harmless. Leaving the file alone
// keeps the dhcp image the same bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
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
    const first = a >>> 24;
    if (first === 0 || first === 127 || first >= 224) refuse(value, `${address} is not a host's unicast address`);
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

/** The static form's etc/systemd/network/80-wan.network; null for dhcp (the image's own file stays). */
export function networkFile(network) {
    if (network.kind === 'dhcp') return null;
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

/** image.json: {version, ukiSha256, roothash, imageHash}, and `network` unless it is dhcp (so a dhcp build's file is as before). */
export function imageJson({ version, ukiSha256, roothash, imageHash, network }) {
    return JSON.stringify({ version, ukiSha256, roothash, imageHash, ...(network.kind === 'dhcp' ? {} : { network: network.value }) }, null, 2) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    let network;
    try {
        network = parseNetwork(command === 'image-json' ? args[4] : args[0]);
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
    }
    if (command === 'check' && args.length === 1) {
        process.stdout.write(`${network.value}\n`);
    } else if (command === 'write' && args.length === 2) {
        const text = networkFile(network);
        if (text !== null) {
            mkdirSync(path.dirname(args[1]), { recursive: true });
            writeFileSync(args[1], text);
        }
    } else if (command === 'image-json' && args.length === 5) {
        const [version, ukiSha256, roothash, imageHash] = args;
        process.stdout.write(imageJson({ version, ukiSha256, roothash, imageHash, network }));
    } else {
        process.stderr.write('usage: image-settings.mjs check <network> | write <network> <file> | image-json <version> <ukiSha256> <roothash> <imageHash> <network>\n');
        process.exit(2);
    }
}
