/**
 * A bare public IPv4 address gets https://, wherever the phone gives a typed or linked address its scheme (#2106's
 * deciding review). normalizeNodeUrl (utils/node-url.ts, #2106) is one place; these are the other three, which used to
 * pick http:// for every bare IPv4 address and for anything starting `localhost`:
 *
 *   - Settings' "Add & Connect" (app/(tabs)/settings.tsx handleUpdateAnchor),
 *   - the address typed beside an invite on People (app/(tabs)/people.tsx handleRedeem, through redeemTargetUrl),
 *   - a deep link's `server=` (utils/invite-parser.ts deepLinkNodeOrigin).
 *
 * The cleartext rule (core shouldBlockCleartextNodeUrl) refuses http:// to a public host, so a node on a public IP was
 * saved under an address every request then failed on. Now each takes its scheme from withNodeScheme
 * (utils/node-address-scheme.ts): http:// only for localhost and a private/LAN IPv4 address, https:// for the rest. A
 * typed scheme is kept and the cleartext rule still decides. The screens can't run here (vitest.config.ts), so the
 * last block reads their source: each caller takes its address from the helper and spells no scheme of its own.
 *
 * Nothing here contacts a node.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { shouldBlockCleartextNodeUrl } from '@beanpool/core';
import { isPlainNodeAddress } from '../node-url';
import { withNodeScheme } from '../node-address-scheme';
import { deepLinkNodeOrigin, redeemTargetUrl } from '../invite-parser';

/** [typed, the address it becomes]. */
type Row = [string, string];

const PUBLIC_IPV4: Row[] = [
    ['203.0.113.7', 'https://203.0.113.7'],
    ['203.0.113.7:8443', 'https://203.0.113.7:8443'],
    ['8.8.8.8:80', 'https://8.8.8.8:80'],
    [' 198.51.100.20:3000 ', 'https://198.51.100.20:3000'],
    // Just outside the private ranges core's isPrivateHost reads.
    ['172.15.255.255', 'https://172.15.255.255'],
    ['172.32.0.1:8080', 'https://172.32.0.1:8080'],
    ['192.169.1.1', 'https://192.169.1.1'],
    ['169.255.0.1', 'https://169.255.0.1'],
    ['11.0.0.1', 'https://11.0.0.1'],
];

const PRIVATE: Row[] = [
    ['10.0.0.5', 'http://10.0.0.5'],
    ['10.1.2.3:8080', 'http://10.1.2.3:8080'],
    ['172.16.0.1', 'http://172.16.0.1'],
    ['172.31.255.255:3000', 'http://172.31.255.255:3000'],
    ['192.168.1.5:8080', 'http://192.168.1.5:8080'],
    ['127.0.0.1', 'http://127.0.0.1'],
    ['127.0.0.1:8443', 'http://127.0.0.1:8443'],
    ['169.254.1.1', 'http://169.254.1.1'],
    ['localhost', 'http://localhost'],
    ['localhost:8080', 'http://localhost:8080'],
];

const HOSTNAMES: Row[] = [
    ['mullum.beanpool.org', 'https://mullum.beanpool.org'],
    ['beans.mycommunity.nz:8443', 'https://beans.mycommunity.nz:8443'],
    // They start like localhost or a LAN address, and are neither.
    ['localhost.attacker.com', 'https://localhost.attacker.com'],
    ['10.0.0.5.attacker.com', 'https://10.0.0.5.attacker.com'],
    // A name starting "http" is a name, not a scheme.
    ['httppool.example.org', 'https://httppool.example.org'],
];

/** The cleartext rule can't tell a public IPv6 literal from a private one (it lets every one through), so none gets http://. */
const IPV6: Row[] = [
    ['[2001:db8::7]', 'https://[2001:db8::7]'],
    ['[2001:db8::7]:8443', 'https://[2001:db8::7]:8443'],
    ['[fd00::5]:8080', 'https://[fd00::5]:8080'],
    ['[::1]:8443', 'https://[::1]:8443'],
];

const TABLE: { kind: string; rows: Row[] }[] = [
    { kind: 'a public IPv4 address, with or without a port, gets https://', rows: PUBLIC_IPV4 },
    { kind: 'localhost and a private/LAN IPv4 address get http://', rows: PRIVATE },
    { kind: 'a host name gets https://', rows: HOSTNAMES },
    { kind: 'a bracketed IPv6 address gets https://', rows: IPV6 },
];

/**
 * Typed with a scheme: kept, in lower case. [typed, the address, whether the cleartext rule refuses it]: a typed http://
 * to a public host stays http://, and the rule refuses it as before.
 */
const TYPED: [string, string, boolean][] = [
    ['http://203.0.113.7:8443', 'http://203.0.113.7:8443', true],
    ['HTTP://203.0.113.7', 'http://203.0.113.7', true],
    ['http://192.168.1.5:8080', 'http://192.168.1.5:8080', false],
    ['https://192.168.1.5:8443', 'https://192.168.1.5:8443', false],
    ['Https://mullum.beanpool.org', 'https://mullum.beanpool.org', false],
];

const INVITE = 'INV-ABCD-EFGH';
const HERE = 'https://global.beanpool.org';
const LINK = `beanpool://join?invite=${INVITE}`;

const CALLERS: { caller: string; resolve: (typed: string) => string | null }[] = [
    { caller: 'Settings → "Add & Connect" (settings.tsx handleUpdateAnchor)', resolve: (typed) => withNodeScheme(typed) },
    { caller: 'People → the address typed beside an invite (people.tsx handleRedeem)', resolve: (typed) => redeemTargetUrl(INVITE, typed, HERE) },
    { caller: 'a deep link\'s server= (invite-parser.ts deepLinkNodeOrigin)', resolve: (typed) => deepLinkNodeOrigin(LINK, () => typed) },
    { caller: 'a deep link\'s server=, URL-encoded', resolve: (typed) => deepLinkNodeOrigin(LINK, () => encodeURIComponent(typed)) },
];

describe.each(CALLERS)('$caller', ({ resolve }) => {
    describe.each(TABLE)('$kind', ({ rows }) => {
        it.each(rows)('%s → %s', (typed, want) => {
            const got = resolve(typed);
            expect(got).toBe(want);
            // Each is a plain address the caller's own check passes, and none is one the cleartext rule then refuses.
            expect(isPlainNodeAddress(got)).toBe(true);
            expect(shouldBlockCleartextNodeUrl(got!)).toBe(false);
        });
    });

    it.each(TYPED)('a typed scheme is kept: %s → %s (refused over cleartext: %s)', (typed, want, refused) => {
        const got = resolve(typed);
        expect(got).toBe(want);
        expect(shouldBlockCleartextNodeUrl(got!)).toBe(refused);
    });
});

describe('People: the invite\'s own address still comes first, and the current community last', () => {
    it.each([
        // The invite names its community: what is typed beside it is not read.
        [`https://mullum.beanpool.org/?invite=${INVITE}`, '203.0.113.7', 'https://mullum.beanpool.org'],
        [`Join my BeanPool community node: https://203.0.113.7:8443/?invite=${INVITE}`, '', 'https://203.0.113.7:8443'],
        // Nothing typed: the community the phone is on.
        [INVITE, '', HERE],
        [INVITE, '   ', HERE],
        [INVITE, '203.0.113.7:8443', 'https://203.0.113.7:8443'],
    ])('%s with %j typed → %s', (invite, typed, want) => {
        expect(redeemTargetUrl(invite, typed, HERE)).toBe(want);
    });
});

describe('withNodeScheme', () => {
    it('is blank for a blank input, as each caller expects', () => {
        expect(withNodeScheme('')).toBe('');
        expect(withNodeScheme('  \n')).toBe('');
        expect(deepLinkNodeOrigin(LINK, () => encodeURIComponent('  '))).toBeNull();
    });
});

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components', 'services', 'utils'];

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === '__tests__' || e.name === 'node_modules') continue;
                walk(p);
            } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
                out.push(p);
            }
        }
    };
    for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    return out;
}

/** The text of the function named `name` in `file`: declared, or an arrow/function held by a const. '' when there is none. */
function functionText(file: string, name: string): string {
    const abs = path.join(ROOT, file);
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let found = '';
    const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(sf);
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
            && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) found = node.initializer.getText(sf);
        else ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

describe('each caller takes its scheme from withNodeScheme, and spells none of its own', () => {
    it.each([
        { file: 'app/(tabs)/settings.tsx', fn: 'handleUpdateAnchor', uses: /const finalAnchorUrl = withNodeScheme\(newAnchorInput\);/ },
        { file: 'app/(tabs)/people.tsx', fn: 'handleRedeem', uses: /const targetNodeUrl = redeemTargetUrl\(rawInvite, redeemNodeUrl, anchorUrl\);/ },
        { file: 'utils/invite-parser.ts', fn: 'redeemTargetUrl', uses: /withNodeScheme\(typedNodeUrl\)/ },
        { file: 'utils/invite-parser.ts', fn: 'deepLinkNodeOrigin', uses: /withNodeScheme\(decodeURIComponent\(raw\)\)/ },
    ])('$file $fn', ({ file, fn, uses }) => {
        const text = functionText(file, fn);
        expect(text, `${file} ${fn} not found`).not.toBe('');
        expect(text).toMatch(uses);
        expect(text).not.toMatch(/(['"`])https?:\/\/\1/);
    });

    it('no other phone source tests for a bare IPv4 address to choose a scheme', () => {
        // The test each of the three carried. normalizeNodeUrl (node-url.ts) has its own, with the same rule from #2106.
        const IPV4_TEST = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
        const ALLOWED = ['utils/node-address-scheme.ts', 'utils/node-url.ts'];
        const copies = sourceFiles()
            .filter((f) => fs.readFileSync(f, 'utf8').includes(IPV4_TEST))
            .map((f) => path.relative(ROOT, f))
            .filter((f) => !ALLOWED.includes(f));
        expect(copies).toEqual([]);
    });
});
