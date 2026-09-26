/**
 * Frozen sign-in recovery copies: the `shares` a phone or a browser sends with a join to the global community
 * (`POST /api/join` `recovery: { shares }`) or with a deposit (`POST /api/recovery/shares/sso`). Shared by the native
 * app's test runner and the PWA's, so the two clients are held to the SAME bytes from the same inputs: the phone's
 * `sealSsoShares` / `enrolSsoKeeper` (apps/native/utils/keeper-enrolment.ts) and the browser's `sealJoinRecovery`
 * (apps/pwa/src/lib/join-recovery.ts). One opener then opens both, whichever client restores.
 *
 * ## Random by design, and fixed here
 *
 * Three values in a copy are drawn at random every time it is made: `kdfParams.salt` (32 bytes, the scrypt salt),
 * `shareIv` (the seed box's 24-byte nonce) and `kdfParams.words.iv` (the words box's 24-byte nonce). Everything that
 * depends on them (`encryptedShare`, `shareTag`, `words.ct`, `words.tag`) changes with them. A test pins them by
 * standing {@link seededGetRandomValues} in for `crypto.getRandomValues` while one copy is made: then every field is
 * fixed and the bodies compare byte for byte, the random ones included.
 *
 * How they were made: the phone's own `sealSsoShares`, run once under the seeded source for each vector (the phone
 * holding the raw 32-byte seed, as it does), and the output pasted here. Never regenerate them to make a client pass:
 * a client that no longer builds these bytes has changed the format every node already stores.
 *
 * The words are a BIP-39 test phrase, never a real account's. The key is the one the apps make from them
 * (seed = SHA-256(SHA-256(words))). Kept out of the main index (import `@beanpool/core/sso-share-vectors`) so no app
 * bundle carries it unless a test imports it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** A test phrase (a BIP-39 vector), and the key both apps make from it. */
export const SSO_SHARE_VECTOR_WORDS: readonly string[] = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
/** SHA-256(SHA-256("abandon ability … accident")): the raw seed, as the phone keeps it. */
export const SSO_SHARE_VECTOR_SEED_HEX = '9ade119b8b28c151c1758eab14eb984d144883f319d08197b224f7f9b92e637b';
/** The same seed in the 48-byte PKCS8 form the browser keeps it in (a 16-byte header, then the seed). */
export const SSO_SHARE_VECTOR_PKCS8_HEX = '302e020100300506032b6570042204209ade119b8b28c151c1758eab14eb984d144883f319d08197b224f7f9b92e637b';
export const SSO_SHARE_VECTOR_PUBLIC_KEY = '2c984dac86ce43aef51c4875274d268fa69e14ae8145efdeff99716620edb4e9';

/** One sealed piece as the wire carries it (`recovery.shares[0]`). */
export interface SsoShareVectorShare {
    holderType: 'sso';
    holderRef: string;
    shareIndex: 1;
    encryptedShare: string;
    shareIv: string;
    shareTag: string;
    kdfParams: string;
}

export interface SsoShareVector {
    /** Also the label the seeded random source is made from. */
    name: string;
    provider: 'google' | 'apple' | 'github';
    /** The provider's subject claim (Google's 21 digits, Apple's dotted id, GitHub's numeric user id). */
    sub: string;
    /** Whether the 12 words are sealed with the seed (a key brought here without them seals the seed alone). */
    withWords: boolean;
    shares: SsoShareVectorShare[];
}

export const SSO_SHARE_VECTORS: readonly SsoShareVector[] = [
    {
        name: 'google, with the words',
        provider: 'google',
        sub: '104857600000000000001',
        withWords: true,
        shares: [{
            holderType: 'sso', holderRef: 'google', shareIndex: 1,
            encryptedShare: 'JgLLOxnT4LzH8+uVV4NQEy+DaXaSCSxNbxVGu1nL7sM=',
            shareIv: 'w9uYm9L+HFeTqAhtbS7oEVVYeE/gKcbN',
            shareTag: 'BaUA6wyHZgWBXhxTmFwBFg==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"Y25BbiSy2xkQED4mmClc7/yBDdtUOpPZR0hoFFDheT0=","N":16384,"r":8,"p":1,"words":{"alg":"bip39-bits-xc20p-v1","iv":"/SKBbwvSirYr8ZYt4zPQPoBJoTTZ6x4O","ct":"xgjtRvUrDR2jN41pOGP7J0c=","tag":"DUoWOpAtuEgr93NmL+aIAg=="}}',
        }],
    },
    {
        name: 'apple, with the words',
        provider: 'apple',
        sub: '001234.0123456789abcdef0123456789abcdef.1234',
        withWords: true,
        shares: [{
            holderType: 'sso', holderRef: 'apple', shareIndex: 1,
            encryptedShare: '3a61C7UwKByVCjUSEWyBLCQ5xbbP29fuQvD+IUN7NFY=',
            shareIv: '7smfZ82Pc3kVwfGyzAZxahttyz1H4i7a',
            shareTag: 'p7kI4sTwKEyOHawPaiIuuQ==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"T9hjiWhwZ/P7F/1rKepP0E3jTK5qQhrTYz4GdjMuJKA=","N":16384,"r":8,"p":1,"words":{"alg":"bip39-bits-xc20p-v1","iv":"cRQ4zc384/eT45CPxCAfg23yz1GaeM/V","ct":"73MR8XrTdfZKYPiA3BIV5/M=","tag":"UTwQ86WLkTeUi230Eoa4XQ=="}}',
        }],
    },
    {
        name: 'github, with the words',
        provider: 'github',
        sub: '24680',
        withWords: true,
        shares: [{
            holderType: 'sso', holderRef: 'github', shareIndex: 1,
            encryptedShare: 'ob58FryEwm+M88yGwrmSRu5waQu7NA7UPChJkkWBbkw=',
            shareIv: 'MyL/lEeb+X7lhy427qveU1V+BQRCQdKl',
            shareTag: 'AsmZKy1/2avOelgCZR4vZQ==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"dwrvD7bQS++I79+ELMH+T1QqL1rnaSt0h0AG1qCflfw=","N":16384,"r":8,"p":1,"words":{"alg":"bip39-bits-xc20p-v1","iv":"jhlCesRuXGPJprHcv9q5XCniC0zhX483","ct":"6t0Qngprm2ZVqK5L6bvBMe8=","tag":"+iRpS2efwC8JwQjxIIhDaw=="}}',
        }],
    },
    {
        name: 'google, a key without its words',
        provider: 'google',
        sub: '104857600000000000001',
        withWords: false,
        shares: [{
            holderType: 'sso', holderRef: 'google', shareIndex: 1,
            encryptedShare: 'l81uOwy6GYGBw8usNXhyD0YlL+Fs9yIGmiJ3qBzXfI0=',
            shareIv: 'KXm1vjJXegN+9X7Bb7Y3hwwtGvAaRuX6',
            shareTag: 'm+/0s/iEzLC+VhF4GhIEOw==',
            kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"Eds4w1Lhx/7rrb4gsc0ngNW9TKJlUsp+Sd0rTyZ0nJs=","N":16384,"r":8,"p":1}',
        }],
    },
];

/**
 * A stand-in for `crypto.getRandomValues` that hands out a fixed stream: SHA-256(label ‖ counter), block after
 * block, in the order it is asked. Fresh for each copy made, so the same label gives the same copy.
 */
export function seededGetRandomValues(label: string): <T extends ArrayBufferView | null>(array: T) => T {
    let block = 0;
    let buffered: Uint8Array = new Uint8Array(0);
    return <T extends ArrayBufferView | null>(array: T): T => {
        if (!array) return array;
        const out = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        while (buffered.length < out.length) {
            const counter = new Uint8Array(4);
            new DataView(counter.buffer).setUint32(0, block++);
            buffered = concatBytes(buffered, sha256(concatBytes(utf8ToBytes(`beanpool sso share vector: ${label}`), counter)));
        }
        out.set(buffered.subarray(0, out.length));
        buffered = buffered.slice(out.length);
        return array;
    };
}
