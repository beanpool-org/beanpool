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
export const HELD_BACK_NAME_MESSAGE = 'Give your community a name to appear on the map';
export const HELD_BACK_TEST_NODE_MESSAGE = 'Test and review nodes do not publish to the directory';

export function isDefaultOrEmptyCommunityName(name: string | null | undefined): boolean {
    if (!name) return true;
    const clean = name.trim();
    return !clean || clean === 'BeanPool Community';
}

export function isReviewOrTestNode(): boolean {
    const envFlag = (process.env.BEANPOOL_TEST_NODE || process.env.TEST_NODE || '').trim().toLowerCase();
    if (envFlag === '1' || envFlag === 'true' || envFlag === 'yes' || envFlag === 'on') return true;

    const cfRecord = (process.env.CF_RECORD_NAME || '').trim().toLowerCase();
    if (cfRecord === 'test' || cfRecord === 'review' || cfRecord === 'test.beanpool.org' || cfRecord === 'review.beanpool.org' || cfRecord.startsWith('test.') || cfRecord.startsWith('review.')) {
        return true;
    }

    const publicAddrName = (process.env.PUBLIC_ADDRESS_NAME || '').trim().toLowerCase();
    if (publicAddrName === 'test' || publicAddrName === 'review') return true;

    const nodeName = (process.env.BEANPOOL_NODE_NAME || '').trim().toLowerCase();
    if (nodeName === 'test' || nodeName === 'review') return true;

    try {
        const config = getNodeConfig();
        if ((config as any)?.isTestNode || (config as any)?.testNode || (config as any)?.isReviewNode || (config as any)?.reviewNode) {
            return true;
        }
        const pa = config?.publicAddress;
        if (pa) {
            const paName = (pa.name || '').trim().toLowerCase();
            if (paName === 'test' || paName === 'review') return true;
            const paHost = (pa.hostname || '').trim().toLowerCase();
            if (paHost === 'test.beanpool.org' || paHost === 'review.beanpool.org' || paHost.startsWith('test.') || paHost.startsWith('review.')) {
                return true;
            }
        }
    } catch {}

    try {
        const local = getLocalConfig();
        if ((local as any)?.isTestNode || (local as any)?.testNode || (local as any)?.isReviewNode || (local as any)?.reviewNode) {
            return true;
        }
        const callsign = (local.callsign || '').trim().toLowerCase();
        if (callsign === 'test' || callsign === 'review' || callsign === 'test node' || callsign === 'review node') {
            return true;
        }
    } catch {}

    return false;
}

let pushTimer: ReturnType<typeof setInterval> | null = null;

// Guarded here, not just at the index.ts boot call site — /api/local/admin/node/config
// and /api/local/admin/directory/push can also reach these, and a backup replica must
// never advertise itself in the public directory regardless of caller. Nor must a node
// whose profile switch `publishToDirectory` is off (config/node-profile.ts): the global
// node is the lobby, not a community with a place, so it is never a pin on the map.
// A node also does NOT publish while its name is still default ("BeanPool Community", or
// empty), or while it is marked as a review/test node.
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
    if (isReviewOrTestNode()) {
        console.log('[Directory] 🧪 Skipping — test and review nodes do not publish to the directory.');
        return false;
    }
    const localConfig = getLocalConfig();
    if (isDefaultOrEmptyCommunityName(localConfig.communityName)) {
        console.log(`[Directory] ⏸️ Skipping — community name is default or empty (${HELD_BACK_NAME_MESSAGE}).`);
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
    // Read at every push, the timer's included: an operator's override switching it off takes effect at the next push.
    // Switched on at runtime, the timer starts at the next boot, or when Settings saves the push interval.
    if (!getProfileSwitches().publishToDirectory) {
        return { success: false, error: NOT_LISTED_MESSAGE };
    }
    try {
        const p2pNode = getP2PNode();
        const privateKey = getPrivateKey();

        if (!p2pNode || !privateKey) {
            console.warn(`[Directory] ⚠️ P2P node not fully initialized. Skipping push.`);
            return { success: false, error: 'P2P node not ready' };
        }

        if (isReviewOrTestNode()) {
            return { success: false, error: HELD_BACK_TEST_NODE_MESSAGE };
        }
        const localConfig = getLocalConfig();
        if (isDefaultOrEmptyCommunityName(localConfig.communityName)) {
            return { success: false, error: HELD_BACK_NAME_MESSAGE };
        }

        const directoryInfo = getDirectoryInfo();
        
        // Provide a stable node ID based on the node's true cryptographic PeerId
        const nodeId = p2pNode.peerId.toString();
        const timestamp = Date.now();
        
        // The contacts are always said, null unless the owner turned each on (getDirectoryInfo): a node that publishes
        // nothing else must still tell the directory to drop a contact it was sent before.
        const payload = {
            nodeId,
            callsign: localConfig.communityName,
            timestamp,
            contactEmail: null,
            contactPhone: null,
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
