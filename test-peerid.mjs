import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromKeys } from '@libp2p/peer-id';
async function test() {
    const pk = await generateKeyPair('Ed25519');
    const peerId = peerIdFromKeys(pk.publicKey);
    console.log("PeerId:", peerId.toString());
    console.log("PeerId hex:", Buffer.from(peerId.toBytes()).toString('hex'));
    console.log("Pubkey hex:", Buffer.from(pk.publicKey.bytes).toString('hex'));
}
test();
