import { getDirectoryInfo, getNodeConfig, updateNodeConfig, getNodeRole } from '../state-engine.js';
import { getLocalConfig } from '../config/local-config.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getP2PNode, getPrivateKey } from '../p2p.js';
import { publicKeyToProtobuf } from '@libp2p/crypto/keys';

// The URL of the directory registry Edge Function. Read at every push, so a test can point it at a fixture.
function directoryRegistryUrl(): string {
    return process.env.DIRECTORY_REGISTRY_URL || 'https://dpemwoermzkaxoctafzg.supabase.co/functions/v1/directory-register';
}

/** Why a node whose profile switch `publishToDirectory` is off sends nothing (the global profile's default). */
export const NOT_LISTED_MESSAGE = 'This node is not listed in the directory: its publishToDirectory switch is off (the global profile\'s default: the lobby is not a place on the map).';

let pushTimer: ReturnType<typeof setInterval> | null = null;

// Guarded here, not just at the index.ts boot call site — /api/local/admin/node/config
// and /api/local/admin/directory/push can also reach these, and a backup replica must
// never advertise itself in the public directory regardless of caller. Nor must a node
// whose profile switch `publishToDirectory` is off (config/node-profile.ts): the global
// node is the lobby, not a community with a place, so it is never a pin on the map.
// Returns whether the timer is set.
export function initDirectoryPublisher(): boolean {
    if (getNodeRole() !== 'primary') {
        console.log('[Directory] 🔒 Skipping — backup replicas do not publish to the directory.');
        return false;
    }
    if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
    }
    if (!getProfileSwitches().publishToDirectory) {
        console.log(`[Directory] 📴 ${NOT_LISTED_MESSAGE}`);
        return false;
    }
    const config = getNodeConfig();
    const intervalHours = config.directoryPushIntervalHours !== undefined ? config.directoryPushIntervalHours : 12;
    
    if (intervalHours === 0) {
        console.log(`[Directory] 📴 Push publisher is disabled.`);
        return false;
    }
    
    // Convert hours to milliseconds
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    const safePush = () => {
        pushDirectoryNow().catch(err => {
            console.error('[Directory] Unhandled error in scheduled directory push:', err?.message || err);
        });
    };

    pushTimer = setInterval(safePush, intervalMs);
    
    // Initial push 30s after boot
    setTimeout(safePush, 30_000);
    console.log(`[Directory] 📡 Push publisher initialized (Interval: ${intervalHours}h)`);
    return true;
}

export async function pushDirectoryNow() {
    if (getNodeRole() !== 'primary') {
        return { success: false, error: 'Directory push is only allowed on primary nodes' };
    }
    // Read at every push, the timer's included: an operator's override takes effect without a restart.
    if (!getProfileSwitches().publishToDirectory) {
        return { success: false, error: NOT_LISTED_MESSAGE };
    }
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

        const res = await fetch(directoryRegistryUrl(), {
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
