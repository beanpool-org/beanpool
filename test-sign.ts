import { generateKeyPair } from '@libp2p/crypto/keys';
async function test() {
    const key = await generateKeyPair('Ed25519');
    const signature = await key.sign(new TextEncoder().encode("hello world"));
    console.log("Sig:", Buffer.from(signature).toString('base64'));
}
test();
