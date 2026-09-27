import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { getPublicKey, sign, verify, etc, hashes } from '@noble/ed25519';
import * as Crypto from 'expo-crypto';
import { WORDLIST } from '../../pwa/src/lib/bip39-wordlist';
import {
    toEd25519Seed, audienceOf, buildBoundRequestHeaders, buildBoundWsParams, unboundRequestText, signedPathOf, utf8Bytes, toBase64,
    type Signer,
} from '@beanpool/core';
import { requestSigningFormatFor } from './request-signing-version';
import { assertPlainNodeAddress } from './node-url';

if (typeof global.crypto !== 'object') {
    (global as any).crypto = {};
}
if (typeof global.crypto.getRandomValues !== 'function') {
    // @ts-expect-error - React Native global polyfill type mismatch
    global.crypto.getRandomValues = (array: Uint8Array) => {
        const randomBytes = Crypto.getRandomBytes(array.length);
        array.set(randomBytes);
        return array;
    };
}

hashes.sha512 = (...m) => sha512(etc.concatBytes(...m));
hashes.sha512Async = (...m) => Promise.resolve(hashes.sha512!(...m));

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64lookup = new Uint8Array(256);
for (let i = 0; i < b64chars.length; i++) b64lookup[b64chars.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array): string {
    let result = '';
    let i;
    const l = bytes.length;
    for (i = 2; i < l; i += 3) {
        result += b64chars[bytes[i - 2] >> 2];
        result += b64chars[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
        result += b64chars[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)];
        result += b64chars[bytes[i] & 0x3f];
    }
    if (i === l + 1) { // 1 byte remain
        result += b64chars[bytes[i - 2] >> 2];
        result += b64chars[(bytes[i - 2] & 0x03) << 4];
        result += '==';
    }
    if (i === l) { // 2 bytes remain
        result += b64chars[bytes[i - 2] >> 2];
        result += b64chars[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
        result += b64chars[(bytes[i - 1] & 0x0f) << 2];
        result += '=';
    }
    return result;
}

export function decodeBase64(b64: string): Uint8Array {
    let bufferLength = b64.length * 0.75;
    const len = b64.length;
    let p = 0;
    let encoded1, encoded2, encoded3, encoded4;
    if (b64[b64.length - 1] === '=') { bufferLength--; if (b64[b64.length - 2] === '=') bufferLength--; }
    const bytes = new Uint8Array(bufferLength);
    for (let i = 0; i < len; i += 4) {
        encoded1 = b64lookup[b64.charCodeAt(i)];
        encoded2 = b64lookup[b64.charCodeAt(i + 1)];
        encoded3 = b64lookup[b64.charCodeAt(i + 2)];
        encoded4 = b64lookup[b64.charCodeAt(i + 3)];
        bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
        bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
        bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
    return bytes;
}

export function encodeUtf8(str: string): Uint8Array {
    const utf8 = [];
    for (let i = 0; i < str.length; i++) {
        let charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
            utf8.push(0xc0 | (charcode >> 6),
                0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
            utf8.push(0xe0 | (charcode >> 12),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f));
        }
        else {
            i++;
            charcode = 0x10000 + (((charcode & 0x3ff) << 10)
                | (str.charCodeAt(i) & 0x3ff));
            utf8.push(0xf0 | (charcode >> 18),
                0x80 | ((charcode >> 12) & 0x3f),
                0x80 | ((charcode >> 6) & 0x3f),
                0x80 | (charcode & 0x3f));
        }
    }
    return new Uint8Array(utf8);
}

export function decodeUtf8(bytes: Uint8Array): string {
    let str = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 128) {
            str += String.fromCharCode(b);
        } else if (b > 191 && b < 224) {
            str += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
            i++;
        } else if (b > 223 && b < 240) {
            str += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
            i += 2;
        } else {
            let cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
            cp -= 0x10000;
            str += String.fromCharCode(0xD800 | (cp >> 10), 0xDC00 | (cp & 0x3FF));
            i += 3;
        }
    }
    return str;
}

export function generateMnemonic(): string[] {
    const entropy = Crypto.getRandomBytes(16);
    const hash = sha256(entropy);
    let h = 0;
    for (let i = 0; i < 4; i++) {
        h = (h << 8) | hash[i];
    }
    const checkBits = ((h >>> 28) & 0xf).toString(2).padStart(4, '0');

    let bits = '';
    for (const byte of entropy) {
        bits += byte.toString(2).padStart(8, '0');
    }
    bits += checkBits;

    const words: string[] = [];
    for (let i = 0; i < 12; i++) {
        const index = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
        words.push(WORDLIST[index]);
    }
    return words;
}

export function validateMnemonic(words: string[]): boolean {
    if (words.length !== 12) return false;
    return words.every(w => WORDLIST.includes(w.toLowerCase().trim()));
}

export async function mnemonicToKeypair(words: string[]): Promise<{
    publicKeyHex: string;
    privateKeyHex: string;
}> {
    const phrase = words.map(w => w.toLowerCase().trim()).join(' ');
    const phraseBytes = encodeUtf8(phrase);

    // Double SHA256 -> 32 byte seed
    const hash1 = sha256(phraseBytes);
    const privateKey = sha256(hash1); // 32 bytes

    const publicKeyRaw = await getPublicKey(privateKey);
    return {
        publicKeyHex: bytesToHex(publicKeyRaw),
        privateKeyHex: bytesToHex(privateKey)
    };
}

export async function seedToKeypair(seed: Uint8Array): Promise<{
    publicKeyHex: string;
    privateKeyHex: string;
}> {
    const rawSeed = toEd25519Seed(seed);
    const publicKeyRaw = await getPublicKey(rawSeed);
    return {
        publicKeyHex: bytesToHex(publicKeyRaw),
        privateKeyHex: bytesToHex(rawSeed),
    };
}

export async function signData(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    // Identities imported from the PWA arrive PKCS8-wrapped; noble signs with the raw
    // seed. Both forms are normalised in @beanpool/core so the two clients cannot drift
    // apart on it — see ed25519-key.ts.
    const seed = toEd25519Seed(privateKey);
    return sign(message, seed);
}

/**
 * The member key as @beanpool/core's `Signer`. Handed only to core's builders and to the old-form fallbacks for a
 * server older than request binding (here and in member-statements.ts): the app never signs bytes a node chose.
 * utils/__tests__/request-binding-source-rule.test.ts holds every caller to that.
 */
export function memberSigner(privateKeyHex: string): Signer {
    const key = hexToBytes(privateKeyHex);
    return (bytes) => signData(bytes, key);
}

/**
 * X-1: build replay-proof signed-request headers (single source of truth for
 * HTTP request signing — X-2). `url` is the FULL URL the fetch will use: the host
 * signed for and the path signed are both read from it (@beanpool/core
 * `audienceOf` / `signedPathOf`), so they can't drift from what is fetched.
 *
 * Format 2 (request binding): `0xFF ‖ beanpool-request/2\nHOST\nMETHOD\nPATH\nTS\nNONCE\nBODY`
 * plus `X-Signed-For: HOST`, so the signature counts only at the community it was
 * sent to. The old `METHOD\nPATH\nTS\nNONCE\nBODY` only for a node whose info said
 * it predates that (request-signing-version.ts).
 *
 * Throws, having signed nothing, for a URL whose authority isn't exactly `host[:port]` (node-url.ts
 * `assertPlainNodeAddress`): iOS would connect to a different host than the one signed for.
 */
export async function buildSignedHeaders(
    method: string,
    url: string,
    bodyString: string,
    privateKeyHex: string,
    publicKeyHex: string,
): Promise<Record<string, string>> {
    assertPlainNodeAddress(url);
    if (!audienceOf(url)) throw new Error(`Cannot sign a request for ${JSON.stringify(url)}: pass the full URL fetched`);
    const sign = memberSigner(privateKeyHex);
    const signed = await requestSigningFormatFor(url) === 2
        ? await buildBoundRequestHeaders({ method, url, body: bodyString, publicKeyHex, sign, nonce: freshNonce() })
        : await unboundRequestHeaders(method, url, bodyString, publicKeyHex, sign);
    return { 'Content-Type': 'application/json', ...signed };
}

/**
 * WebSocket connect auth (SRV-4). Produces signed query params for the `/ws`
 * handshake, mirroring the HTTP replay-proof scheme (method=`WS`, path,
 * timestamp, nonce, empty body). `wsUrl` is the full `ws(s)://…/ws` URL the socket
 * opens (before its query). The node gives the full live feed only to a
 * member-signed socket; an unsigned one gets public doorbells only. Returns a
 * `&`-joinable query fragment: in format 2 it adds `for=HOST&v=2`. Refuses, like {@link buildSignedHeaders}, a
 * URL whose authority isn't plain.
 */
export async function buildSignedWsParams(
    wsUrl: string,
    privateKeyHex: string,
    publicKeyHex: string,
): Promise<string> {
    assertPlainNodeAddress(wsUrl);
    if (!audienceOf(wsUrl)) throw new Error(`Cannot sign a socket for ${JSON.stringify(wsUrl)}: pass the full URL opened`);
    const sign = memberSigner(privateKeyHex);
    return await requestSigningFormatFor(wsUrl) === 2
        ? buildBoundWsParams({ wsUrl, publicKeyHex, sign, nonce: freshNonce() })
        : unboundWsParams(wsUrl, publicKeyHex, sign);
}

function freshNonce(): string {
    return bytesToHex(Crypto.getRandomBytes(16));
}

// ── The old format, for a server older than request binding ──────────────────────────────────────────────
// Only for a node whose /api/community/info answered without `requestSigning` (request-signing-version.ts).
// Byte for byte what builds before it sent, through core's `unboundRequestText`. Every server refuses it after
// the switch, so a node that only pretends to be old gains nothing lasting.

async function unboundRequestHeaders(
    method: string, url: string, bodyString: string, publicKeyHex: string, sign: Signer,
): Promise<Record<string, string>> {
    const timestamp = String(Date.now());
    const nonce = freshNonce();
    const text = unboundRequestText({ method: method.toUpperCase(), path: signedPathOf(url), timestamp, nonce, body: bodyString });
    return {
        'X-Public-Key': publicKeyHex,
        'X-Signature': toBase64(await sign(utf8Bytes(text))),
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
    };
}

async function unboundWsParams(wsUrl: string, publicKeyHex: string, sign: Signer): Promise<string> {
    const timestamp = String(Date.now());
    const nonce = freshNonce();
    const text = unboundRequestText({ method: 'WS', path: signedPathOf(wsUrl), timestamp, nonce, body: '' });
    const sig = toBase64(await sign(utf8Bytes(text)));
    return `pubkey=${encodeURIComponent(publicKeyHex)}&ts=${timestamp}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

export async function verifyData(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    return verify(signature, message, publicKey);
}

