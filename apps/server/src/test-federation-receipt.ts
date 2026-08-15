process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { signReceipt, verifyReceipt } from './federation-receipt.js';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running federation receipt tests (signReceipt/verifyReceipt errors)...\n');

    const privKey = await generateKeyPair('Ed25519');
    const peerIdObj = peerIdFromPrivateKey(privKey);
    const peerIdStr = peerIdObj.toString();

    // The base valid receipt
    const validReceipt = {
        key: 'test-key',
        issuerPeerId: peerIdStr,
        buyerPublicKey: 'buyer-pub',
        buyerHomeNode: 'http://buyer.home',
        sellerPublicKey: 'seller-pub',
        postId: 'post-1',
        amount: 50.5,
        committedAt: '2023-01-01T00:00:00Z',
    };

    // 1. signReceipt error cases

    let threw = false;
    try {
        await signReceipt(validReceipt, null as any);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('No node identity key available'), 'signReceipt throws on missing private key');
    }
    assert(threw, 'signReceipt must throw without a key');

    threw = false;
    try {
        await signReceipt({ ...validReceipt, amount: undefined as any }, privKey);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('finite numeric amount'), 'signReceipt throws on undefined amount');
    }
    assert(threw, 'signReceipt must throw without amount');

    threw = false;
    try {
        await signReceipt({ ...validReceipt, amount: NaN }, privKey);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('finite numeric amount'), 'signReceipt throws on NaN amount');
    }
    assert(threw, 'signReceipt must throw on NaN amount');

    threw = false;
    try {
        await signReceipt({ ...validReceipt, amount: Infinity }, privKey);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('finite numeric amount'), 'signReceipt throws on Infinity amount');
    }
    assert(threw, 'signReceipt must throw on Infinity amount');

    threw = false;
    try {
        await signReceipt({ ...validReceipt, key: '' }, privKey);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('without a key and an issuer'), 'signReceipt throws on empty key');
    }
    assert(threw, 'signReceipt must throw on empty key');

    threw = false;
    try {
        await signReceipt({ ...validReceipt, issuerPeerId: '' }, privKey);
    } catch (e: any) {
        threw = true;
        assert(e.message.includes('without a key and an issuer'), 'signReceipt throws on empty issuer');
    }
    assert(threw, 'signReceipt must throw on empty issuer');

    // 2. verifyReceipt edge cases

    const sig = await signReceipt(validReceipt, privKey);

    const v1 = await verifyReceipt(null as any, sig, peerIdStr);
    assert(v1 === false, 'verifyReceipt fails safely on null receipt');

    const v2 = await verifyReceipt(validReceipt, null as any, peerIdStr);
    assert(v2 === false, 'verifyReceipt fails safely on null signature');

    const v3 = await verifyReceipt(validReceipt, sig, null as any);
    assert(v3 === false, 'verifyReceipt fails safely on null expectedPeerId');

    const v4 = await verifyReceipt(validReceipt, 'invalid-base64-here!!', peerIdStr);
    assert(v4 === false, 'verifyReceipt fails safely on malformed base64 signature');

    const rsaKey = await generateKeyPair('RSA', 2048);
    const rsaPeerId = peerIdFromPrivateKey(rsaKey).toString();

    // Attempting to verify with an RSA peer ID will fail safely in verifyReceipt
    // "RSA peer ids carry only a hash of the key, so the key is not recoverable from the id alone."
    const v5 = await verifyReceipt({ ...validReceipt, issuerPeerId: rsaPeerId }, sig, rsaPeerId);
    assert(v5 === false, 'verifyReceipt fails safely when peer ID lacks a verifiable public key (RSA fallback path)');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Federation receipt error edge cases PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
