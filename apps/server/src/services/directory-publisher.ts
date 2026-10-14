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

/**
 * The name the public community-info shows for a community with neither a name nor a callsign (routes/community.ts), and
 * what the node's settings page stored when saved untouched before its name box read the stored name. The owners' boxes
 * now start from the stored name (diagnostics, null for none), so a save left untouched stores none.
 */
export const DEFAULT_COMMUNITY_NAME = 'BeanPool Community';

/** Why a community with no name of its own is held back (the manual push's answer and the log; the owners' screens word it themselves). */
export const HELD_BACK_NAME_MESSAGE = `Not listed in the directory yet: this community has no name of its own ("${DEFAULT_COMMUNITY_NAME}" is the default). Name it in Settings and it is listed at once.`;
/** Why a server with DIRECTORY_UNLISTED set is held back. */
export const HELD_BACK_UNLISTED_MESSAGE = 'Not listed in the directory: DIRECTORY_UNLISTED is set in this server\'s .env (our test and review nodes set it). Remove it and restart to be listed.';

/**
 * Why a community that would otherwise publish is held back, or null:
 *   - `unnamed`: its name is blank or exactly "BeanPool Community". The name is `communityName` alone: `callsign` is the
 *     admin's handle ("admin", "node-genesis" from the first-start wizard), never a community's name on a map.
 *   - `unlisted`: DIRECTORY_UNLISTED=1 (or true/yes/on) in the server's env. Our own test and review nodes set it in
 *     their .env on their servers (deploy.sh keeps each node's .env across deploys), so they are never a pin on the
 *     public map. Nothing else: a community is never held back for its address, hostname or callsign.
 * Never silent: the owners' diagnostics carry it (directoryHeldBack) and their screens say what to change.
 */
export type DirectoryHoldBack = 'unnamed' | 'unlisted';

export function isDefaultOrEmptyCommunityName(name: string | null | undefined): boolean {
    const clean = (name ?? '').trim();
    return !clean || clean === DEFAULT_COMMUNITY_NAME;
}

const UNLISTED_YES = ['1', 'true', 'yes', 'on'];
const UNLISTED_NO = ['', '0', 'false', 'no', 'off'];

/** DIRECTORY_UNLISTED in the env, read at every call. */
export function directoryUnlistedByEnv(): boolean {
    return UNLISTED_YES.includes((process.env.DIRECTORY_UNLISTED || '').trim().toLowerCase());
}

/** A DIRECTORY_UNLISTED that is neither a yes nor a no ("ture"): the community is listed, and the boot says so. */
function unrecognisedUnlistedValue(): string | null {
    const raw = process.env.DIRECTORY_UNLISTED ?? '';
    return UNLISTED_YES.includes(raw.trim().toLowerCase()) || UNLISTED_NO.includes(raw.trim().toLowerCase()) ? null : raw;
}

function holdBack(): DirectoryHoldBack | null {
    if (directoryUnlistedByEnv()) return 'unlisted';
    if (isDefaultOrEmptyCommunityName(getLocalConfig().communityName)) return 'unnamed';
    return null;
}

const HELD_BACK_MESSAGES: Record<DirectoryHoldBack, string> = { unnamed: HELD_BACK_NAME_MESSAGE, unlisted: HELD_BACK_UNLISTED_MESSAGE };

/**
 * For the owners' screens (GET /api/local/admin/diagnostics `directoryHeldBack`: the manager's Directory Publishing and
 * static/settings.js): why this community is not on the public map although it is set to publish. Null where it
 * publishes, and where its screens already say why not: a standby, a profile that is never listed (global), or the
 * push interval at Never.
 */
export function directoryHeldBack(): DirectoryHoldBack | null {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().publishToDirectory) return null;
    if (getNodeConfig().directoryPushIntervalHours === 0) return null;
    return holdBack();
}

let pushTimer: ReturnType<typeof setInterval> | null = null;

function safePush(): void {
    pushDirectoryNow().catch(err => {
        console.error('[Directory] Unhandled error in scheduled directory push:', err?.message || err);
    });
}

// Guarded here, not just at the index.ts boot call site — /api/local/admin/node/config
// and /api/local/admin/directory/push can also reach these, and a backup replica must
// never advertise itself in the public directory regardless of caller. Nor must a node
// whose profile switch `publishToDirectory` is off (config/node-profile.ts): the global
// node is the lobby, not a community with a place, so it is never a pin on the map.
// A community with no name of its own still gets the timer: every push is held back until it is named, and naming it
// pushes at once (communityNameSaved), with no restart. DIRECTORY_UNLISTED, which only a restart changes, sets none.
// Returns whether the timer is set.
export function initDirectoryPublisher(): boolean {
    const typo = unrecognisedUnlistedValue();
    if (typo !== null) {
        console.warn(`[Directory] ⚠️ DIRECTORY_UNLISTED=${JSON.stringify(typo)} in this server's .env is not a yes (1, true, yes, on) or a no (empty, 0, false, no, off), so this community is listed. To keep it off the public map, set DIRECTORY_UNLISTED=1 and restart.`);
    }
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
    if (directoryUnlistedByEnv()) {
        console.log(`[Directory] 📴 ${HELD_BACK_UNLISTED_MESSAGE}`);
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

    pushTimer = setInterval(safePush, intervalMs);
    
    // Initial push 30s after boot
    setTimeout(safePush, 30_000);
    console.log(`[Directory] 📡 Push publisher initialized (Interval: ${intervalHours}h)`);
    if (holdBack() === 'unnamed') console.log(`[Directory] ⏸️ ${HELD_BACK_NAME_MESSAGE}`);
    return true;
}

/**
 * The community's name was saved (routes/community.ts update-identity: the manager's Node Identity and first-start
 * wizard, static/settings.js). A community named after its server started is listed at once rather than at the next
 * timed push (12 hours by default), and a rename shows at once. Only while the publisher runs: nothing on a standby,
 * with the switch off, or with the interval at Never; nothing while it is held back.
 */
export function communityNameSaved(): void {
    if (!pushTimer || holdBack()) return;
    safePush();
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
    // Read at every push too: the timer runs for an unnamed community, and sends nothing until it is named.
    const held = holdBack();
    if (held) return { success: false, error: HELD_BACK_MESSAGES[held], heldBack: held };
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
