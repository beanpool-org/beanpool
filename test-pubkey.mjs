import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromKeys } from '@libp2p/peer-id';
async function test() {
    const key = await generateKeyPair('Ed25519');
    // How to get PeerId from public key?
    // In latest libp2p, peerIdFromKeys is exported from '@libp2p/peer-id' but apparently it wasn't found before? Wait, peerIdFromKeys was missing in the previous test because I tried to import it, but it errored. Let's see what is exported.
    console.log(key.publicKey);
}
test();
