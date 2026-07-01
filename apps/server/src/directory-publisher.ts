import { getDirectoryInfo, getNodeConfig, updateNodeConfig } from './state-engine.js';
import { getLocalConfig } from './local-config.js';
import { getP2PNode, getPrivateKey } from './p2p.js';
import { publicKeyToProtobuf } from '@libp2p/crypto/keys';

// The URL of the directory registry Edge Function
const DIRECTORY_REGISTRY_URL = process.env.DIRECTORY_REGISTRY_URL || 'https://dpemwoermzkaxoctafzg.supabase.co/functions/v1/directory-register';

let pushTimer: ReturnType<typeof setInterval> | null = null;

export function initDirectoryPublisher() {
    const config = getNodeConfig();
    const intervalHours = config.directoryPushIntervalHours !== undefined ? config.directoryPushIntervalHours : 12;
    
    if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
    }
    
    if (intervalHours === 0) {
        console.log(`[Directory] 📴 Push publisher is disabled.`);
        return;
    }
    
    // Convert hours to milliseconds
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    pushTimer = setInterval(pushDirectoryNow, intervalMs);
    
    // Initial push 30s after boot
    setTimeout(pushDirectoryNow, 30_000);
    console.log(`[Directory] 📡 Push publisher initialized (Interval: ${intervalHours}h)`);
}

export async function pushDirectoryNow() {
    try {
        const directoryInfo = getDirectoryInfo();
        const localConfig = getLocalConfig();
        const p2pNode = getP2PNode();
        const privateKey = getPrivateKey();

        if (!p2pNode || !privateKey) {
            console.warn(`[Directory] ⚠️ P2P node not fully initialized. Skipping push.`);
            return { success: false, error: 'P2P node not ready' };
        }
        
        // Provide a stable node ID based on the node's true cryptographic PeerId
        const nodeId = p2pNode.peerId.toString();
        const timestamp = Date.now();
        
        const payload = {
            nodeId,
            callsign: localConfig.communityName,
            timestamp,
            ...directoryInfo
        };
        
        const rawBody = JSON.stringify(payload);
        const signatureBytes = await privateKey.sign(new TextEncoder().encode(rawBody));
        const signatureHex = Buffer.from(signatureBytes).toString('hex');
        const pubKeyHex = Buffer.from(publicKeyToProtobuf(privateKey.publicKey)).toString('hex');

        const res = await fetch(DIRECTORY_REGISTRY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-signature': signatureHex,
                'x-public-key': pubKeyHex
            },
            body: rawBody
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText}`);
        }
        
        // Update lastDirectoryPush
        updateNodeConfig({ lastDirectoryPush: new Date().toISOString() });
        
        console.log(`[Directory] ✅ Successfully published to directory registry`);
        return { success: true, timestamp: new Date().toISOString() };
    } catch (err: any) {
        console.error(`[Directory] ❌ Failed to push directory info:`, err.message);
        return { success: false, error: err.message };
    }
}
