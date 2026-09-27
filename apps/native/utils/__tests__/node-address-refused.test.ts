/**
 * A community address the phone uses must name exactly the host it connects to (#1224 review 4113495290).
 *
 * Core's `audienceOf` ends the host at `\`, as browsers and Android's OkHttp do. iOS's NSURL, under React Native's
 * fetch and WebSocket, percent-encodes the `\` and reads everything before the last `@` as a login. So
 * `https://127.0.0.1\@evil.test/` is signed for 127.0.0.1 and sent to evil.test. Such an address is refused by every
 * builder (request-binding.test.ts). Here: by the check itself (node-url.ts `isPlainNodeAddress`), and by every path
 * that makes an address the phone's community or saves it. That covers invite links and pasted invites, deep links,
 * People's "Join another community", saved communities and the fetch wrapper. The screens that switch community
 * (Settings, the switcher, the wrong-community screen) are held to it by request-binding-source-rule.test.ts.
 *
 * Nothing here contacts a node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('@noble/ed25519', async (orig) => {
    const real = await orig<typeof import('@noble/ed25519')>();
    return { ...real, sign: vi.fn(real.sign) };
});
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { sign as memberKeySign } from '@noble/ed25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { isPlainNodeAddress, looksLikeNodeAddress, UnsafeNodeAddressError, UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import { deepLinkNodeOrigin, extractNodeOrigin } from '../invite-parser';
import { joinAnotherCommunity, type JoinDeps } from '../join-another-community';
import { addSavedNode, getSavedNodes } from '../nodes';
import { installNodeRequestSigning } from '../node-request-signing';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import type { BeanPoolIdentity } from '../identity';

const SEED = new Uint8Array(32).fill(5);
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const identity = { publicKey: PUB, privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Kim', createdAt: '' } as BeanPoolIdentity;
const ANCHOR = 'beanpool_anchor_url';

/** The reviewer's two addresses (#1224 review 4113495290), and the variants the director named. */
const TABLE = ['https://127.0.0.1\\@evil.test', 'https://mullum.beanpool.org\\@evil.test'];
const REFUSED = [
    ...TABLE,
    'https://user@a.test',
    'https://user:pass@a.test',
    'https://a.test@evil.test',
    'https://a.test\\@x',
    'https://a.test\\evil.test',
    'https://127.0.0.1%5C@evil.test',
    'https://a.test%5C.evil.test',
    'https://a.test%40evil.test',
    'https://a.test\t@evil.test',
    'https://a.test @evil.test',
    'https://a.te\tst',
    'https://a.test\n',
    'https://a.test\u0000',
    ' https://a.test',
    'https://a.test:8443\\@evil.test',
    'https://a.test:123456',
    'https://a.test:',
    'https://[::1]@evil.test',
    'https://[fe80::1%25en0]',
    'https://a.test?x@evil.test/',
    'https://a.test#@evil.test/',
    'https://a.test.',
    'https:///a.test',
    'https:\\\\a.test',
    'ftp://a.test',
    '//a.test',
    'a.test',
];
/** Every form of address the app uses: registrar names, custom domains, IPv4 (the emulator's 10.0.2.2 too), .local, IPv6. */
const REAL = [
    'https://mullum.beanpool.org',
    'https://global.beanpool.org',
    'https://Mullum.BeanPool.org',
    'https://beans.mycommunity.nz',
    'https://beans.mycommunity.nz:8443',
    'http://127.0.0.1:8080',
    'https://127.0.0.1:8443',
    'http://10.0.2.2:8080',
    'https://10.0.2.2:8443',
    'http://192.168.1.10:8443',
    'http://localhost:8080',
    'https://localhost:8443',
    'https://beanpool.local:8443',
    'http://beanpool.local:8080',
    'http://mynode:8080',
    'http://[::1]:8080',
    'https://[fe80::1]',
    'wss://mullum.beanpool.org/ws',
    'ws://10.0.2.2:8080/ws',
    'https://mullum.beanpool.org/',
    'https://mullum.beanpool.org/api/x@y?who=a@b&back=c\\d#e@f',
];

beforeEach(() => {
    mem.clear();
    who.identity = null;
    vi.mocked(memberKeySign).mockClear();
});

describe('the check: the authority is exactly host[:port]', () => {
    it('refuses a login, a backslash, whitespace, control or percent-encoded characters, and a ? or # before the first /', () => {
        for (const url of REFUSED) expect(isPlainNodeAddress(url), JSON.stringify(url)).toBe(false);
        for (const url of [...REFUSED, ...REFUSED.map(u => `${u}/api/x`)]) {
            expect(isPlainNodeAddress(url), JSON.stringify(url)).toBe(false);
        }
    });

    it('accepts every address form the app uses, and anything in the path after the first /', () => {
        for (const url of REAL) expect(isPlainNodeAddress(url), url).toBe(true);
    });

    it('looksLikeNodeAddress, which the typed-address screens use, is at least as strict', () => {
        for (const url of REFUSED) expect(looksLikeNodeAddress(url), JSON.stringify(url)).toBe(false);
        expect(looksLikeNodeAddress('https://mullum.beanpool.org')).toBe(true);
        expect(looksLikeNodeAddress('http://10.0.2.2:8080')).toBe(true);
        expect(looksLikeNodeAddress('http://localhost:8080')).toBe(true);
    });
});

describe('invite links and pasted invites', () => {
    // In a message, whitespace, `/`, `?` and `#` end an address, so these are every refused authority an invite can carry.
    const IN_AN_INVITE = [
        ...TABLE,
        'https://user@a.test',
        'https://user:pass@a.test',
        'https://a.test@evil.test',
        'https://a.test\\@x',
        'https://a.test\\evil.test',
        'https://127.0.0.1%5C@evil.test',
        'https://a.test%5C.evil.test',
        'https://a.test%40evil.test',
        'https://a.test\u0000',
        'https://a.test:8443\\@evil.test',
        'https://a.test:123456',
        'https://[::1]@evil.test',
        'https://[fe80::1%25en0]',
        'HTTPS://127.0.0.1\\@evil.test',
    ];

    it('an invite naming such an address is refused, not read as "no address" (which would use the current community)', () => {
        for (const origin of IN_AN_INVITE) {
            for (const raw of [`${origin}/?invite=INV-ABCD-EFGH`, `Join my BeanPool community node: ${origin}/join?invite=INV-ABCD-EFGH`]) {
                expect(() => extractNodeOrigin(raw), raw).toThrow(UnsafeNodeAddressError);
            }
        }
        expect(() => extractNodeOrigin('https://127.0.0.1\\@evil.test/?invite=INV-ABCD-EFGH')).toThrow(UNSAFE_NODE_ADDRESS_MESSAGE);
    });

    it('reads a plain address exactly as before, from a link or a message, and null when there is none', () => {
        expect(extractNodeOrigin('https://mullum.beanpool.org/?invite=INV-ABCD-EFGH')).toBe('https://mullum.beanpool.org');
        expect(extractNodeOrigin('Join my BeanPool community node: https://beans.mycommunity.nz:8443/join?invite=X')).toBe('https://beans.mycommunity.nz:8443');
        expect(extractNodeOrigin('Node URL: http://10.0.2.2:8080')).toBe('http://10.0.2.2:8080');
        expect(extractNodeOrigin('http://[::1]:8080/?invite=INV-ABCD-EFGH')).toBe('http://[::1]:8080');
        expect(extractNodeOrigin('Come to https://mullum.beanpool.org.')).toBe('https://mullum.beanpool.org');
        // Whitespace ends an address in a message; what follows it is the message, not a login.
        expect(extractNodeOrigin('https://mullum.beanpool.org @evil.test')).toBe('https://mullum.beanpool.org');
        // An @ after the first / is path.
        expect(extractNodeOrigin('https://mullum.beanpool.org/@evil.test?invite=INV-ABCD-EFGH')).toBe('https://mullum.beanpool.org');
        expect(extractNodeOrigin('INV-ABCD-EFGH')).toBeNull();
        expect(extractNodeOrigin('BP-eyJwIjoieCJ9')).toBeNull();
    });
});

describe('the deep link\'s "Switch Nodes?" (app/_layout.tsx)', () => {
    const noServer = () => undefined;

    it('refuses such an address in the link itself', () => {
        for (const origin of TABLE) {
            expect(() => deepLinkNodeOrigin(`${origin}/?invite=INV-ABCD-EFGH`, noServer)).toThrow(UnsafeNodeAddressError);
            expect(() => deepLinkNodeOrigin(`beanpool://join?invite=INV-ABCD-EFGH&server=${origin}`, noServer)).toThrow(UnsafeNodeAddressError);
        }
    });

    it('and in its server= value, encoded or not, with or without a scheme', () => {
        const link = 'beanpool://join?invite=INV-ABCD-EFGH&server=x';
        for (const server of [
            ...TABLE.map(encodeURIComponent),
            '127.0.0.1\\@evil.test',
            'mullum.beanpool.org%5C%40evil.test',
            encodeURIComponent('user@mullum.beanpool.org'),
            encodeURIComponent('mullum.beanpool.org\t@evil.test'),
            encodeURIComponent('https://mullum.beanpool.org?x@evil.test/'),
        ]) {
            expect(() => deepLinkNodeOrigin(link, () => server), server).toThrow(UnsafeNodeAddressError);
        }
    });

    it('a plain one is taken exactly as before', () => {
        const link = 'beanpool://join?invite=INV-ABCD-EFGH';
        expect(deepLinkNodeOrigin('https://mullum.beanpool.org/?invite=INV-ABCD-EFGH', () => { throw new Error('not read'); }))
            .toBe('https://mullum.beanpool.org');
        expect(deepLinkNodeOrigin(link, () => 'mullum.beanpool.org')).toBe('https://mullum.beanpool.org');
        expect(deepLinkNodeOrigin(link, () => encodeURIComponent('https://beans.mycommunity.nz:8443'))).toBe('https://beans.mycommunity.nz:8443');
        expect(deepLinkNodeOrigin(link, () => '192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
        expect(deepLinkNodeOrigin(link, () => 'localhost:8080')).toBe('http://localhost:8080');
        expect(deepLinkNodeOrigin(link, () => undefined)).toBeNull();
        expect(deepLinkNodeOrigin(link, () => '  ')).toBeNull();
    });
});

describe('People → "Join another community" (utils/join-another-community.ts)', () => {
    function deps(): JoinDeps {
        return {
            closeDB: vi.fn(async () => {}),
            initDB: vi.fn(async () => {}),
            redeemInvite: vi.fn(async () => ({ success: true as const, alreadyMember: false, nodeHasPhoto: false })),
            addSavedNode: vi.fn(async () => {}),
            clearGuestNode: vi.fn(async () => {}),
            requestSync: vi.fn(async () => {}),
        };
    }

    it('the pasted invite is refused before anything moves', () => {
        // People reads the address with extractNodeOrigin before it calls joinAnotherCommunity.
        for (const origin of TABLE) expect(() => extractNodeOrigin(`${origin}/?invite=INV-ABCD-EFGH`)).toThrow(UnsafeNodeAddressError);
    });

    it('and so is such a target however it arrives: the phone stays where it was, nothing redeemed or saved', async () => {
        for (const targetUrl of [...TABLE, 'https://user@mullum.beanpool.org', 'https://mullum.beanpool.org%5C@evil.test']) {
            mem.set(ANCHOR, 'https://global.beanpool.org');
            const d = deps();
            vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted'); }));
            await expect(joinAnotherCommunity({ targetUrl, code: 'INV-ABCD-EFGH', identity, returnUrl: 'https://global.beanpool.org' }, d), targetUrl)
                .rejects.toBeInstanceOf(UnsafeNodeAddressError);
            expect(mem.get(ANCHOR)).toBe('https://global.beanpool.org');
            expect(d.closeDB).not.toHaveBeenCalled();
            expect(d.redeemInvite).not.toHaveBeenCalled();
            expect(d.addSavedNode).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        }
    });

    it('a failed redeem never puts the phone back on such an address either', async () => {
        const d = deps();
        d.redeemInvite = vi.fn(async () => { throw new Error('Invite already used'); });
        await expect(joinAnotherCommunity({ targetUrl: 'https://mullum.beanpool.org', code: 'INV-ABCD-EFGH', identity, returnUrl: TABLE[0] }, d))
            .rejects.toThrow('Invite already used');
        expect(mem.has(ANCHOR)).toBe(false);
    });
});

describe('the phone\'s saved communities (utils/nodes.ts)', () => {
    it('addSavedNode refuses such an address and saves nothing', async () => {
        for (const url of TABLE) await expect(addSavedNode(url), url).rejects.toBeInstanceOf(UnsafeNodeAddressError);
        expect(mem.has(SAVED_NODES_STORE_KEY)).toBe(false);
        await addSavedNode('https://mullum.beanpool.org', 'Mullum');
        expect((await getSavedNodes()).map(n => n.url)).toEqual(['https://mullum.beanpool.org']);
    });

    it('an anchor like that is never copied into the list', async () => {
        mem.set(ANCHOR, TABLE[1]);
        expect(await getSavedNodes()).toEqual([]);
        expect(mem.has(SAVED_NODES_STORE_KEY)).toBe(false);
    });
});

describe('the fetch wrapper (utils/node-request-signing.ts)', () => {
    it('fails a request to such an address rather than send it unsigned, and still signs a plain one', async () => {
        mem.set(ANCHOR, 'https://mullum.beanpool.org');
        who.identity = identity;
        const underlying = vi.fn(async (_input: string, init?: RequestInit) => ({ ok: true, status: 200, headers: init?.headers } as unknown as Response));
        (globalThis as any).fetch = underlying;
        installNodeRequestSigning();

        await expect(fetch('https://mullum.beanpool.org\\@evil.test/api/community/me')).rejects.toBeInstanceOf(UnsafeNodeAddressError);
        expect(underlying).not.toHaveBeenCalled();
        expect(memberKeySign).not.toHaveBeenCalled();

        await fetch('https://mullum.beanpool.org/api/community/me');
        expect(underlying).toHaveBeenCalledTimes(1);
        expect((underlying.mock.calls[0][1]?.headers as Record<string, string>)['X-Signed-For']).toBe('mullum.beanpool.org');
    });
});
