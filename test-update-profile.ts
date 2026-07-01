import { encodeBase64, encodeUtf8, hexToBytes, signData, generateIdentity } from './apps/native/utils/crypto.ts';

async function run() {
    const id = await generateIdentity();
    const payloadObj = {
        publicKey: id.publicKey,
        avatar: "data:image/jpeg;base64,TESTING_AVATAR_BLOB",
        bio: "Test bio",
        contact: null,
        callsign: "TestCallsign",
    };
    const bodyString = JSON.stringify(payloadObj);
    const privateKeyBytes = hexToBytes(id.privateKey);
    const messageBytes = encodeUtf8(bodyString);
    const signatureBytes = await signData(messageBytes, privateKeyBytes);
    const signatureBase64 = encodeBase64(signatureBytes);

    // Register first
    await fetch('http://localhost:3000/api/community/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: id.publicKey, callsign: "TestCallsign" })
    });

    const res = await fetch('http://localhost:3000/api/profile/update', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'X-Public-Key': id.publicKey,
            'X-Signature': signatureBase64,
        },
        body: bodyString,
    });

    console.log(res.status, await res.text());
}
run();
