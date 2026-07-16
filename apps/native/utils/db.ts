import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadIdentity } from './identity';
import * as Crypto from 'expo-crypto';
import { encodeBase64, encodeUtf8, decodeBase64, decodeUtf8, buildSignedHeaders } from './crypto';
import { encryptDM, decryptDM, isEncryptedNonce, type DMKeyContext } from './e2e-crypto';
import { getDatabaseFilenameForNode, addSavedNode } from './nodes';
// expo-file-system 55.x defaults to the new File/Paths API; the classic cacheDirectory +
// writeAsStringAsync helpers we use live under the /legacy entrypoint.
import * as FileSystem from 'expo-file-system/legacy';

// Decrypted chat images live here — in the filesystem, NOT SQLite — so they survive a
// DB wipe-and-fetch (which only drops tables) and are populated lazily (only images the
// user actually opens), never bulk-pulled on sync.
const CHAT_IMAGE_CACHE_DIR = `${FileSystem.cacheDirectory}chat-images/`;

/**
 * Singleton database instance.
 * Using the synchronous API available in expo-sqlite version 14.x+ 
 */
let db: SQLite.SQLiteDatabase | null = null;
let dbInitialized = false;
let dbInitPromise: Promise<void> | null = null;

// Global JS mutex to prevent expo-sqlite "database is locked" crashes
// arising from concurrent loops across background Pillar polls and foreground Inbox rendering.
// Two-lane queue: `urgent` acquirers (user-initiated writes — accept, release, rate)
// are granted before any queued background sync, so a button press never waits behind
// a backlog of poll-driven write bursts (observed 8–175s queues on-device, 2026-07-17).
// FIFO within each lane. Callers MUST pair every acquire with releaseSyncLock() in a
// finally block, and MUST NOT re-acquire while holding the lock (it is not reentrant).
// Never hold it across network I/O — only around the local SQLite writes themselves.
let syncLockHeld = false;
const syncLockUrgentQueue: Array<() => void> = [];
const syncLockNormalQueue: Array<() => void> = [];

async function acquireSyncLock(opts?: { urgent?: boolean }) {
    if (!syncLockHeld) {
        syncLockHeld = true;
        return;
    }
    const waitStart = Date.now();
    await new Promise<void>(resolve => {
        (opts?.urgent ? syncLockUrgentQueue : syncLockNormalQueue).push(resolve);
    });
    const waited = Date.now() - waitStart;
    if (waited > 2000) console.warn(`[DB] acquireSyncLock waited ${waited}ms (urgent=${!!opts?.urgent}, queued: ${syncLockUrgentQueue.length}u/${syncLockNormalQueue.length}n) — writers are outpacing the queue`);
}
function releaseSyncLock() {
    // Hand off directly to the next waiter (urgent lane first) so the lock is never
    // observed free by a late acquirer while earlier waiters are still queued.
    const next = syncLockUrgentQueue.shift() ?? syncLockNormalQueue.shift();
    if (next) next();
    else syncLockHeld = false;
}

let currentDbName: string | null = null;
let getDbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
    const url = await AsyncStorage.getItem('beanpool_anchor_url');
    const expectedDbName = getDatabaseFilenameForNode(url);

    if (db && currentDbName === expectedDbName) {
        return db;
    }

    if (getDbPromise && currentDbName === expectedDbName) {
        return getDbPromise;
    }

    currentDbName = expectedDbName;

    getDbPromise = (async () => {
        try {
            // Force strict database isolation and hot-swap reconnect if matrix url changes
            if (db) {
                await db.closeAsync();
                dbInitialized = false;
                dbInitPromise = null;
                db = null;
            }

            if (url) await addSavedNode(url); // Auto-track nodes we jump into correctly inside the UI Matrix.
            
            db = await SQLite.openDatabaseAsync(expectedDbName, { useNewConnection: true });
            
            // Hardcode native concurrent locking parameters per-connection
            await db.execAsync(`
                PRAGMA journal_mode = WAL;
                PRAGMA busy_timeout = 30000;
            `);
            
            // Safety Init: If we blindly swapped contexts, ensure this newly mounted database replicates the exact Schema
            if (!dbInitialized && !dbInitPromise) {
                dbInitPromise = _doInitDB();
                await dbInitPromise;
            }

            return db;
        } finally {
            getDbPromise = null;
        }
    })();

    return getDbPromise;
}

export async function closeDB() {
    if (db) {
        await db.closeAsync();
        db = null;
        dbInitialized = false;
        dbInitPromise = null;
    }
}

/** Ensures initDB has completed before any query runs */
async function waitForInit(): Promise<SQLite.SQLiteDatabase> {
    if (dbInitialized) return getDb();
    if (dbInitPromise) {
        await dbInitPromise;
        return getDb();
    }
    // If neither, trigger initDB ourselves
    dbInitPromise = initDB();
    await dbInitPromise;
    return getDb();
}

/**
 * Physically translates the Node Server schema identical array into
 * the local Native device's memory for Background Libp2p gossiping.
 */
export async function initDB() {
    if (dbInitialized) return;
    if (dbInitPromise) { await dbInitPromise; return; }
    dbInitPromise = _doInitDB();
    await dbInitPromise;
}

async function _doInitDB() {
    const database = await getDb();
    
    // Nuke & Pave Version 3: Typed System Messages
    const versionResult = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if (!versionResult || versionResult.user_version < 3) {
        console.log("🧨 Native DB Version < 3. Nuking messaging tables for Object Attribution Overhaul...");
        await database.execAsync(`
            DROP TABLE IF EXISTS messages;
            DROP TABLE IF EXISTS conversation_participants;
            DROP TABLE IF EXISTS conversations;
        `);
        await database.execAsync('PRAGMA user_version = 3');
    }

    // We execute the same exact schema.sql payload to guarantee 1:1 API compatibility locally
    const schema = `
        -- 1. Members and Profiles
        CREATE TABLE IF NOT EXISTS members (
            public_key TEXT PRIMARY KEY,
            callsign TEXT NOT NULL,
            joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            invited_by TEXT,
            invite_code TEXT,
            home_node_url TEXT,
            
            avatar_url TEXT,
            bio TEXT,
            contact_value TEXT,
            contact_visibility TEXT,
            status TEXT DEFAULT 'active',
            last_active_at DATETIME,
            profile_updated_at DATETIME,
            earned_credit REAL DEFAULT 0,
            elder_vouched_by TEXT
        );

        -- 2. Ledger Accounts & Transactions
        CREATE TABLE IF NOT EXISTS accounts (
            public_key TEXT PRIMARY KEY,
            balance REAL DEFAULT 0.0,
            last_updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            last_demurrage_epoch INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            from_pubkey TEXT NOT NULL,
            to_pubkey TEXT NOT NULL,
            amount REAL NOT NULL CHECK (amount > 0),
            tax_fee REAL DEFAULT 0.0,
            memo TEXT,
            timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_pubkey);
        CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_pubkey);
        CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);

        -- 3. Marketplace Posts
        CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            credits REAL NOT NULL DEFAULT 0,
            author_pubkey TEXT NOT NULL,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            active INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending', 'paused', 'completed', 'cancelled')),
            price_type TEXT DEFAULT 'fixed',
            repeatable INTEGER DEFAULT 0,
            accepted_by TEXT,
            accepted_by_callsign TEXT,
            accepted_at DATETIME,
            pending_transaction_id TEXT,
            completed_at DATETIME,
            lat REAL,
            lng REAL,
            origin_node TEXT,
            photos TEXT,
            author_energy_cycled INTEGER DEFAULT 0,
            author_founding_needed INTEGER DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_active_posts ON posts(created_at DESC) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);

        -- 4. Marketplace Transactions
        CREATE TABLE IF NOT EXISTS marketplace_transactions (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            buyer_pubkey TEXT NOT NULL,
            seller_pubkey TEXT NOT NULL,
            credits REAL NOT NULL,
            hours REAL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            completed_at DATETIME,
            cover_image TEXT,
            post_title TEXT
        );

        -- 5. Messaging & Chat
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            post_id TEXT,
            name TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            post_title TEXT,
            post_status TEXT,
            post_photo TEXT,
            post_credits REAL
        );

        CREATE TABLE IF NOT EXISTS conversation_participants (
            conversation_id TEXT,
            public_key TEXT,
            last_read_at DATETIME,
            PRIMARY KEY (conversation_id, public_key)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            author_pubkey TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            nonce TEXT NOT NULL,
            type TEXT DEFAULT 'text',
            system_type TEXT,
            metadata TEXT,
            timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, timestamp ASC);

        -- 6. Relations (Friends, Ratings, Abuse)
        CREATE TABLE IF NOT EXISTS ratings (
            id TEXT PRIMARY KEY,
            target_pubkey TEXT NOT NULL,
            rater_pubkey TEXT NOT NULL,
            role TEXT NOT NULL,
            stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
            comment TEXT,
            transaction_id TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(rater_pubkey, transaction_id)
        );

        -- 6b. Friends
        CREATE TABLE IF NOT EXISTS friends (
            owner_pubkey TEXT NOT NULL,
            friend_pubkey TEXT NOT NULL,
            added_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            is_guardian INTEGER DEFAULT 0,
            PRIMARY KEY (owner_pubkey, friend_pubkey)
        );
        
        -- 7. Projects
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            creator_pubkey TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            photos TEXT,
            goal_amount INTEGER NOT NULL,
            current_amount INTEGER DEFAULT 0,
            deadline_at DATETIME,
            status TEXT DEFAULT 'ACTIVE',
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
    `;

    try {
        await database.execAsync(schema);
        console.log('[SQLite] Local database initialized physically 1:1 with Server node.');
        
        // Add photos column if not exists (for existing simulators)
        try {
            await database.execAsync(`ALTER TABLE posts ADD COLUMN photos TEXT;`);
        } catch (e) {
            // Column likely already exists, ignore
        }
        
        try {
            await database.execAsync(`ALTER TABLE marketplace_transactions ADD COLUMN rated_by_buyer INTEGER DEFAULT 0;`);
        } catch (e) {}
        try {
            await database.execAsync(`ALTER TABLE marketplace_transactions ADD COLUMN rated_by_seller INTEGER DEFAULT 0;`);
        } catch (e) {}
        try {
            // Edit-message window: timestamp of the most recent edit (null = never edited)
            await database.execAsync(`ALTER TABLE messages ADD COLUMN edited_at DATETIME;`);
        } catch (e) {}
        try {
            await database.execAsync(`ALTER TABLE projects ADD COLUMN photos TEXT;`);
        } catch (e) {
            // Column likely already exists, ignore
        }

        // Add missing columns introduced in the State Engine patch
        try {
            await database.execAsync(`ALTER TABLE posts ADD COLUMN updated_at DATETIME;`);
            console.log('[SQLite] Successfully added updated_at column');
        } catch (e) {
            // Column likely already exists, ignore
        }
        
        try {
            await database.execAsync(`ALTER TABLE posts ADD COLUMN origin_node TEXT;`);
        } catch (e) {
            // Column likely already exists, ignore
        }

        // Add cover_image to marketplace_transactions
        try {
            await database.execAsync(`ALTER TABLE marketplace_transactions ADD COLUMN cover_image TEXT;`);
        } catch (e) {}

        // Add post caching columns to conversations table
        try { await database.execAsync(`ALTER TABLE conversations ADD COLUMN post_title TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE conversations ADD COLUMN post_status TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE conversations ADD COLUMN post_photo TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE conversations ADD COLUMN post_credits REAL;`); } catch (e) {}

        // Add post caching column to marketplace_transactions table
        try { await database.execAsync(`ALTER TABLE marketplace_transactions ADD COLUMN post_title TEXT;`); } catch (e) {}

        // Add price_type column if not exists
        try {
            await database.execAsync(`ALTER TABLE posts ADD COLUMN price_type TEXT DEFAULT 'fixed';`);
        } catch (e) {}
        // Add repeatable column if not exists
        try {
            await database.execAsync(`ALTER TABLE posts ADD COLUMN repeatable INTEGER DEFAULT 0;`);
        } catch (e) {}
        // Transaction Tracking Migrations
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN accepted_by TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN accepted_by_callsign TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN accepted_at DATETIME;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN pending_transaction_id TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN completed_at DATETIME;`); } catch (e) {}
        // Profile sync: track when a profile was last updated for cache-busting
        try { await database.execAsync(`ALTER TABLE members ADD COLUMN profile_updated_at DATETIME;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE members ADD COLUMN earned_credit REAL DEFAULT 0;`); } catch (e) {}
        // Elder vouch: who endorsed this member (lifts the floor-gate for founding members)
        try { await database.execAsync(`ALTER TABLE members ADD COLUMN elder_vouched_by TEXT;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN author_energy_cycled INTEGER DEFAULT 0;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE posts ADD COLUMN author_founding_needed INTEGER DEFAULT 1;`); } catch (e) {}
        try { await database.execAsync(`ALTER TABLE transactions ADD COLUMN tax_fee REAL DEFAULT 0.0;`); } catch (e) {}
        // Ratings table migration for legacy setups where Schema wasn't ran
        try { 
            await database.execAsync(`
                CREATE TABLE IF NOT EXISTS ratings (
                    id TEXT PRIMARY KEY,
                    target_pubkey TEXT NOT NULL,
                    rater_pubkey TEXT NOT NULL,
                    role TEXT NOT NULL,
                    stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
                    comment TEXT,
                    transaction_id TEXT,
                    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    UNIQUE(rater_pubkey, transaction_id)
                );
            `);
        } catch (e) {}

        // Force full synchronization once to populate new columns
        AsyncStorage.getItem('bp_trust_sync_v3').then(async (val) => {
            if (!val) {
                console.log('[SQLite] Forcing full sync for unified trust system migration.');
                await AsyncStorage.setItem('bp_trust_sync_v3', 'true');
                await AsyncStorage.removeItem('pillar_sync_members_last_sync');
                try {
                    const keys = await AsyncStorage.getAllKeys();
                    const syncKeys = keys.filter(k => k.startsWith('pillar_sync_') && (k.endsWith('_last-sync') || k.endsWith('_members_last_sync')));
                    for (const k of syncKeys) {
                        await AsyncStorage.removeItem(k);
                    }
                } catch (e) {}
                // Trigger sync immediately in the background
                try {
                    const { requestSync } = require('../services/pillar-sync');
                    requestSync().catch(() => {});
                } catch (e) {}
            }
        });
        // Client-side consolidation cleanup: remove local post-keyed conversations (post_id IS NOT NULL) to match the consolidated model.
        try {
            await database.execAsync(`
                DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE post_id IS NOT NULL);
                DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE post_id IS NOT NULL);
                DELETE FROM conversations WHERE post_id IS NOT NULL;
            `);
            console.log('[SQLite] Local legacy post-keyed conversations pruned successfully.');
        } catch (cleanupErr) {
            console.error('[SQLite] Failed to clean up legacy conversations locally:', cleanupErr);
        }
        
        dbInitialized = true;
    } catch (e) {
        console.error('[SQLite] Database init error:', e);
    }
}

/**
 * Simple Drop util if the User needs to wipe memory
 */
export async function clearDB() {
    const database = await getDb();
    await database.execAsync('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS conversation_participants; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS posts; DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS accounts; DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS projects;');
    
    // Reset flags to force schema recreation
    dbInitialized = false;
    dbInitPromise = null;
    
    await initDB();
}

/**
 * PWA Fetch Equivalents executed cleanly across the Local Disk
 */
export async function getPosts(filter?: { type?: string; category?: string }) {
    const database = await waitForInit();
    let query = `
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, m.joined_at
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        WHERE p.status IN ('active', 'pending', 'completed')
    `;
    const params: any[] = [];
    
    if (filter?.type) {
        query += ' AND p.type = ?';
        params.push(filter.type);
    }
    if (filter?.category) {
        query += ' AND p.category = ?';
        params.push(filter.category);
    }
    query += ' ORDER BY p.created_at DESC';
    
    let rows: any[] = [];
    if (params.length > 0) {
        rows = await database.getAllAsync(query, params);
    } else {
        rows = await database.getAllAsync(query);
    }

    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';

    return rows.map(r => {
        r.authorFoundingNeeded = r.author_founding_needed === 1;
        r.author_energy_cycled = r.author_energy_cycled ?? 0;

        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                if (Array.isArray(r.photos)) {
                    r.photos = r.photos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
                }
            } catch (e) { r.photos = []; }
        }
        return r;
    });
}

/** The signed-in member's OWN posts, INCLUDING paused ones (which getPosts hides from the feed).
 *  Used by "My Posts" so a member can see and re-activate a paused Offer. */
export async function getMyPosts(pubkey: string) {
    const database = await waitForInit();
    const rows = await database.getAllAsync(`
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, m.joined_at
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        WHERE p.author_pubkey = ? AND p.status IN ('active', 'pending', 'completed', 'paused')
        ORDER BY p.created_at DESC
    `, [pubkey]) as any[];
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    return rows.map((r: any) => {
        r.authorFoundingNeeded = r.author_founding_needed === 1;
        r.author_energy_cycled = r.author_energy_cycled ?? 0;
        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                if (Array.isArray(r.photos)) r.photos = r.photos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
            } catch (e) { r.photos = []; }
        }
        return r;
    });
}

export async function getPost(id: string) {
    const database = await waitForInit();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    
    // Background fetch to ensure the local DB has the latest post status.
    // Upserts so a post we've never synced (e.g. opened via a chat's "View Post"
    // before the next Pillar sync) appears after one round-trip. A slow or empty
    // server response never deletes local rows — deletion is applyDelta's job
    // (the server tombstones deleted posts with active=0).
    if (anchorUrl) {
        fetch(`${anchorUrl}/api/marketplace/posts?id=${encodeURIComponent(id)}&sync=true&_t=${Date.now()}`)
            .then(res => res.json())
            .then(async posts => {
                if (!Array.isArray(posts) || posts.length === 0) return;
                const p = posts[0];
                const before = await database.getFirstAsync<any>(
                    'SELECT status, active, accepted_by, pending_transaction_id, completed_at, updated_at FROM posts WHERE id = ?', [id]
                );
                await acquireSyncLock();
                try {
                    await database.runAsync(
                        'INSERT OR REPLACE INTO posts (id, type, category, title, description, credits, author_pubkey, lat, lng, photos, price_type, repeatable, status, active, accepted_by, accepted_by_callsign, accepted_at, completed_at, pending_transaction_id, created_at, updated_at, origin_node, author_energy_cycled, author_founding_needed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            p.id ?? id,
                            p.type ?? null,
                            p.category ?? null,
                            p.title ?? null,
                            p.description ?? '',
                            p.credits ?? 0,
                            p.author_pubkey || p.authorPubkey || p.authorPublicKey || null,
                            p.lat ?? null,
                            p.lng ?? null,
                            p.photos ? JSON.stringify(p.photos.filter((url: string) => !url.startsWith('file://'))) : null,
                            p.price_type || p.priceType || 'fixed',
                            p.repeatable ? 1 : 0,
                            p.status || 'active',
                            p.active !== undefined ? (p.active ? 1 : 0) : 1,
                            p.accepted_by || p.acceptedBy || null,
                            p.accepted_by_callsign || p.acceptedByCallsign || null,
                            p.accepted_at || p.acceptedAt || null,
                            p.completed_at || p.completedAt || null,
                            p.pending_transaction_id || p.pendingTransactionId || null,
                            p.created_at || p.createdAt || null,
                            p.updated_at || p.updatedAt || null,
                            p.origin_node || p.originNode || null,
                            p.author_energy_cycled ?? p.authorEnergyCycled ?? 0,
                            p.author_founding_needed !== undefined ? (p.author_founding_needed ? 1 : 0) : (p.authorFoundingNeeded ? 1 : 0)
                        ]
                    );
                } finally {
                    releaseSyncLock();
                }
                // Only notify listeners on a real change — post screens reload on this
                // event and re-call getPost, so an unconditional emit fetch-loops.
                const changed = !before ||
                    before.status !== (p.status || 'active') ||
                    (before.active ? 1 : 0) !== (p.active !== undefined ? (p.active ? 1 : 0) : 1) ||
                    (before.accepted_by || null) !== (p.accepted_by || p.acceptedBy || null) ||
                    (before.pending_transaction_id || null) !== (p.pending_transaction_id || p.pendingTransactionId || null) ||
                    (before.completed_at || null) !== (p.completed_at || p.completedAt || null) ||
                    (before.updated_at || null) !== (p.updated_at || p.updatedAt || null);
                if (changed) {
                    const { DeviceEventEmitter } = require('react-native');
                    DeviceEventEmitter.emit('sync_data_updated');
                }
            })
            .catch(() => null);
    }

    const row = await database.getFirstAsync<any>(`
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, a.callsign as accepted_by_callsign, a.avatar_url as accepted_by_avatar, m.joined_at
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        WHERE p.id = ?
    `, [id]);
    
    if (row) {
        row.authorFoundingNeeded = row.author_founding_needed === 1;
        row.author_energy_cycled = row.author_energy_cycled ?? 0;

        if (typeof row.photos === 'string') {
            try { 
                row.photos = JSON.parse(row.photos); 
                if (Array.isArray(row.photos)) {
                    row.photos = row.photos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
                }
            } catch (e) { row.photos = []; }
        }
    }
    return row;
}

function formatSystemMessage(
    systemType: string | null,
    metadataStr: string | null,
    myPubkey: string | null,
    fallbackInfo: {
        postAuthor?: string | null;
        postType?: string | null;
        latestTxBuyer?: string | null;
        latestTxSeller?: string | null;
        defaultText?: string | null;
    }
): string {
    let meta: any = null;
    if (metadataStr) {
        try { meta = JSON.parse(metadataStr); } catch {}
    }
    const amount = meta?.amount ?? '';
    const beansStr = amount ? `${amount} Beans` : 'Beans';

    if (systemType === 'ESCROW_FUNDED') {
        return `${beansStr} held in trust.`;
    }
    if (systemType === 'ESCROW_RELEASED') {
        const sellerPubkey = meta?.sellerPubkey || fallbackInfo.latestTxSeller || (fallbackInfo.postType === 'offer' ? fallbackInfo.postAuthor : null);
        const isSeller = myPubkey && sellerPubkey && myPubkey === sellerPubkey;
        if (isSeller) {
            return `Payment of ${beansStr} released to you.`;
        } else {
            return `Payment of ${beansStr} released to the provider.`;
        }
    }
    if (systemType === 'ESCROW_CANCELLED') {
        return `Trust hold cancelled and funds refunded.`;
    }
    
    // Fallback: clean up Ʀ or R in the ciphertext
    let txt = fallbackInfo.defaultText || '';
    if (txt.includes('Ʀ')) {
        txt = txt.replace(/Ʀ(\d+)/g, '$1 Beans').replace(/Ʀ/g, 'Beans');
    }
    if (txt.includes('Payment of R')) {
        txt = txt.replace(/Payment of R(\d+) released to the provider\./g, (_: string, amt: string) => {
            const sellerPubkey = meta?.sellerPubkey || fallbackInfo.latestTxSeller || (fallbackInfo.postType === 'offer' ? fallbackInfo.postAuthor : null);
            const isSeller = myPubkey && sellerPubkey && myPubkey === sellerPubkey;
            return `Payment of ${amt} Beans released to ${isSeller ? 'you' : 'the provider'}.`;
        });
        txt = txt.replace(/R(\d+) has been placed in escrow\./g, '$1 Beans held in trust.');
    }
    return txt;
}

export async function getConversations(myPubkey: string) {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(`
        SELECT c.id, c.name, c.post_id,
               COALESCE(p.title, c.post_title) as postTitle,
               COALESCE(
                   (SELECT mt2.status FROM marketplace_transactions mt2
                    WHERE mt2.post_id = c.post_id
                      AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                      AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                    ORDER BY mt2.created_at DESC LIMIT 1),
                   p.status,
                   c.post_status
               ) as postStatus,
               COALESCE(p.credits, c.post_credits) as postCredits,
               COALESCE(p.photos, c.post_photo) as postPhotos,
               m.ciphertext as lastMessage, m.nonce as lastNonce, m.type as lastMsgType, m.system_type as lastSysType, m.metadata as lastMetadata, MAX(m.timestamp) as timestamp,
               p.author_pubkey as postAuthor, p.type as postType,
               (SELECT mt3.buyer_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxBuyer,
               (SELECT mt3.seller_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxSeller,
        (SELECT memb.callsign FROM conversation_participants cp 
         LEFT JOIN members memb ON memb.public_key = cp.public_key
         WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherCallsign,
        (SELECT memb.avatar_url FROM conversation_participants cp 
         LEFT JOIN members memb ON memb.public_key = cp.public_key
         WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherAvatar,
        (SELECT memb.profile_updated_at FROM conversation_participants cp 
         LEFT JOIN members memb ON memb.public_key = cp.public_key
         WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherProfileUpdatedAt,
        (SELECT cp.public_key FROM conversation_participants cp 
         WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherPubkey,
        (SELECT COUNT(msg.id) FROM messages msg 
         WHERE msg.conversation_id = c.id 
         AND msg.author_pubkey != ?
         AND (msg.timestamp > IFNULL((SELECT last_read_at FROM conversation_participants WHERE conversation_id = c.id AND public_key = ?), '2000-01-01'))
        ) as unreadCount,
        mt.id as pendingTxId,
        mt.credits as pendingAmount,
        mt.buyer_pubkey as txBuyerPubkey,
        mt.seller_pubkey as txSellerPubkey,
        -- Has the current user already left a review for this post's trade?
        -- Derived from the durable ratings table (additive, survives sync) rather than the
        -- marketplace_transactions rated_by_* flag, which applyDelta overwrites from the server
        -- on every sync. A sync already in flight at end-of-trade can land after the optimistic
        -- flag set and reset it to 0, making the Leave Review prompt reappear even though the
        -- user already reviewed. A ratings row, once written, persists.
        -- Matches the server's own EXISTS check and the in-chat rating-submitted indicator.
        (SELECT CASE WHEN EXISTS(
            SELECT 1 FROM marketplace_transactions mt
            WHERE mt.status = 'completed'
              AND mt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
              AND mt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
              AND NOT EXISTS (
                  SELECT 1 FROM ratings r 
                  WHERE r.transaction_id = mt.id 
                    AND r.rater_pubkey = ?
              )
         ) THEN 0 ELSE 1 END) as hasRated,
        -- Whether this (now per-person) thread has any trade between its participants — drives
        -- the Transactions/Direct inbox tabs now that conversations are no longer post-keyed.
        (SELECT COUNT(*) FROM marketplace_transactions dmt
           WHERE dmt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
             AND dmt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)) as dealCount
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        LEFT JOIN posts p ON c.post_id = p.id
        LEFT JOIN marketplace_transactions mt ON mt.post_id = p.id AND mt.status = 'pending'
        WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
        GROUP BY c.id
        ORDER BY timestamp DESC
    `, [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);
    
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    // Pre-load identity so encrypted DM previews can be decrypted below.
    const previewIdentity = await loadIdentity();

    return rows.map(row => {
        let displayMsg = row.lastMessage ? '[Message]' : 'Started conversation';
        if (row.lastNonce && row.lastNonce.startsWith('plaintext')) {
            try {
                displayMsg = decodeUtf8(decodeBase64(row.lastMessage));
            } catch {
                displayMsg = '[Unreadable message]';
            }
        } else if (isEncryptedNonce(row.lastNonce)) {
            // v2-encrypted DM — only ever set on dm threads, so otherPubkey is THE peer.
            if (previewIdentity?.privateKey && row.otherPubkey) {
                try {
                    displayMsg = decryptDM(row.lastMessage, row.lastNonce, {
                        myEdPrivHex: previewIdentity.privateKey,
                        peerEdPubHex: row.otherPubkey,
                        conversationId: row.id,
                    });
                } catch (err) {
                    let decrypted = false;
                    if (row.lastMetadata) {
                        try {
                            const meta = JSON.parse(row.lastMetadata);
                            if (meta) {
                                if (meta.originalConversationId) {
                                    displayMsg = decryptDM(row.lastMessage, row.lastNonce, {
                                        myEdPrivHex: previewIdentity.privateKey,
                                        peerEdPubHex: row.otherPubkey,
                                        conversationId: meta.originalConversationId,
                                    });
                                    decrypted = true;
                                } else if (Array.isArray(meta.originalConversationIds)) {
                                    for (const legacyId of meta.originalConversationIds) {
                                        try {
                                            displayMsg = decryptDM(row.lastMessage, row.lastNonce, {
                                                myEdPrivHex: previewIdentity.privateKey,
                                                peerEdPubHex: row.otherPubkey,
                                                conversationId: legacyId,
                                            });
                                            decrypted = true;
                                            break;
                                        } catch (e) {}
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    if (!decrypted) {
                        displayMsg = '🔒 Encrypted message';
                    }
                }
            } else {
                displayMsg = '🔒 Encrypted message';
            }
        } else if (row.lastNonce === '00000') {
            displayMsg = formatSystemMessage(row.lastSysType, row.lastMetadata, myPubkey, {
                postAuthor: row.postAuthor,
                postType: row.postType,
                latestTxBuyer: row.latestTxBuyer,
                latestTxSeller: row.latestTxSeller,
                defaultText: row.lastMessage
            });
        }

        const isPayer = row.txBuyerPubkey === myPubkey;
        const isPayee = row.txSellerPubkey === myPubkey;

        // Extract first photo from post photos JSON
        let postPhoto: string | null = null;
        if (row.postPhotos) {
            try {
                const arr = Array.isArray(row.postPhotos) ? row.postPhotos : JSON.parse(row.postPhotos);
                if (arr.length > 0) {
                    const firstPhoto = arr[0];
                    postPhoto = firstPhoto && firstPhoto.startsWith('/') ? `${anchorUrl}${firstPhoto}` : firstPhoto;
                }
            } catch {}
        }

        return {
            id: row.id,
            postId: row.post_id,
            postTitle: row.postTitle,
            postStatus: row.postStatus,
            postCredits: row.postCredits,
            postPhoto,
            peer: row.name || row.otherCallsign || row.id.slice(0, 8),
            peerAvatar: row.otherAvatar || null,
            peerUpdatedAt: row.otherProfileUpdatedAt || null,
            peerPubkey: row.otherPubkey || null,
            lastMessage: displayMsg,
            lastMsgType: row.lastMsgType,
            lastSysType: row.lastSysType,
            timestamp: row.timestamp ? new Date(row.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'New',
            rawTimestamp: row.timestamp || null,
            unread: row.unreadCount || 0,
            // Escrow role metadata for "Action Required" section
            isPayer,
            isPayee,
            pendingAmount: row.pendingAmount || null,
            pendingTxId: row.pendingTxId || null,
            hasRated: row.hasRated > 0,
            dealCount: row.dealCount || 0,
        };
    });
}

/**
 * Per-deal action items for the inbox "Action Required" section, now that conversations are
 * consolidated per-person (so action lives at the deal level, not the thread level). Derives
 * from the locally-synced marketplace_transactions + ratings, and resolves each deal to the
 * single per-pair DM thread so the inbox can deep-link into it.
 */
export async function getActionableDeals(myPubkey: string): Promise<any[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(`
        SELECT mt.id as txId, mt.post_id as postId, mt.buyer_pubkey as buyerPubkey,
               mt.seller_pubkey as sellerPubkey, mt.credits as credits, mt.status as status,
               mt.post_title as postTitle,
               (SELECT c.id FROM conversations c
                  WHERE c.type = 'dm' AND c.post_id IS NULL
                    AND EXISTS(SELECT 1 FROM conversation_participants cpa WHERE cpa.conversation_id = c.id AND cpa.public_key = mt.buyer_pubkey)
                    AND EXISTS(SELECT 1 FROM conversation_participants cpb WHERE cpb.conversation_id = c.id AND cpb.public_key = mt.seller_pubkey)
                  LIMIT 1) as conversationId,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = ?) as iRated,
               (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END) as peerPubkey,
               (SELECT memb.callsign FROM members memb WHERE memb.public_key = (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END)) as peerCallsign,
               (SELECT memb.avatar_url FROM members memb WHERE memb.public_key = (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END)) as peerAvatar
        FROM marketplace_transactions mt
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
          AND mt.status IN ('pending', 'completed')
        ORDER BY mt.created_at DESC
    `, [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);

    return rows.map(r => {
        const iAmBuyer = r.buyerPubkey === myPubkey;
        let action: 'release' | 'fulfill' | 'review' | null = null;
        if (r.status === 'pending' && iAmBuyer) action = 'release';
        else if (r.status === 'pending' && !iAmBuyer) action = 'fulfill';
        else if (r.status === 'completed' && !r.iRated) action = 'review';
        return { ...r, iAmBuyer, action };
    }).filter(d => d.action && d.conversationId);
}

/**
 * All trades (any status) between me and one peer — powers the consolidated thread's pinned
 * "active deals" strip and lets the timeline label each escrow event by item.
 */
export async function getDealsBetween(myPubkey: string, peerPubkey: string): Promise<any[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(`
        SELECT mt.id as txId, mt.post_id as postId, mt.post_title as postTitle, mt.credits as credits,
               mt.status as status, mt.buyer_pubkey as buyerPubkey, mt.seller_pubkey as sellerPubkey,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = ?) as iRated
        FROM marketplace_transactions mt
        WHERE (mt.buyer_pubkey = ? AND mt.seller_pubkey = ?)
           OR (mt.buyer_pubkey = ? AND mt.seller_pubkey = ?)
        ORDER BY mt.created_at DESC
    `, [myPubkey, myPubkey, peerPubkey, peerPubkey, myPubkey]);
    return rows.map(r => ({ ...r, iAmBuyer: r.buyerPubkey === myPubkey, iRated: !!r.iRated }));
}

// Throttle server-side read-cursor pushes: chat screens call markConversationRead on
// every poll tick; one POST per conversation per 10s is plenty for read receipts.
const _lastReadPushAt: Record<string, number> = {};

export async function markConversationRead(conversationId: string, myPubkey: string) {
    const database = await getDb();
    const now = new Date().toISOString();
    await database.runAsync(
        'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ?',
        [now, conversationId, myPubkey]
    );

    // Push the read cursor to the server so the PEER's device can render the
    // double-tick. Without this the receipt loop never leaves this phone.
    const lastPush = _lastReadPushAt[conversationId] || 0;
    if (Date.now() - lastPush > 10_000) {
        _lastReadPushAt[conversationId] = Date.now();
        _signedRequest('/api/messages/mark-read', { pubkey: myPubkey, conversationId })
            .catch(() => { _lastReadPushAt[conversationId] = 0; /* offline — retry on next call */ });
    }
}

export async function getGlobalUnreadCount(myPubkey: string): Promise<number> {
    const database = await getDb();
    const result = await database.getFirstAsync<any>(`
        SELECT COUNT(m.id) as count
        FROM messages m
        JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
        WHERE cp.public_key = ? 
        AND m.author_pubkey != ?
        AND (m.timestamp > IFNULL(cp.last_read_at, '2000-01-01'))
    `, [myPubkey, myPubkey]);
    return result?.count || 0;
}

export async function refreshBalanceFromServer(pubkey: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return;
    try {
        const res = await fetch(`${anchorUrl}/api/ledger/balance/${pubkey}?_t=${Date.now()}`);
        if (!res.ok) return;
        const balData = await res.json();
        const database = await getDb();
        const commons = await database.getFirstAsync<any>('SELECT balance FROM accounts WHERE public_key = "COMMONS" OR public_key = "commons"');
        const row = await database.getFirstAsync<any>('SELECT balance, last_demurrage_epoch FROM accounts WHERE public_key = ?', [pubkey]);
        
        let changed = false;
        await acquireSyncLock();
        try {
            if (typeof balData.balance === 'number') {
                if (balData.balance !== (row?.balance || 0)) changed = true;
                await database.runAsync(
                    'INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)',
                    [pubkey, balData.balance, balData.last_demurrage_epoch || 0]
                );
            }
            if (typeof balData.commonsBalance === 'number') {
                if (balData.commonsBalance !== (commons?.balance || 0)) changed = true;
                await database.runAsync(
                    'INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)',
                    ['COMMONS', balData.commonsBalance, 0]
                );
            }
        } finally {
            releaseSyncLock();
        }
        
        if (balData.tier || balData.floor !== undefined) {
            let floor = -100;
            let tier = { name: 'Ghost', emoji: '👻', canGift: false, canInvite: false };
            const newTierStr = JSON.stringify({
                tier: balData.tier || tier,
                floor: balData.floor ?? floor,
                earnedCredit: balData.earnedCredit ?? 0,
                grantedCredit: balData.grantedCredit ?? 0,
                qualifiedValue: balData.qualifiedValue ?? 0,
                avgRating: balData.avgRating ?? 0,
                reviewCount: balData.reviewCount ?? 0,
                trustStats: balData.trustStats ?? null,
                isBlockedFromTrading: !!balData.isBlockedFromTrading,
                elderVouchedBy: balData.elderVouchedBy ?? null,
                canVouch: !!balData.canVouch,
                activated: !!balData.activated,
                hasLiveOffer: !!balData.hasLiveOffer,
                usableFloor: balData.usableFloor ?? balData.floor ?? floor,
                liveOffers: balData.liveOffers ?? 0,
                frozen: !!balData.frozen,
            });
            const prevTierStr = await AsyncStorage.getItem(`bp_tier_${pubkey}`);
            if (prevTierStr !== newTierStr) {
                await AsyncStorage.setItem(`bp_tier_${pubkey}`, newTierStr);
                changed = true;
            }
        }
        if (changed) {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        }
    } catch (e) {
        console.warn(`[refreshBalanceFromServer] Failed for ${pubkey}:`, e);
    }
}

export async function getBalance(pubkey: string) {
    const database = await getDb();
    const row = await database.getFirstAsync<any>('SELECT balance, last_demurrage_epoch FROM accounts WHERE public_key = ?', [pubkey]);
    const commons = await database.getFirstAsync<any>('SELECT balance FROM accounts WHERE public_key = "COMMONS" OR public_key = "commons"');
    
    // Store enriched data from server response
    let tier = { name: 'Ghost', emoji: '👻', canGift: false, canInvite: false };

    let floor = -100;
    let earnedCredit = 0;
    let grantedCredit = 0;
    let qualifiedValue = 0;
    let avgRating = 0;
    let reviewCount = 0;
    let isBlockedFromTrading = false;
    let elderVouchedBy: string | null = null;
    let canVouch = false;      // this account may hand out the -20/-50/-100 vouch floor
    let activated = false;     // has a credit line at all (earned/vouched/granted)
    let hasLiveOffer = false;  // has ≥1 live Offer posted (offer covenant)
    let usableFloor: number | undefined = undefined; // v3: offer-gated usable floor (≤ earned floor)
    let liveOffers = 0;        // v3: count of live Offers (drives the credit ladder)
    let frozen = false;        // v3: debt below usable floor → spending paused

    // Background fetch to ensure parity
    refreshBalanceFromServer(pubkey).catch(() => null);

    // Try to load cached tier data
    let trustStats: any = null;
    try {
        const cached = await AsyncStorage.getItem(`bp_tier_${pubkey}`);
        if (cached) {
            const parsed = JSON.parse(cached);
            tier = parsed.tier || tier;
            floor = parsed.floor ?? floor;
            earnedCredit = parsed.earnedCredit ?? 0;
            grantedCredit = parsed.grantedCredit ?? 0;
            qualifiedValue = parsed.qualifiedValue ?? 0;
            avgRating = parsed.avgRating ?? 0;
            reviewCount = parsed.reviewCount ?? 0;
            trustStats = parsed.trustStats ?? null;
            isBlockedFromTrading = !!parsed.isBlockedFromTrading;
            elderVouchedBy = parsed.elderVouchedBy ?? null;
            canVouch = !!parsed.canVouch;
            activated = !!parsed.activated;
            hasLiveOffer = !!parsed.hasLiveOffer;
            usableFloor = parsed.usableFloor ?? floor;
            liveOffers = parsed.liveOffers ?? 0;
            frozen = !!parsed.frozen;
        }
    } catch { /* ignore */ }

    return {
        balance: row?.balance || 0,
        floor,
        tier,
        earnedCredit,
        grantedCredit,
        qualifiedValue,
        avgRating,
        reviewCount,
        trustStats,
        commons: commons?.balance || 0,
        isBlockedFromTrading,
        elderVouchedBy,
        canVouch,
        activated,
        hasLiveOffer,
        usableFloor: usableFloor ?? floor,
        liveOffers,
        frozen,
    };
}

export async function getTransactions(pubkey: string) {
    const database = await getDb();
    
    // Background fetch to ensure quick sync of newly released Escrow credits
    const { DeviceEventEmitter } = require('react-native');
    AsyncStorage.getItem('beanpool_anchor_url').then(async (anchorUrl: string | null) => {
        if (!anchorUrl) return;
        try {
            const res = await fetch(`${anchorUrl}/api/ledger/transactions?publicKey=${pubkey}&limit=20&_t=${Date.now()}`);
            if (res.ok) {
                const txns = await res.json();
                if (Array.isArray(txns)) {
                    let newInserted = false;
                    for (const t of txns) {
                        try {
                            const result = await database.runAsync(
                                'INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                [t.id, t.from_pubkey || t.from, t.to_pubkey || t.to, t.amount, t.taxFee || t.tax_fee || 0, t.memo, t.timestamp]
                            );
                            if (result.changes > 0) newInserted = true;
                        } catch(e) {}
                    }
                    if (newInserted) {
                        DeviceEventEmitter.emit('sync_data_updated');
                    }
                }
            }
        } catch(e) {}
    });

    const rows = await database.getAllAsync<any>(`
        SELECT t.*, 
               CASE WHEN t.from_pubkey = ? THEN t.to_pubkey ELSE t.from_pubkey END as peer_pubkey,
               CASE WHEN t.to_pubkey = ? THEN 'credit' ELSE 'debit' END as type,
               m_peer.callsign as peer_callsign,
               mt.post_title,
               mt.buyer_pubkey,
               mt.seller_pubkey,
               mb.callsign as buyer_callsign,
               ms.callsign as seller_callsign
        FROM transactions t
        LEFT JOIN members m_peer ON (
            CASE WHEN t.from_pubkey = ? THEN t.to_pubkey ELSE t.from_pubkey END = m_peer.public_key
        )
        LEFT JOIN marketplace_transactions mt ON (
            (t.to_pubkey LIKE 'escrow_%' AND mt.id = SUBSTR(t.to_pubkey, 8)) OR
            (t.from_pubkey LIKE 'escrow_%' AND mt.id = SUBSTR(t.from_pubkey, 8)) OR
            (t.to_pubkey LIKE 'escrow_%' AND mt.post_id = SUBSTR(t.to_pubkey, 8)) OR
            (t.from_pubkey LIKE 'escrow_%' AND mt.post_id = SUBSTR(t.from_pubkey, 8))
        )
        LEFT JOIN members mb ON mt.buyer_pubkey = mb.public_key
        LEFT JOIN members ms ON mt.seller_pubkey = ms.public_key
        WHERE t.from_pubkey = ? OR t.to_pubkey = ?
        ORDER BY t.timestamp DESC
        LIMIT 50
    `, [pubkey, pubkey, pubkey, pubkey, pubkey, pubkey, pubkey]);
    
    return rows.map(row => {
        let peerName = row.peer_pubkey.slice(0, 8).toUpperCase();
        if (row.peer_pubkey.startsWith('escrow_')) {
            peerName = 'Held in Trust';
            if (row.post_title) {
                const isBuyer = pubkey === row.buyer_pubkey;
                const counterparty = isBuyer ? row.seller_callsign : row.buyer_callsign;
                if (counterparty) {
                    peerName = `Held in Trust: ${row.post_title} (${isBuyer ? 'to' : 'from'} ${counterparty})`;
                } else {
                    peerName = `Held in Trust: ${row.post_title}`;
                }
            }
        } else if (row.peer_pubkey.startsWith('project_')) {
            peerName = 'Project Wallet';
        } else if (row.peer_callsign) {
            peerName = row.peer_callsign;
        }
        
        let displayMemo = row.memo || '';
        displayMemo = displayMemo
            .replace(/escrow hold/gi, 'Held in trust')
            .replace(/escrow/gi, 'trust');

        return {
            id: row.id,
            type: row.type,
            amount: row.amount,
            taxFee: row.tax_fee || 0,
            peer: peerName,
            timestamp: new Date(row.timestamp).toLocaleDateString(),
            memo: displayMemo
        };
    });
}

export async function getMemberProfile(pubkey: string) {
    const database = await getDb();
    return await database.getFirstAsync<any>('SELECT * FROM members WHERE public_key = ?', [pubkey]);
}

/**
 * Viewer-aware Trust Profile for another member: tier, track record, completion
 * rate, mutual connections, "vouched in by", and a safety recommendation band.
 * Signed (the server uses the verified signer as the viewer for mutuals).
 * Returns null when off-grid or the member/endpoint is unavailable.
 */
export async function getTrustProfile(targetPubkey: string): Promise<any | null> {
    try {
        return await _signedRequest('/api/trust/profile', { targetPubkey });
    } catch (e) {
        return null;
    }
}

export async function getAllCommunityMembers(): Promise<{ publicKey: string; callsign: string }[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>("SELECT public_key, callsign FROM members WHERE status IS NULL OR status != 'pruned' ORDER BY callsign COLLATE NOCASE ASC");
    return rows.map(r => ({ publicKey: r.public_key, callsign: r.callsign }));
}

export async function sendTransfer(from: string, to: string, amount: number, memo: string) {
    const res = await _signedRequest('/api/ledger/transfer', { from, to, amount, memo });
    
    // Write new transaction and refresh balances
    try {
        const database = await getDb();
        
        // 1. Insert transaction into local DB so it shows up instantly
        if (res?.transaction) {
            const t = res.transaction;
            const fromKey = t.from_pubkey || t.from || null;
            const toKey = t.to_pubkey || t.to || null;
            const taxFee = t.taxFee ?? t.tax_fee ?? 0;
            await database.runAsync(
                'INSERT OR REPLACE INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [t.id || null, fromKey, toKey, t.amount || 0, taxFee, t.memo || null, t.timestamp || null]
            );
        }

        // 2. Refresh both parties' balances from server
        refreshBalanceFromServer(from).catch(() => null);
        refreshBalanceFromServer(to).catch(() => null);
        
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('transaction_completed');
        DeviceEventEmitter.emit('sync_data_updated');
    } catch (e) {
        console.warn('[Transfer] Transaction save / balance refresh failed:', e);
    }
    
    return res;
}

export async function updateMemberProfile(pubkey: string, data: { callsign: string, avatar_url?: string | null, bio?: string, contact_value?: string, contact_visibility?: string }) {
    const database = await getDb();
    
    // UPSERT basically because they might not exist locally yet if they haven't synced their own genesis block
    await database.runAsync(`
        INSERT INTO members (public_key, callsign, avatar_url, bio, contact_value, contact_visibility)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET
            callsign = excluded.callsign,
            avatar_url = excluded.avatar_url,
            bio = excluded.bio,
            contact_value = excluded.contact_value,
            contact_visibility = excluded.contact_visibility
    `, [pubkey, data.callsign, data.avatar_url || null, data.bio || null, data.contact_value || null, data.contact_visibility || 'hidden']);
}

export async function getProjects() {
    const database = await getDb();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    const rows = await database.getAllAsync<any>(`
        SELECT p.*, m.callsign as creator_callsign, m.avatar_url as creator_avatar
        FROM projects p
        LEFT JOIN members m ON p.creator_pubkey = m.public_key
        ORDER BY p.created_at DESC
    `);
    return rows.map(row => {
        let parsedPhotos = row.photos;
        if (typeof row.photos === 'string') {
            try { 
                parsedPhotos = JSON.parse(row.photos); 
                if (Array.isArray(parsedPhotos)) {
                    parsedPhotos = parsedPhotos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
                }
            } catch (e) { parsedPhotos = []; }
        }
        return {
            ...row,
            photos: parsedPhotos,
            goal: row.goal_amount,
            current: row.current_amount,
            type: 'community' // fallback mapping
        };
    });
}

export async function getProjectById(id: string) {
    const database = await getDb();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    const row = await database.getFirstAsync<any>(`
        SELECT p.*, m.callsign as creator_callsign, m.avatar_url as creator_avatar
        FROM projects p
        LEFT JOIN members m ON p.creator_pubkey = m.public_key
        WHERE p.id = ?;
    `, [id]);
    if (!row) return null;
    let parsedPhotos = row.photos;
    if (typeof row.photos === 'string') {
        try { 
            parsedPhotos = JSON.parse(row.photos); 
            if (Array.isArray(parsedPhotos)) {
                parsedPhotos = parsedPhotos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
            }
        } catch (e) { parsedPhotos = []; }
    }
    return {
        ...row,
        photos: parsedPhotos,
        goal: row.goal_amount,
        current: row.current_amount,
        type: 'community'
    };
}

export async function createPost(post: any) {
    const database = await getDb();

    // 1. Enforce Online Connection & Broadcast First
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to broadcast your post.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }

    const body = {
        id: post.id,
        type: post.type,
        category: post.category,
        title: post.title,
        description: post.description,
        credits: post.credits,
        priceType: post.price_type || 'fixed',
        authorPublicKey: post.author_pubkey,
        lat: post.lat,
        lng: post.lng,
        photos: post.photos ? JSON.parse(post.photos) : undefined,
        repeatable: post.repeatable === 1,
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/marketplace/posts', bodyString, identity.privateKey, identity.publicKey);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${anchorUrl}/api/marketplace/posts`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Network request failed or server rejected the post.';
            try {
                const json = JSON.parse(txt);
                if (json.error) errMsg = json.error;
            } catch (e) {
                if (txt) errMsg = txt;
            }
            // Auto-heal: server may not yet know about the user's avatar if the
            // onboarding publish failed. Push the profile and retry once.
            if (_isProfilePhotoError(errMsg)) {
                const healed = await _pushProfileToServer();
                if (healed) {
                    const retryHeaders = await buildSignedHeaders('POST', '/api/marketplace/posts', bodyString, identity.privateKey, identity.publicKey);
                    const retryRes = await fetch(`${anchorUrl}/api/marketplace/posts`, {
                        method: 'POST',
                        headers: retryHeaders,
                        body: bodyString,
                    });
                    if (retryRes.ok) {
                        // Fall through to local insert below
                    } else {
                        throw new Error(errMsg);
                    }
                } else {
                    throw new Error(errMsg);
                }
            } else {
                throw new Error(errMsg);
            }
        }
    } catch (e: any) {
        // If it fails (e.g., no internet or server error), bubble it up to the UI so we DON'T lose the drafted post!
        throw new Error(e.message || 'Network request failed. You must be connected to a node to post.');
    }

    // 2. Local Database Confirmation
    // Only save to SQLite AFTER the server has safely accepted it, preventing the background sync from wiping our un-synced draft
    await database.runAsync(
        `INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, lat, lng, price_type, repeatable, photos)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [post.id, post.type, post.category, post.title, post.description, post.credits,
         post.author_pubkey, post.created_at, post.lat || null, post.lng || null,
         post.price_type || 'fixed', post.repeatable || 0, post.photos || null]
    );
    refreshBalanceFromServer(post.author_pubkey).catch(() => null);
}

export async function createProject(project: {
    title: string;
    description: string;
    goal_amount: number;
    photos?: string[];
    deadline_at?: string | null;
}) {
    await waitForInit();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to propose your project.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }

    const projectId = Crypto.randomUUID();

    const body = {
        id: projectId,
        creatorPubkey: identity.publicKey,
        title: project.title,
        description: project.description,
        photos: project.photos || [],
        goalAmount: project.goal_amount,
        deadlineAt: project.deadline_at || null,
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/crowdfund/projects', bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
        res = await fetch(`${anchorUrl}/api/crowdfund/projects`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
    } catch (e: any) {
        throw new Error(e.message || 'Network request failed. You must be connected to a node to propose projects.');
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Network request failed or server rejected the project.';
        try {
            const json = JSON.parse(txt);
            if (json.error) errMsg = json.error;
        } catch (e) {
            if (txt) errMsg = txt;
        }
        throw new Error(errMsg);
    }

    // Save to SQLite
    await acquireSyncLock({ urgent: true }); // user pressed "create" — jump the sync queue
    try {
        const database = await getDb();
        await database.runAsync(
             `INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, status, created_at, deadline_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?)`,
             [projectId, identity.publicKey, project.title, project.description, JSON.stringify(project.photos || []), project.goal_amount, new Date().toISOString(), project.deadline_at || null]
        );
    } finally {
        releaseSyncLock();
    }
}


export async function updateCrowdfundProjectApi(
    projectId: string,
    title: string,
    description: string,
    photos: string[],
    goalAmount: number,
    deadlineAt?: string | null
) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to update your project.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }

    const body = {
        id: projectId,
        creatorPubkey: identity.publicKey,
        title,
        description,
        photos,
        goalAmount,
        deadlineAt: deadlineAt || null,
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/crowdfund/projects/update', bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
        res = await fetch(`${anchorUrl}/api/crowdfund/projects/update`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
    } catch (e: any) {
        throw new Error(e.message || 'Network request failed. You must be connected to a node to update projects.');
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Failed to update project.');
    }

    // Update local SQLite
    const database = await getDb();
    if (deadlineAt !== undefined) {
         await database.runAsync(
             `UPDATE projects SET title = ?, description = ?, photos = ?, goal_amount = ?, deadline_at = ?
              WHERE id = ? AND creator_pubkey = ?`,
             [title, description, JSON.stringify(photos), goalAmount, deadlineAt, projectId, identity.publicKey]
         );
    } else {
         await database.runAsync(
             `UPDATE projects SET title = ?, description = ?, photos = ?, goal_amount = ?
              WHERE id = ? AND creator_pubkey = ?`,
             [title, description, JSON.stringify(photos), goalAmount, projectId, identity.publicKey]
         );
    }
}

export async function deleteCrowdfundProjectApi(projectId: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to delete your project.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }

    const body = {
        id: projectId,
        creatorPubkey: identity.publicKey
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/crowdfund/projects/delete', bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
        res = await fetch(`${anchorUrl}/api/crowdfund/projects/delete`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
    } catch (e: any) {
        throw new Error(e.message || 'Network request failed. You must be connected to a node to delete projects.');
    } finally {
        clearTimeout(timeoutId);
    }
    
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to delete project: ${errorText}`);
    }
    
    // Local SQLite Cascade Delete
    const database = await getDb();
    await database.runAsync(`DELETE FROM projects WHERE id = ?;`, [projectId]);
}

export async function pledgeToCrowdfundProjectApi(projectId: string, amount: number, memo: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error("No identity block found");

    const res = await _signedRequest(`/api/crowdfund/projects/${projectId}/pledge`, { 
        fromPubkey: identity.publicKey, 
        amount: amount, 
        memo: memo 
    });

    const database = await getDb();
    await database.runAsync(
        'UPDATE projects SET current_amount = current_amount + ? WHERE id = ?',
        [amount, projectId]
    );

    const txId = Crypto.randomUUID();
    const dt = new Date().toISOString();
    await database.runAsync('INSERT INTO ledger_entries (id, timestamp, pubkey, amount, balance_after, memo, reference_id, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        txId, dt, identity.publicKey, -Math.abs(amount), 0, memo, projectId, 'pledge'
    ]);

    return res;
}

export async function getActiveVotingRound(): Promise<{ id: string; status: string; closesAt: string; projectIds: string[]; createdAt: string } | null> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return null;
    try {
        const res = await fetch(`${anchorUrl}/api/commons/rounds`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.activeRound || null;
    } catch {
        return null;
    }
}

export async function voteForProjectApi(projectId: string, votes: number) {
    const identity = await loadIdentity();
    if (!identity) throw new Error("No identity block found");

    const res = await _signedRequest(`/api/crowdfund/projects/vote`, {
        projectId,
        pubkey: identity.publicKey,
        votes
    });

    // In a local-first system, we might want to optimistically update the local DB
    // but the node's sync will update the project votes anyway.
    return res;
}

export async function updatePost(id: string, updates: any) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');

    // 1. Broadcast UPDATE to remote network
    await _signedRequest('/api/marketplace/posts/update', { 
        id, 
        authorPublicKey: identity.publicKey, 
        type: updates.type,
        category: updates.category,
        title: updates.title,
        description: updates.description,
        credits: updates.credits,
        priceType: updates.price_type || 'fixed',
        repeatable: updates.repeatable,
        photos: updates.photos ? JSON.parse(updates.photos) : undefined
    });

    // 2. Erase from local SQLite Cache (or gracefully update it)
    const database = await getDb();
    await database.runAsync(
        `UPDATE posts SET type = ?, category = ?, title = ?, description = ?, credits = ?, price_type = ?, repeatable = ?, photos = ? WHERE id = ?`,
        [updates.type, updates.category, updates.title, updates.description, updates.credits, updates.price_type || 'fixed', updates.repeatable ? 1 : 0, updates.photos || null, id]
    );
}

/** Pause an Offer (owner-only): drops it from the live feed and stops it counting toward the
 *  offer covenant / credit line (Trust Model v3). Reversible via resumePost. */
export async function pausePost(id: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    await _signedRequest('/api/marketplace/posts/pause', { postId: id, authorPublicKey: identity.publicKey });
    const database = await getDb();
    await database.runAsync(`UPDATE posts SET status = 'paused' WHERE id = ?`, [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

/** Re-activate a paused Offer (owner-only): back in the feed and counting toward the credit line. */
export async function resumePost(id: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    await _signedRequest('/api/marketplace/posts/resume', { postId: id, authorPublicKey: identity.publicKey });
    const database = await getDb();
    await database.runAsync(`UPDATE posts SET status = 'active' WHERE id = ?`, [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

export async function deletePost(id: string) {
    // 1. Enforce Online Connection & Broadcast First
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Action requires internet connection.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');

    const payload = JSON.stringify({ id, authorPublicKey: identity.publicKey });
    const headers = await buildSignedHeaders('POST', '/api/marketplace/posts/remove', payload, identity.privateKey, identity.publicKey);

    try {
        const res = await fetch(`${anchorUrl}/api/marketplace/posts/remove`, {
            method: 'POST',
            headers,
            body: payload
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to remove post on Node');
        }
    } catch (e: any) {
        throw new Error(`Offline or anchor node unreachable: ${e.message}`);
    }

    // 2. Erase from local SQLite Cache
    const database = await getDb();
    await database.runAsync('DELETE FROM posts WHERE id = ?', [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

export async function applyDelta(delta: any) {
    await acquireSyncLock();
    try {
        const database = await getDb();
        await database.withTransactionAsync(async () => {
            const txn = database;
// Full-replace sync: server response is the source of truth
    if (delta.accounts) {
        for (const acc of delta.accounts) {
            await txn.runAsync(
                'INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)',
                [acc.public_key ?? null, acc.balance ?? 0, acc.last_demurrage_epoch ?? 0]
            );
        }
    }
    
    if (delta.members && delta.members.length > 0) {
        const serverMemberSet = new Set();
        for (const m of delta.members) {
            const pk = m.publicKey || m.public_key || '';
            // Skip synthetic wallet entries (escrow/project accounts are not real members)
            if (pk.startsWith('escrow_') || pk.startsWith('project_')) continue;
            serverMemberSet.add(pk);
            const cs = m.callsign || '';
            const av = m.avatarUrl || m.avatar_url || null;
            const joinedAt = m.joinedAt || m.joined_at || null;
            const profileUpdatedAt = m.profileUpdatedAt || m.profile_updated_at || null;
            const ec = m.earnedCredit || m.earned_credit || 0;
            const evb = m.elderVouchedBy || m.elder_vouched_by || null;
            await txn.runAsync(
                `INSERT INTO members (public_key, callsign, avatar_url, joined_at, profile_updated_at, earned_credit, elder_vouched_by) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(public_key) DO UPDATE SET
                   callsign = excluded.callsign,
                   avatar_url = COALESCE(excluded.avatar_url, members.avatar_url),
                   joined_at = COALESCE(excluded.joined_at, members.joined_at),
                   profile_updated_at = COALESCE(excluded.profile_updated_at, members.profile_updated_at),
                   earned_credit = excluded.earned_credit,
                   elder_vouched_by = COALESCE(members.elder_vouched_by, excluded.elder_vouched_by)`,
                [pk, cs, av, joinedAt, profileUpdatedAt, ec, evb]
            );
        }

        // Garbage collect members no longer in the server's directory — but ONLY when the
        // caller marked this payload as the complete directory snapshot. Without this guard a
        // partial/paginated/transient member list would delete every local member absent from
        // it (including peers the user is mid-conversation with). Presence/absence drives
        // deletion here, so a non-authoritative list must never reach this loop.
        if (delta.membersComplete) {
            const localMembers = await txn.getAllAsync<{public_key:string}>('SELECT public_key FROM members');
            for (const lm of localMembers) {
                // Ensure we don't accidentally delete synthetic project accounts if any leaked in
                if (lm.public_key.startsWith('escrow_') || lm.public_key.startsWith('project_')) continue;

                if (!serverMemberSet.has(lm.public_key)) {
                    console.log(`[DB] applyDelta: deleting obsolete member ${lm.public_key} not present on server`);
                    await txn.runAsync('DELETE FROM members WHERE public_key = ?', [lm.public_key]);
                }
            }
        }
    }
    
    if (delta.transactions) {
            for (const t of delta.transactions) {
                const fromKey = t.from_pubkey || t.from || null;
                const toKey = t.to_pubkey || t.to || null;
                const taxFee = t.taxFee ?? t.tax_fee ?? 0;
                await txn.runAsync(
                    'INSERT OR REPLACE INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [t.id ?? null, fromKey, toKey, t.amount ?? 0, taxFee, t.memo ?? null, t.timestamp ?? null]
                );
            }
        }

        if (delta.posts !== undefined) {
            // Delta Sync: Server dataset only transmits modified rows.
            // Deleted posts are transmitted with active=0 and tombstoned here natively.
            for (const p of delta.posts) {
                await txn.runAsync(
                    'INSERT OR REPLACE INTO posts (id, type, category, title, description, credits, author_pubkey, lat, lng, photos, price_type, repeatable, status, active, accepted_by, accepted_by_callsign, accepted_at, completed_at, pending_transaction_id, created_at, updated_at, origin_node, author_energy_cycled, author_founding_needed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        p.id ?? null,
                        p.type ?? null,
                        p.category ?? null,
                        p.title ?? null,
                        p.description ?? '',
                        p.credits ?? 0,
                        p.author_pubkey || p.authorPubkey || p.authorPublicKey || null,
                        p.lat ?? null,
                        p.lng ?? null,
                        p.photos ? JSON.stringify(p.photos.filter((url: string) => !url.startsWith('file://'))) : null,
                        p.price_type || p.priceType || 'fixed',
                        p.repeatable ? 1 : 0,
                        p.status || 'active',
                        p.active !== undefined ? (p.active ? 1 : 0) : 1, // Defaulting to 1 if active boolean isn't provided
                        p.accepted_by || p.acceptedBy || null,
                        p.accepted_by_callsign || p.acceptedByCallsign || null,
                        p.accepted_at || p.acceptedAt || null,
                        p.completed_at || p.completedAt || null,
                        p.pending_transaction_id || p.pendingTransactionId || null,
                        p.created_at || p.createdAt || null,
                        p.updated_at || p.updatedAt || null,
                        p.origin_node || p.originNode || null,
                        p.author_energy_cycled ?? p.authorEnergyCycled ?? 0,
                        p.author_founding_needed !== undefined ? (p.author_founding_needed ? 1 : 0) : (p.authorFoundingNeeded ? 1 : 0)
                    ]
                );
            }
        }

        if (delta.marketplaceTransactions !== undefined) {
            console.log(`[DB] applying ${delta.marketplaceTransactions.length} marketplace_transactions...`);
            for (const tx of delta.marketplaceTransactions) {
                const incomingStatus = tx.status ?? 'pending';
                
                // Guard: Never downgrade a terminal status (completed/cancelled) back to pending/requested.
                // This prevents a stale sync payload from reverting a transaction the user just completed locally.
                const localRow = await txn.getFirstAsync<{ status: string }>('SELECT status FROM marketplace_transactions WHERE id = ?', [tx.id]);
                if (localRow) {
                    const terminalStates = ['completed', 'cancelled'];
                    const nonTerminalStates = ['pending', 'requested'];
                    if (terminalStates.includes(localRow.status) && nonTerminalStates.includes(incomingStatus)) {
                        console.log(`[DB] Skipping downgrade of tx ${tx.id}: local=${localRow.status}, incoming=${incomingStatus}`);
                        continue;
                    }
                }

                await txn.runAsync(
                    'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, completed_at, cover_image, rated_by_buyer, rated_by_seller, post_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        tx.id ?? null,
                        tx.postId ?? tx.post_id ?? null,
                        tx.buyerPublicKey ?? tx.buyerPubkey ?? tx.buyer_pubkey ?? null,
                        tx.sellerPublicKey ?? tx.sellerPubkey ?? tx.seller_pubkey ?? null,
                        tx.credits ?? 0,
                        tx.hours ?? null,
                        incomingStatus,
                        tx.createdAt ?? tx.created_at ?? new Date().toISOString(),
                        tx.completedAt ?? tx.completed_at ?? null,
                        tx.coverImage ?? tx.cover_image ?? null,
                        tx.ratedByBuyer ? 1 : 0,
                        tx.ratedBySeller ? 1 : 0,
                        tx.postTitle ?? tx.post_title ?? null
                    ]
                );

                // Heal corresponding post status to match terminal transaction status
                const associatedPostId = tx.postId ?? tx.post_id;
                if (associatedPostId) {
                    if (incomingStatus === 'completed') {
                        const postRow = await txn.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE id = ?', [associatedPostId]);
                        if (postRow && postRow.repeatable !== 1) {
                            await txn.runAsync("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?", [associatedPostId]);
                        } else if (postRow && postRow.repeatable === 1) {
                            await txn.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE id = ?", [associatedPostId]);
                        }
                    } else if (incomingStatus === 'cancelled') {
                        await txn.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE id = ?", [associatedPostId]);
                    }
                }
            }
        }

        if (delta.projects !== undefined) {
            for (const proj of delta.projects) {
                await txn.runAsync(
                    'INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, current_amount, deadline_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        proj.id ?? null,
                        proj.creatorPubkey ?? proj.creator_pubkey ?? null,
                        proj.title ?? null,
                        proj.description ?? '',
                        proj.photos ? JSON.stringify((typeof proj.photos === 'string' ? JSON.parse(proj.photos) : proj.photos).filter((url: string) => !url.startsWith('file://'))) : null,
                        proj.goalAmount ?? proj.goal_amount ?? 0,
                        proj.currentAmount ?? proj.current_amount ?? 0,
                        proj.deadlineAt ?? proj.deadline_at ?? null,
                        proj.status ?? 'ACTIVE',
                        proj.createdAt ?? proj.created_at ?? new Date().toISOString()
                    ]
                );
            }
        }

        // Sync friends (compact diff from server)
        if (delta.friends && Array.isArray(delta.friends)) {
            const identity = await loadIdentity();
            if (identity?.publicKey) {
                // Get current local friend pubkeys
                const localFriends = await txn.getAllAsync<any>(
                    'SELECT friend_pubkey FROM friends WHERE owner_pubkey = ?',
                    [identity.publicKey]
                );
                const localSet = new Set(localFriends.map((f: any) => f.friend_pubkey));
                const serverSet = new Set(delta.friends.map((f: any) => f.publicKey || f.friend_pubkey));

                // Add new friends from server
                for (const f of delta.friends) {
                    const fpk = f.publicKey || f.friend_pubkey;
                    if (!localSet.has(fpk)) {
                        await txn.runAsync(
                            'INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at, is_guardian) VALUES (?, ?, ?, ?)',
                            [identity.publicKey, fpk, f.addedAt || f.added_at || new Date().toISOString(), f.isGuardian ? 1 : 0]
                        );
                    }
                }

                // Note: We intentionally DO NOT delete local friends that are missing from the server payload.
                // Instead, we push them to the server to heal the state in case of offline additions.
                for (const local of localFriends) {
                    if (!serverSet.has(local.friend_pubkey)) {
                        _syncFriendToServer('add', identity.publicKey, local.friend_pubkey).catch(() => {});
                    }
                }
            }
        }

        // Sync ratings (compact diff from server)
        if (delta.ratings !== undefined && Array.isArray(delta.ratings)) {
            console.log(`[DB] applyDelta: applying ${delta.ratings.length} ratings...`);
            for (const r of delta.ratings) {
                const stars = r.stars ?? r.rating;
                if (!stars || stars < 1 || stars > 5) {
                    console.warn(`[DB] Skipping invalid rating from server:`, r);
                    continue;
                }
                const rId = r.id ?? null;
                const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                if (!rId || !targetPubkey || !raterPubkey) {
                    console.warn(`[DB] Skipping rating from server due to missing required keys:`, r);
                    continue;
                }
                await txn.runAsync(
                    'INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, stars, comment, role, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        rId,
                        targetPubkey,
                        raterPubkey,
                        stars,
                        r.comment ?? '',
                        r.role ?? 'provider',
                        r.transactionId ?? r.transaction_id ?? null,
                        r.createdAt ?? r.created_at ?? new Date().toISOString()
                    ]
                );
            }
        }

        console.log(`[DB] applyDelta: replaced posts table with ${delta.posts?.length || 0} posts from server`);
        });
    } finally {
        releaseSyncLock();
    }
}

// Returns only the fetched messages that would actually change a local row: new ids
// (or rows consolidated into this conversation), changed metadata (reactions/read
// flags), or a new edit. Runs WITHOUT the sync lock so the common poll outcome —
// "nothing changed" — never joins the write queue at all.
async function diffChangedMessages(database: SQLite.SQLiteDatabase, conversationId: string, messages: any[]): Promise<any[]> {
    const localRows = await database.getAllAsync<{ id: string; metadata: string | null; edited_at: string | null }>(
        'SELECT id, metadata, edited_at FROM messages WHERE conversation_id = ?',
        [conversationId]
    );
    const localById = new Map(localRows.map(r => [r.id, r]));
    return messages.filter((m: any) => {
        const local = localById.get(m.id);
        if (!local) return true;
        if ((m.metadata || null) !== (local.metadata || null)) return true;
        const editedAt = m.editedAt || m.edited_at || null;
        if (editedAt && editedAt !== local.edited_at) return true;
        return false;
    });
}

// Single-message upsert shared by the batch and single-conversation sync paths.
// metadata always refreshes (reactions/read-state). Content (ciphertext/nonce) only
// changes when the server sends a strictly-newer edit — so a stale in-flight sync
// carrying the pre-edit content can't revert a fresh edit.
async function upsertFetchedMessage(database: SQLite.SQLiteDatabase, conversationId: string, m: any) {
    await database.runAsync(
        `INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           metadata = excluded.metadata,
           ciphertext = CASE WHEN excluded.edited_at IS NOT NULL AND (messages.edited_at IS NULL OR excluded.edited_at >= messages.edited_at) THEN excluded.ciphertext ELSE messages.ciphertext END,
           nonce = CASE WHEN excluded.edited_at IS NOT NULL AND (messages.edited_at IS NULL OR excluded.edited_at >= messages.edited_at) THEN excluded.nonce ELSE messages.nonce END,
           edited_at = CASE WHEN excluded.edited_at IS NOT NULL AND (messages.edited_at IS NULL OR excluded.edited_at >= messages.edited_at) THEN excluded.edited_at ELSE messages.edited_at END`,
        [m.id, conversationId, m.author_pubkey || m.authorPubkey || '', m.ciphertext || '', m.nonce || '', m.type || 'text', m.systemType || m.system_type || null, m.metadata || null, m.timestamp || m.created_at || new Date().toISOString(), m.editedAt || m.edited_at || null]
    );
}

export async function syncMessages(publicKey: string) {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return;
        
        const expectedDbName = getDatabaseFilenameForNode(anchorUrl);
        const kLastMembersSync = `pillar_sync_${expectedDbName}_members_last_sync`;
        const lastMembersSync = await AsyncStorage.getItem(kLastMembersSync);
        
        let localMembersCount = 0;
        try {
            const database = await getDb();
            const membersRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM members');
            localMembersCount = membersRow?.count || 0;
        } catch (e) {}

        const shouldFetchMembers = !lastMembersSync || 
                                   (Date.now() - parseInt(lastMembersSync, 10)) > 3600_000 ||
                                   localMembersCount === 0;

        const controller1 = new AbortController();
        const timeout1 = setTimeout(() => controller1.abort(), 10000);
        
        let convRes;
        try {
            convRes = await fetch(`${anchorUrl}/api/messages/conversations/${publicKey}`, { headers: { 'Accept': 'application/json' }, signal: controller1.signal });
        } catch (e) {
            console.warn('[DB] conversations fetch failed:', e);
            clearTimeout(timeout1);
            return;
        }

        let dirRes = null;
        if (shouldFetchMembers) {
            try {
                dirRes = await fetch(`${anchorUrl}/api/members`, { headers: { 'Accept': 'application/json' }, signal: controller1.signal });
            } catch (e) {
                console.warn('[DB] members fetch failed:', e);
            }
        }
        clearTimeout(timeout1);
        
        if (dirRes && dirRes.ok) {
            try {
                const dirData = await dirRes.json();
                if (Array.isArray(dirData) && dirData.length > 0) {
                    await acquireSyncLock();
                    try {
                        const database = await getDb();
                        await database.withTransactionAsync(async () => {
                            const txn = database;
                            for (const m of dirData) {
                                const pk = m.publicKey || m.public_key || '';
                                const cs = m.callsign || '';
                                const av = m.avatarUrl || m.avatar_url || null;
                                const evb = m.elderVouchedBy || m.elder_vouched_by || null;
                                await txn.runAsync(
                                    `INSERT INTO members (public_key, callsign, avatar_url, elder_vouched_by) VALUES (?, ?, ?, ?)
                                     ON CONFLICT(public_key) DO UPDATE SET
                                       callsign = excluded.callsign,
                                       avatar_url = COALESCE(excluded.avatar_url, members.avatar_url),
                                       elder_vouched_by = COALESCE(members.elder_vouched_by, excluded.elder_vouched_by)`,
                                    [pk, cs, av, evb]
                                );
                            }
                        });
                        await AsyncStorage.setItem(kLastMembersSync, String(Date.now()));
                    } finally {
                        releaseSyncLock();
                    }
                }
            } catch (e) {}
        }

        if (!convRes.ok) return;
        
        const convData = await convRes.json();
        if (!convData.conversations) return;

        // Identity, so we can attribute the peer's read cursor (read receipts).
        const myIdentity = await loadIdentity();

        for (const conv of convData.conversations) {
            await acquireSyncLock();
            try {
                const database = await getDb();
                await database.withTransactionAsync(async () => {
                    const txn = database;
                    const localConv = await txn.getFirstAsync<any>('SELECT id FROM conversations WHERE id = ?', [conv.id]);
                    const postPhotoString = conv.postPhoto ? JSON.stringify([conv.postPhoto]) : null;
                    if (!localConv) {
                        await txn.runAsync(
                            'INSERT INTO conversations (id, type, post_id, name, created_by, created_at, post_title, post_status, post_photo, post_credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            [
                                conv.id,
                                conv.type || 'dm',
                                conv.postId || conv.post_id || null,
                                conv.name || null,
                                conv.createdBy || '',
                                conv.createdAt || new Date().toISOString(),
                                conv.postTitle || null,
                                conv.postStatus || null,
                                postPhotoString,
                                conv.postCredits || null
                            ]
                        );
                    } else {
                        await txn.runAsync(
                            'UPDATE conversations SET post_title = ?, post_status = ?, post_photo = ?, post_credits = ? WHERE id = ?',
                            [
                                conv.postTitle || null,
                                conv.postStatus || null,
                                postPhotoString,
                                conv.postCredits || null,
                                conv.id
                            ]
                        );
                    }
                    if (Array.isArray(conv.participants)) {
                        for (const pub of conv.participants) {
                            await txn.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conv.id, pub]);
                        }
                        // Read receipts: record the peer's read cursor (monotonic — never regress).
                        if (conv.peerLastReadAt && myIdentity?.publicKey) {
                            const peer = conv.participants.find((p: string) => p && p !== myIdentity.publicKey);
                            if (peer) {
                                await txn.runAsync(
                                    'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                                    [conv.peerLastReadAt, conv.id, peer, conv.peerLastReadAt]
                                );
                            }
                        }
                        // Update my own read cursor if it is returned and is newer
                        if (conv.myLastReadAt && myIdentity?.publicKey) {
                            await txn.runAsync(
                                'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                                [conv.myLastReadAt, conv.id, myIdentity.publicKey, conv.myLastReadAt]
                            );
                        }
                    }
                });
            } finally {
                releaseSyncLock();
            }
            
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 5000);
            let msgRes;
            try {
                msgRes = await fetch(`${anchorUrl}/api/messages/${conv.id}`, { headers: { 'Accept': 'application/json' }, signal: controller2.signal });
            } catch (err) {
                clearTimeout(timeout2);
                continue;
            }
            clearTimeout(timeout2);
            if (!msgRes.ok) continue;
            
            const msgData = await msgRes.json();
            const messages = msgData.messages;
            if (!Array.isArray(messages)) continue;

            // Diff outside the lock — unchanged conversations skip the write queue.
            const database = await getDb();
            const changed = await diffChangedMessages(database, conv.id, messages);
            if (changed.length === 0) continue;

            await acquireSyncLock();
            try {
                await database.withTransactionAsync(async () => {
                    for (const m of changed) {
                        await upsertFetchedMessage(database, conv.id, m);
                    }
                });
            } finally {
                releaseSyncLock();
            }
        }

        // Local cleanup of conversations that were deleted/consolidated on the server
        try {
            const serverIds = convData.conversations.map((c: any) => c.id);
            const database = await getDb();
            const localConvs = await database.getAllAsync<any>(
                'SELECT conversation_id FROM conversation_participants WHERE public_key = ?',
                [publicKey]
            );
            const localIds = localConvs.map(lc => lc.conversation_id);
            const toDelete = localIds.filter(id => !serverIds.includes(id));
            if (toDelete.length > 0) {
                console.log(`[Sync] Pruning ${toDelete.length} legacy/consolidated conversations locally...`);
                await acquireSyncLock();
                try {
                    await database.withTransactionAsync(async () => {
                        for (const id of toDelete) {
                            await database.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id]);
                            await database.runAsync('DELETE FROM conversation_participants WHERE conversation_id = ?', [id]);
                            await database.runAsync('DELETE FROM conversations WHERE id = ?', [id]);
                        }
                    });
                } finally {
                    releaseSyncLock();
                }
            }
        } catch (pruneErr) {
            console.error('[Sync] Failed to prune legacy conversations:', pruneErr);
        }

        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('sync_data_updated');
    } catch (err) {
        console.log('[Sync] Failed to pull messages natively', err);
    }
}

export async function syncSingleConversation(conversationId: string) {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const msgRes = await fetch(`${anchorUrl}/api/messages/${conversationId}`, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timeout);
        
        if (!msgRes.ok) return;
        
        const msgData = await msgRes.json();
        const messages = msgData.messages;
        if (!Array.isArray(messages)) return;

        const database = await getDb();

        // This runs every 3s while a chat is open (plus on every WS nudge), so the
        // no-change fast path matters: diff BEFORE taking the lock, and bail without
        // locking or emitting when the server state matches local. Re-upserting the
        // full history here on every tick is what built the 8–175s lock queues
        // observed on-device (2026-07-17).
        const changed = await diffChangedMessages(database, conversationId, messages);

        // Read receipts: apply peers' read cursors (newer servers include them),
        // so ticks flip to read while the chat is open. Monotonic — never regress.
        const myIdentity = await loadIdentity();
        const cursors = msgData.conversation?.readCursors;
        let cursorAdvances: Array<{ publicKey: string; lastReadAt: string }> = [];
        if (Array.isArray(cursors) && myIdentity?.publicKey) {
            const localCursors = await database.getAllAsync<{ public_key: string; last_read_at: string | null }>(
                'SELECT public_key, last_read_at FROM conversation_participants WHERE conversation_id = ?',
                [conversationId]
            );
            const localReadAt = new Map(localCursors.map(r => [r.public_key, r.last_read_at]));
            cursorAdvances = cursors.filter((cur: any) => {
                if (!cur?.publicKey || cur.publicKey === myIdentity.publicKey || !cur.lastReadAt) return false;
                if (!localReadAt.has(cur.publicKey)) return false; // no participant row to update
                const current = localReadAt.get(cur.publicKey);
                return current == null || current < cur.lastReadAt;
            });
        }

        if (changed.length === 0 && cursorAdvances.length === 0) return;

        await acquireSyncLock();
        try {
            // One transaction for the whole burst — a single commit instead of a
            // disk flush per message.
            await database.withTransactionAsync(async () => {
                for (const m of changed) {
                    await upsertFetchedMessage(database, conversationId, m);
                }
                for (const cur of cursorAdvances) {
                    await database.runAsync(
                        'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                        [cur.lastReadAt, conversationId, cur.publicKey, cur.lastReadAt]
                    );
                }
            });
        } finally {
            releaseSyncLock();
        }

        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('sync_data_updated');
    } catch (err) {
        // Silent catch for background polling
    }
}

export async function getConversation(id: string, myPubkey?: string) {
    const database = await getDb();
    if (myPubkey) {
        return await database.getFirstAsync<any>(`
            SELECT c.name, c.type as type, c.post_id as postId, p.title as postTitle,
            COALESCE(
                (SELECT mt2.status FROM marketplace_transactions mt2
                 WHERE mt2.post_id = c.post_id
                   AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                   AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                 ORDER BY mt2.created_at DESC LIMIT 1),
                p.status,
                c.post_status
            ) as postStatus,
            p.price_type, p.credits,
            (SELECT memb.callsign FROM conversation_participants cp 
             LEFT JOIN members memb ON memb.public_key = cp.public_key
             WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherCallsign,
            (SELECT cp.public_key FROM conversation_participants cp 
             WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherPubkey,
            (SELECT memb.avatar_url FROM conversation_participants cp 
             LEFT JOIN members memb ON memb.public_key = cp.public_key
             WHERE cp.conversation_id = c.id AND cp.public_key != ? LIMIT 1) as otherAvatar,
            mt.id as pendingTxId,
            mt.credits as pendingAmount,
            mt.buyer_pubkey as txBuyerPubkey,
            mt.seller_pubkey as txSellerPubkey
            FROM conversations c 
            LEFT JOIN posts p ON c.post_id = p.id
            LEFT JOIN marketplace_transactions mt ON mt.post_id = c.post_id AND mt.status = 'pending'
                AND (mt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                     AND mt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id))
            WHERE c.id = ?`, [myPubkey, myPubkey, myPubkey, id]);
    }
    return await database.getFirstAsync<any>('SELECT name, post_id as postId FROM conversations WHERE id = ?', [id]);
}

/**
 * Resolve the E2E key context for a conversation, or null if it isn't a clean
 * 2-party DM (groups/system threads stay plaintext-v1 for now). Used to encrypt
 * outgoing and decrypt incoming direct messages (NAT-1).
 */
async function getDmKeyContext(conversationId: string): Promise<DMKeyContext | null> {
    const identity = await loadIdentity();
    if (!identity?.publicKey || !identity?.privateKey) return null;
    const database = await getDb();
    const conv = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
    if (!conv || conv.type !== 'dm') return null;
    const parts = await database.getAllAsync<any>('SELECT public_key FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
    const peers = parts.map(p => p.public_key).filter((pk: string) => pk && pk !== identity.publicKey);
    if (peers.length !== 1) return null; // not a clean 2-party DM — don't encrypt
    return { myEdPrivHex: identity.privateKey, peerEdPubHex: peers[0], conversationId };
}

export async function getMessages(conversationId: string) {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        [conversationId]
    );
    // Load the DM key context once so v2-encrypted rows can be decrypted in the map below.
    let dmCtx: DMKeyContext | null = null;
    try { dmCtx = await getDmKeyContext(conversationId); } catch { dmCtx = null; }
    // Read receipts: my pubkey (to flag outgoing) + the peer's read cursor.
    let myPubkey: string | null = null;
    let peerLastReadAt: string | null = null;
    try {
        const identity = await loadIdentity();
        myPubkey = identity?.publicKey ?? null;
        if (dmCtx) {
            const peerRow = await database.getFirstAsync<any>(
                'SELECT last_read_at FROM conversation_participants WHERE conversation_id = ? AND public_key = ?',
                [conversationId, dmCtx.peerEdPubHex]
            );
            peerLastReadAt = peerRow?.last_read_at ?? null;
        }
    } catch {}

    // Resolve fallback post details for formatting system messages
    let fallbackInfo: any = {};
    try {
        const infoRow = await database.getFirstAsync<any>(
            `SELECT c.post_id, p.author_pubkey as postAuthor, p.type as postType,
                    (SELECT mt3.buyer_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxBuyer,
                    (SELECT mt3.seller_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxSeller
             FROM conversations c
             LEFT JOIN posts p ON c.post_id = p.id
             WHERE c.id = ? LIMIT 1`,
            [conversationId]
        );
        if (infoRow) {
            fallbackInfo = {
                postAuthor: infoRow.postAuthor,
                postType: infoRow.postType,
                latestTxBuyer: infoRow.latestTxBuyer,
                latestTxSeller: infoRow.latestTxSeller
            };
        }
    } catch {}

    return rows.map(row => {
        let displayTxt = row.ciphertext;
        if (row.nonce === '00000') {
            displayTxt = formatSystemMessage(row.system_type, row.metadata, myPubkey, {
                ...fallbackInfo,
                defaultText: row.ciphertext
            });
        } else if (row.nonce && row.nonce.startsWith('plaintext')) {
            try {
                displayTxt = decodeUtf8(decodeBase64(row.ciphertext));
            } catch {
                displayTxt = '[Unreadable message]';
            }
        } else if (isEncryptedNonce(row.nonce)) {
            if (dmCtx) {
                try {
                    displayTxt = decryptDM(row.ciphertext, row.nonce, dmCtx);
                } catch (err) {
                    // Decryption failed. Try using original conversation ID(s) from metadata (moved during consolidation)
                    let decrypted = false;
                    if (row.metadata) {
                        try {
                            const meta = JSON.parse(row.metadata);
                            if (meta) {
                                if (meta.originalConversationId) {
                                    const legacyCtx = { ...dmCtx, conversationId: meta.originalConversationId };
                                    displayTxt = decryptDM(row.ciphertext, row.nonce, legacyCtx);
                                    decrypted = true;
                                } else if (Array.isArray(meta.originalConversationIds)) {
                                    for (const legacyId of meta.originalConversationIds) {
                                        try {
                                            const legacyCtx = { ...dmCtx, conversationId: legacyId };
                                            displayTxt = decryptDM(row.ciphertext, row.nonce, legacyCtx);
                                            decrypted = true;
                                            break;
                                        } catch (e) {}
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    if (!decrypted) {
                        displayTxt = '[Unable to decrypt this message]';
                    }
                }
            } else {
                displayTxt = '[Encrypted — update your app to read]';
            }
        }
        const outgoing = !!myPubkey && row.author_pubkey === myPubkey;
        const readByPeer = outgoing && !!peerLastReadAt &&
            new Date(row.timestamp).getTime() <= new Date(peerLastReadAt).getTime();
        return {
            id: row.id,
            senderId: row.author_pubkey,
            text: displayTxt,
            type: row.type || 'text',
            systemType: row.system_type,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            outgoing,
            readByPeer,
            edited: !!row.edited_at,
            rawTimestamp: row.timestamp,
            timestamp: new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
    });
}

export async function insertMessage(conversationId: string, authorPubkey: string, text: string, metadata?: string) {
    const database = await getDb();

    // E2E-encrypt direct messages (NAT-1). Falls back to legacy plaintext-v1 for
    // group/system threads or if the peer key can't be resolved or crypto fails.
    let nonce: string;
    let ciphertext: string;
    try {
        const dmCtx = await getDmKeyContext(conversationId);
        if (dmCtx) {
            const enc = encryptDM(text, dmCtx);
            ciphertext = enc.ciphertext;
            nonce = enc.nonce;
        } else {
            nonce = 'plaintext-v1';
            ciphertext = encodeBase64(encodeUtf8(text));
        }
    } catch {
        nonce = 'plaintext-v1';
        ciphertext = encodeBase64(encodeUtf8(text));
    }

    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are off-grid. Please connect to a BeanPool Node to send messages.');
    }

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    const body = {
        conversationId,
        authorPubkey,
        ciphertext,
        nonce,
        metadata
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/messages/send', bodyString, identity.privateKey, identity.publicKey);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${anchorUrl}/api/messages/send`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Failed to deliver message.';
            try {
                const json = JSON.parse(txt);
                if (json.error) errMsg = json.error;
            } catch (e) {
                if (txt) errMsg = txt;
            }
            throw new Error(errMsg);
        }
        
        const data = await res.json();
        const serverMsg = data.message;
        
        // Safely write to physical storage since the node accepted it using the Server-vetted UUID
        await database.runAsync(
            'INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [serverMsg.id, conversationId, authorPubkey, ciphertext, nonce, metadata || null, serverMsg.timestamp]
        );
        
    } catch (e: any) {
        throw new Error(e.message || 'Network request failed. Message unable to be sent.');
    }
}

/**
 * Edit a previously-sent text message within the 5-minute window. Re-encrypts the new text with
 * the same DM key and posts to the node, which enforces the window against its own clock and
 * re-broadcasts to participants. The node-returned editedAt is mirrored locally so a sync that
 * was already in flight (with the pre-edit content) can't revert the change.
 */
export async function editMessage(conversationId: string, messageId: string, newText: string) {
    const database = await getDb();

    let nonce: string;
    let ciphertext: string;
    try {
        const dmCtx = await getDmKeyContext(conversationId);
        if (dmCtx) {
            const enc = encryptDM(newText, dmCtx);
            ciphertext = enc.ciphertext;
            nonce = enc.nonce;
        } else {
            nonce = 'plaintext-v1';
            ciphertext = encodeBase64(encodeUtf8(newText));
        }
    } catch {
        nonce = 'plaintext-v1';
        ciphertext = encodeBase64(encodeUtf8(newText));
    }

    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to edit messages.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    const body = { messageId, authorPubkey: identity.publicKey, ciphertext, nonce };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/messages/edit', bodyString, identity.privateKey, identity.publicKey);

    const res = await fetch(`${anchorUrl}/api/messages/edit`, { method: 'POST', headers, body: bodyString });
    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Failed to edit message.';
        try { const j = JSON.parse(txt); if (j.error) errMsg = j.error; } catch { if (txt) errMsg = txt; }
        throw new Error(errMsg);
    }
    const data = await res.json();
    const editedAt = data?.message?.editedAt || new Date().toISOString();
    await database.runAsync(
        'UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = ? WHERE id = ?',
        [ciphertext, nonce, editedAt, messageId]
    );
}

/**
 * Send an image in a DM (NAT-1 attachments). The image is E2E-encrypted with the
 * DM key and uploaded as a separate blob (lazy-loaded), so the node only ever holds
 * ciphertext and the message feed stays light. DM-only — encryption requires a peer key.
 */
export async function sendImageMessage(conversationId: string, dataUri: string, caption: string = '', metadata?: string) {
    const database = await getDb();
    const dmCtx = await getDmKeyContext(conversationId);
    if (!dmCtx) throw new Error('Photos can only be sent in direct messages.');

    const encImg = encryptDM(dataUri, dmCtx);   // big blob -> stored as attachment
    const encCap = encryptDM(caption, dmCtx);   // (optional) caption -> message body

    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to send messages.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    const body = {
        conversationId,
        authorPubkey: identity.publicKey,
        ciphertext: encCap.ciphertext,
        nonce: encCap.nonce,
        type: 'image',
        attachment: { data: encImg.ciphertext, nonce: encImg.nonce, mime: 'image/jpeg' },
        metadata
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/messages/send', bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}/api/messages/send`, { method: 'POST', headers, body: bodyString });
    if (!res.ok) {
        let errMsg = 'Failed to send image.';
        try { const j = JSON.parse(await res.text()); if (j.error) errMsg = j.error; } catch {}
        throw new Error(errMsg);
    }
    const serverMsg = (await res.json()).message;
    await database.runAsync(
        'INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [serverMsg.id, conversationId, identity.publicKey, encCap.ciphertext, encCap.nonce, 'image', metadata || null, serverMsg.timestamp]
    );
}

/**
 * Fetch + decrypt an image attachment for a DM message. Returns a data URI ready
 * for <Image>, or null if it can't be loaded/decrypted. The blob is fetched lazily
 * (only when an image bubble is rendered).
 */
export async function getDecryptedAttachment(conversationId: string, messageId: string): Promise<string | null> {
    try {
        // 1. Local cache first. Lives in the filesystem (survives a DB wipe-and-fetch), so an
        //    image is downloaded+decrypted at most once per device and re-opens instantly/offline.
        const cachePath = `${CHAT_IMAGE_CACHE_DIR}${messageId}.jpg`;
        const cached = await FileSystem.getInfoAsync(cachePath);
        if (cached.exists) return cachePath;

        // 2. Cache miss → fetch the encrypted blob + decrypt (lazy, on demand — never in bulk).
        const dmCtx = await getDmKeyContext(conversationId);
        if (!dmCtx) return null;
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return null;
        const res = await fetch(`${anchorUrl}/api/messages/${messageId}/attachment`, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const { data, nonce } = await res.json();

        // Query the message metadata to see if it has an originalConversationId/originalConversationIds
        let originalConversationId: string | null = null;
        let originalConversationIds: string[] | null = null;
        try {
            const database = await getDb();
            const msgRow = await database.getFirstAsync<any>('SELECT metadata FROM messages WHERE id = ?', [messageId]);
            if (msgRow?.metadata) {
                const meta = JSON.parse(msgRow.metadata);
                if (meta) {
                    if (meta.originalConversationId) {
                        originalConversationId = meta.originalConversationId;
                    }
                    if (Array.isArray(meta.originalConversationIds)) {
                        originalConversationIds = meta.originalConversationIds;
                    }
                }
            }
        } catch (e) {}

        let decrypted: string | null = null;
        try {
            decrypted = decryptDM(data, nonce, dmCtx);
        } catch (err) {
            if (originalConversationId) {
                try {
                    const legacyCtx = { ...dmCtx, conversationId: originalConversationId };
                    decrypted = decryptDM(data, nonce, legacyCtx);
                } catch (e) {}
            } else if (originalConversationIds) {
                for (const legacyId of originalConversationIds) {
                    try {
                        const legacyCtx = { ...dmCtx, conversationId: legacyId };
                        decrypted = decryptDM(data, nonce, legacyCtx);
                        break;
                    } catch (e) {}
                }
            }
        }
        if (!decrypted) return null;

        // 3. Persist to the filesystem cache. Decrypted-at-rest is acceptable: E2E protects the
        //    image from the NODE, and the device owner already views it. Falls back to the inline
        //    data URI if it isn't a recognised image payload (don't cache an unknown shape).
        const m = decrypted.match(/^data:image\/\w+;base64,(.*)$/);
        if (!m) return decrypted;
        try { await FileSystem.makeDirectoryAsync(CHAT_IMAGE_CACHE_DIR, { intermediates: true }); } catch {}
        await FileSystem.writeAsStringAsync(cachePath, m[1], { encoding: FileSystem.EncodingType.Base64 });
        return cachePath;
    } catch {
        return null;
    }
}

export async function createConversationApi(type: 'dm' | 'group', participants: string[], createdBy: string, name?: string, postId?: string): Promise<any> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a node first.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    const body: any = { type, participants, createdBy };
    if (name) body.name = name;
    if (postId) body.postId = postId;

    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', '/api/messages/conversation', bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch(`${anchorUrl}/api/messages/conversation`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Failed to create conversation thread.';
            try { const json = JSON.parse(txt); if (json.error) errMsg = json.error; } catch (e) { if (txt) errMsg = txt; }
            throw new Error(errMsg);
        }
        const data = await res.json();
        const conv = data.conversation;

        // Persist the conv + participants locally so the Inbox sees it
        // immediately, without waiting for the next syncMessages cycle.
        if (conv?.id) {
            const database = await getDb();
            let postTitle: string | null = null;
            let postStatus: string | null = null;
            let postPhoto: string | null = null;
            let postCredits: number | null = null;
            const pid = conv.postId || conv.post_id || postId;
            if (pid) {
                const post = await database.getFirstAsync<{ title: string, status: string, photos: string, credits: number }>('SELECT title, status, photos, credits FROM posts WHERE id = ?', [pid]);
                if (post) {
                    postTitle = post.title;
                    postStatus = post.status;
                    postCredits = post.credits;
                    if (post.photos) {
                        try {
                            const arr = JSON.parse(post.photos);
                            if (Array.isArray(arr) && arr.length > 0) postPhoto = JSON.stringify([arr[0]]);
                        } catch {}
                    }
                }
            }
            await database.runAsync(
                'INSERT OR IGNORE INTO conversations (id, type, post_id, name, created_by, created_at, post_title, post_status, post_photo, post_credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    conv.id,
                    conv.type || type,
                    pid || null,
                    conv.name || name || null,
                    conv.createdBy || createdBy,
                    conv.createdAt || new Date().toISOString(),
                    postTitle,
                    postStatus,
                    postPhoto,
                    postCredits
                ]
            );
            const partList: string[] = Array.isArray(conv.participants) && conv.participants.length > 0 ? conv.participants : participants;
            for (const pub of partList) {
                await database.runAsync(
                    'INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)',
                    [conv.id, pub]
                );
            }
        }

        return conv;
    } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(e.message || 'Network request failed when creating thread.');
    }
}

export interface InviteCheck {
    valid: boolean;
    reason?: 'invalid' | 'used' | 'expired' | 'unknown_inviter' | 'malformed';
    inviterCallsign?: string | null;
    communityName?: string | null;
}

// Pre-flight invite validation (Step 1 of onboarding), so a dud code fails
// before the user has done the name/photo/seed ceremony. Returns null when the
// answer is unknown (node unreachable, or an older node without the endpoint) —
// callers must fail OPEN and let redeemInvite give the definitive answer later.
export async function checkInvite(code: string, nodeUrl: string): Promise<InviteCheck | null> {
    try {
        const isOfflineTicket = code.startsWith('BP-') && code.length > 20;
        const payload = isOfflineTicket ? code.slice(3) : code;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(`${nodeUrl}/api/invite/check?code=${encodeURIComponent(payload)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (typeof data?.valid !== 'boolean') return null;
            return data;
        } finally {
            clearTimeout(timeoutId);
        }
    } catch {
        return null;
    }
}

export async function redeemInvite(code: string, callsign: string, identityToRegister?: any): Promise<boolean> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || (__DEV__ ? 'https://127.0.0.1:8443' : '');

        const identity = identityToRegister || await loadIdentity();
        if (!identity) throw new Error('No identity to register');

        const isOfflineTicket = code.startsWith('BP-') && code.length > 20;
        const codePayload = code.startsWith('BP-') ? code.slice(3) : code;
        const body = isOfflineTicket 
            ? { ticketB64: codePayload, publicKey: identity.publicKey, callsign }
            : { code: codePayload, publicKey: identity.publicKey, callsign };
        const bodyString = JSON.stringify(body);
        const endpoint = isOfflineTicket ? '/api/invite/redeem-offline' : '/api/invite/redeem';
        const headers = await buildSignedHeaders('POST', endpoint, bodyString, identity.privateKey, identity.publicKey);

        const res = await fetch(`${anchorUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: bodyString,
        });

        if (!res.ok) {
            let errorMsg = `Failed to redeem invite (HTTP ${res.status})`;
            if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 504) {
                errorMsg = `Relay Node Offline: The selected community node is currently unreachable (HTTP ${res.status}).`;
            } else {
                try {
                    const textBody = await res.text();
                    try {
                        const errJson = JSON.parse(textBody);
                        if (errJson.error) errorMsg = errJson.error;
                    } catch {
                        if (textBody.toLowerCase().includes('cloudflare') || textBody.toLowerCase().includes('<html')) {
                            errorMsg = `Relay Node Offline: The selected community node is currently unreachable.`;
                        } else {
                            errorMsg += `: [Text] ${textBody.substring(0, 100)}`;
                        }
                    }
                } catch (e: any) {
                    errorMsg += ` - Parse Error: ${e.message}`;
                }
            }
            throw new Error(errorMsg);
        }

        console.log('[DB] ✅ Invite redeemed successfully!');
        return true;
    } catch (e: any) {
        console.warn('[DB] Failed to redeem invite:', e.message);
        throw e;
    }
}

// ==========================================
// MARKETPLACE TRANSACTION AND RATING HELPERS
// ==========================================

// Push the user's locally-stored profile (callsign + avatar + bio + contact)
// to the anchor node. Returns true if the server accepted the update.
// Used both as a one-shot heal when marketplace actions fail with the
// "Please set a profile photo" error, and by pillar-sync's retry loop.
async function _pushProfileToServer(): Promise<boolean> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    const identity = await loadIdentity();
    if (!anchorUrl || !identity) return false;
    const profile = await getMemberProfile(identity.publicKey);
    if (!profile || !profile.avatar_url) return false;

    const payloadObj = {
        publicKey: identity.publicKey,
        avatar: profile.avatar_url,
        bio: profile.bio || '',
        contact: profile.contact_value
            ? { value: profile.contact_value, visibility: profile.contact_visibility || 'community' }
            : null,
        callsign: profile.callsign,
    };
    const bodyString = JSON.stringify(payloadObj);
    const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, identity.privateKey, identity.publicKey);
    try {
        const res = await fetch(`${anchorUrl}/api/profile/update`, {
            method: 'POST',
            headers,
            body: bodyString,
        });
        if (res.ok) {
            await AsyncStorage.removeItem('pending_profile_sync');
            return true;
        }
    } catch {}
    return false;
}

function _isProfilePhotoError(msg: string): boolean {
    return typeof msg === 'string' && /set a profile photo/i.test(msg);
}

async function _signedRequest(endpoint: string, payload: any) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to perform this action.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');

    const bodyString = JSON.stringify(payload);
    const headers = await buildSignedHeaders('POST', endpoint, bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    let res;
    try {
        res = await fetch(`${anchorUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal
        });
    } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(e.message || 'Network request failed. You must be connected to a node.');
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
        let errorMsg = `Server returned ${res.status}`;
        try {
            const errJson = await res.json();
            if (errJson.error) errorMsg = errJson.error;
        } catch {
            try {
                const txt = await res.text();
                if (txt) errorMsg = txt;
            } catch {}
        }
        // Auto-heal stale server profile: if the user has a local avatar but the
        // server doesn't know about it (common for users whose initial onboarding
        // publish failed), push the profile and retry the request once.
        if (_isProfilePhotoError(errorMsg)) {
            const healed = await _pushProfileToServer();
            if (healed) {
                const retryHeaders = await buildSignedHeaders('POST', endpoint, bodyString, identity.privateKey, identity.publicKey);
                const retryRes = await fetch(`${anchorUrl}${endpoint}`, {
                    method: 'POST',
                    headers: retryHeaders,
                    body: bodyString,
                });
                if (retryRes.ok) return await retryRes.json();
            }
        }
        throw new Error(errorMsg);
    }

    return await res.json();
}

// Public wrapper around _signedRequest for use by other modules in the app
// (e.g. push-notifications, settings prefs). Keeps signing centralized: any
// new client callsite that hits a signature-protected endpoint must come
// through here.
export async function signedRequest(endpoint: string, payload: any) {
    return _signedRequest(endpoint, payload);
}

// Vouch for a member at a level (1=-25, 2=-50, 3=-100). Signed POST — the server verifies the
// actor holds the vouch capability and rejects self-vouch. Optimistically mirrors the vouch
// locally so the badge/floor reflect immediately; applyDelta later reconciles from the server.
export async function vouchMember(targetPubkey: string, level: 1 | 2 | 3 = 1): Promise<{ success: boolean }> {
    const result = await _signedRequest('/api/profile/vouch', { targetPubkey, level });
    try {
        const identity = await loadIdentity();
        if (identity) {
            const database = await getDb();
            await database.runAsync(
                `UPDATE members SET elder_vouched_by = COALESCE(elder_vouched_by, ?) WHERE public_key = ?`,
                [identity.publicKey, targetPubkey]
            );
        }
    } catch {}
    return result;
}

export async function toggleMessageReactionApi(messageId: string, authorPubkey: string, emoji: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Offline');

    // 1. Optimistic local update
    const database = await getDb();
    const row = await database.getFirstAsync<any>('SELECT * FROM messages WHERE id=?', [messageId]);
    if (row) {
        let metadata: any = {};
        if (row.metadata) {
            try { metadata = JSON.parse(row.metadata); } catch { metadata = {}; }
        }
        if (!metadata.reactions) metadata.reactions = [];

        const idx = metadata.reactions.findIndex((r: any) => r.author === authorPubkey);
        if (idx > -1) {
            if (metadata.reactions[idx].emoji === emoji) {
                metadata.reactions.splice(idx, 1);
            } else {
                metadata.reactions[idx].emoji = emoji;
            }
        } else {
            metadata.reactions.push({ emoji, author: authorPubkey });
        }
        await database.runAsync('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify(metadata), messageId]);
    }

    // 2. Transmit to server via secure signed request
    return _signedRequest('/api/messages/react', { messageId, authorPubkey, emoji });
}

export async function acceptMarketplacePost(postId: string, buyerPublicKey: string, hours?: number) {
    const res = await _signedRequest('/api/marketplace/posts/accept', { postId, buyerPublicKey, hours });

    // Await the local write: callers navigate into the chat as soon as this resolves,
    // and the chat screen reads the pending tx from local SQLite. The write itself is
    // milliseconds; the FIFO sync lock guarantees it isn't starved by background syncs.
    try {
        await acquireSyncLock({ urgent: true }); // user is mid accept-and-navigate — jump the sync queue
        try {
            const database = await getDb();
            const txId = res?.transaction?.id || null;
            console.log(`[Escrow] Offer accepted — txId=${txId}, postId=${postId}`);
            const postParam = await database.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE id = ?', [postId]);
            if (postParam?.repeatable !== 1) {
                await database.runAsync(
                    "UPDATE posts SET status = 'pending', accepted_by = ?, pending_transaction_id = ? WHERE id = ?",
                    [buyerPublicKey, txId, postId]
                );
            }

            if (res?.transaction) {
                const tx = res.transaction;
                let postTitle: string | null = null;
                const postRow = await database.getFirstAsync<{ title: string }>('SELECT title FROM posts WHERE id = ?', [postId]);
                if (postRow) postTitle = postRow.title;
                await database.runAsync(
                    'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, cover_image, post_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [tx.id, tx.postId || postId, tx.buyerPublicKey || buyerPublicKey, tx.sellerPublicKey || null, tx.credits || 0, tx.hours || null, tx.status || 'pending', tx.createdAt || new Date().toISOString(), tx.coverImage || null, postTitle]
                );
            }

            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.error('[Escrow] acceptMarketplacePost local update failed:', e);
    }

    // Balance refresh is a network round-trip — keep it off the caller's critical path
    refreshBalanceFromServer(buyerPublicKey).catch(() => null);

    return res;
}

export async function completeMarketplaceTransaction(transactionId: string, confirmerPublicKey: string, finalHours?: number) {
    const res = await _signedRequest('/api/marketplace/transactions/complete', { transactionId, confirmerPublicKey, finalHours });
    console.log(`[Escrow] Server complete response: success=${res?.success}, txId=${res?.transaction?.id}`);

    // Await the local write so callers (and any screen they navigate to) read a
    // consistent status. The FIFO sync lock keeps this to milliseconds.
    try {
        await acquireSyncLock({ urgent: true }); // user just released credits — jump the sync queue
        try {
            const database = await getDb();
            const postParam = await database.getFirstAsync<{ repeatable: number, id: string }>('SELECT id, repeatable FROM posts WHERE pending_transaction_id = ?', [transactionId]);
            if (postParam && postParam.repeatable !== 1) {
                await database.runAsync("UPDATE posts SET status = 'completed' WHERE pending_transaction_id = ?", [transactionId]);
            }
            await database.runAsync("UPDATE marketplace_transactions SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), transactionId]);

            const buyerPubkey = res?.transaction?.buyerPublicKey || confirmerPublicKey;
            const sellerPubkey = res?.transaction?.sellerPublicKey || null;
            console.log(`[Escrow] Completing: buyer=${buyerPubkey?.slice(0,8)}, seller=${sellerPubkey?.slice(0,8)}, credits=${res?.transaction?.credits}`);

            // Emit events so Ledger screen refreshes immediately
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('transaction_completed');
            DeviceEventEmitter.emit('sync_data_updated');
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.error('[Escrow] completeMarketplaceTransaction local update failed:', e);
    }

    // Balance refreshes are network round-trips — keep them off the caller's critical path
    const buyerPubkey = res?.transaction?.buyerPublicKey || confirmerPublicKey;
    const sellerPubkey = res?.transaction?.sellerPublicKey || null;
    if (buyerPubkey) refreshBalanceFromServer(buyerPubkey).catch(() => null);
    if (sellerPubkey) refreshBalanceFromServer(sellerPubkey).catch(() => null);

    return res;
}

export async function cancelMarketplaceTransaction(transactionId: string, cancellerPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/cancel', { transactionId, cancellerPublicKey });

    try {
        await acquireSyncLock({ urgent: true }); // user just cancelled the deal — jump the sync queue
        try {
            const database = await getDb();
            const postParam = await database.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE pending_transaction_id = ?', [transactionId]);
            if (postParam && postParam.repeatable !== 1) {
                await database.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE pending_transaction_id = ?", [transactionId]);
            }
            await database.runAsync("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = ?", [transactionId]);

            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.error('[Escrow] cancelMarketplaceTransaction local update failed:', e);
    }

    return res;
}

export async function requestMarketplacePost(postId: string, buyerPublicKey: string, hours?: number) {
    // Unlike 'accept', requesting does not lock the post. It just creates a requested transaction.
    const res = await _signedRequest('/api/marketplace/posts/request', { postId, buyerPublicKey, hours });

    try {
        await acquireSyncLock({ urgent: true }); // user just requested the post — jump the sync queue
        try {
            const database = await getDb();
            if (res?.transaction) {
                const tx = res.transaction;
                let postTitle: string | null = null;
                const postRow = await database.getFirstAsync<{ title: string }>('SELECT title FROM posts WHERE id = ?', [postId]);
                if (postRow) postTitle = postRow.title;
                await database.runAsync(
                    'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, hours, status, created_at, cover_image, post_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [tx.id, tx.postId || postId, tx.buyerPublicKey || buyerPublicKey, tx.sellerPublicKey || null, tx.credits || 0, tx.hours || null, tx.status || 'requested', tx.createdAt || new Date().toISOString(), tx.coverImage || null, postTitle]
                );
            }
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.warn('[Escrow] Failed to save requested transaction locally:', e);
    }

    return res;
}

export async function approveMarketplaceRequest(transactionId: string, authorPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/approve', { transactionId, authorPublicKey });
    try {
        const database = await getDb();
        // The transaction becomes pending, and the post becomes pending unless repeatable.
        const postParam = await database.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE id = (SELECT post_id FROM marketplace_transactions WHERE id = ?)', [transactionId]);
        if (postParam?.repeatable !== 1) {
            await database.runAsync("UPDATE posts SET status = 'pending', pending_transaction_id = ? WHERE id = (SELECT post_id FROM marketplace_transactions WHERE id = ?)", [transactionId, transactionId]);
        }
        await database.runAsync("UPDATE marketplace_transactions SET status = 'pending' WHERE id = ?", [transactionId]);
    } catch(e) {}
    return res;
}

export async function rejectMarketplaceRequest(transactionId: string, authorPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/reject', { transactionId, authorPublicKey });
    try {
        const database = await getDb();
        await database.runAsync("UPDATE marketplace_transactions SET status = 'rejected' WHERE id = ?", [transactionId]);
    } catch(e) {}
    return res;
}

export async function cancelMarketplaceRequest(transactionId: string, buyerPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/cancel-request', { transactionId, buyerPublicKey });
    try {
        const database = await getDb();
        await database.runAsync("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = ?", [transactionId]);
    } catch(e) {}
    return res;
}

export async function reportAbuse(reporterPublicKey: string, targetPublicKey: string, reason: string, postId?: string) {
    return _signedRequest('/api/reports', { reporterPubkey: reporterPublicKey, targetPubkey: targetPublicKey, reason, targetPostId: postId });
}


export async function submitRating(raterPublicKey: string, targetPublicKey: string, rating: number, comment: string, transactionId?: string) {
    const res = await _signedRequest('/api/ratings', { raterPubkey: raterPublicKey, targetPubkey: targetPublicKey, stars: rating, comment, transactionId });
    if (res?.success && transactionId) {
        await acquireSyncLock({ urgent: true }); // user just submitted a review — jump the sync queue
        try {
            const database = await getDb();
            await database.withTransactionAsync(async () => {
                await database.runAsync(`
                    UPDATE marketplace_transactions 
                    SET rated_by_buyer = CASE WHEN buyer_pubkey = ? THEN 1 ELSE rated_by_buyer END,
                        rated_by_seller = CASE WHEN seller_pubkey = ? THEN 1 ELSE rated_by_seller END
                    WHERE id = ?
                `, [raterPublicKey, raterPublicKey, transactionId]);
                console.log(`[Rating] Optimistically marked tx ${transactionId} as rated in local SQLite`);

                if (res.rating) {
                    const r = res.rating;
                    const stars = r.stars ?? r.rating;
                    if (stars && stars >= 1 && stars <= 5 && r.id && r.targetPubkey && r.raterPubkey) {
                        await database.runAsync(`
                            INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            r.id,
                            r.targetPubkey,
                            r.raterPubkey,
                            r.role ?? 'provider',
                            stars,
                            r.comment ?? null,
                            r.transactionId ?? r.transaction_id ?? null,
                            r.createdAt ?? r.created_at ?? new Date().toISOString()
                        ]);
                        console.log(`[Rating] Inserted rating ${r.id} into local SQLite ratings table`);
                    }
                }
            });
        } catch (e) {
            console.warn('[Rating] Local DB rating state update failed:', e);
        } finally {
            releaseSyncLock();
        }
    }
    return res;
}

export async function getMemberRatings(publicKey: string): Promise<{ ratings: any[]; average: number; count: number; asProvider: { average: number; count: number }; asReceiver: { average: number; count: number } }> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        await acquireSyncLock();
        try {
            const database = await getDb();
            const rows = await database.getAllAsync<any>(`
                SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                       m.callsign as rater_callsign, m.avatar_url as rater_avatar
                FROM ratings r
                LEFT JOIN members m ON r.rater_pubkey = m.public_key
                WHERE r.target_pubkey = ?
                ORDER BY r.created_at DESC
            `, [publicKey]);
            
            const count = rows.length;
            const average = count > 0 ? rows.reduce((sum, r) => sum + r.stars, 0) / count : 0;
            const provRows = rows.filter(r => r.role === 'provider');
            const recvRows = rows.filter(r => r.role === 'receiver');
            const provAvg = provRows.length > 0 ? provRows.reduce((sum, r) => sum + r.stars, 0) / provRows.length : 0;
            const recvAvg = recvRows.length > 0 ? recvRows.reduce((sum, r) => sum + r.stars, 0) / recvRows.length : 0;
            
            return {
                ratings: rows.map(r => ({
                    id: r.id,
                    targetPubkey: r.target_pubkey,
                    raterPubkey: r.rater_pubkey,
                    stars: r.stars,
                    comment: r.comment,
                    role: r.role,
                    transactionId: r.transaction_id,
                    createdAt: r.created_at,
                    rater_callsign: r.rater_callsign || 'Unknown',
                    rater_avatar: r.rater_avatar || null
                })),
                average,
                count,
                asProvider: { average: provAvg, count: provRows.length },
                asReceiver: { average: recvAvg, count: recvRows.length }
            };
        } catch (e) {
            return { ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } };
        } finally {
            releaseSyncLock();
        }
    }
    
    try {
        const res = await fetch(`${anchorUrl}/api/ratings/${publicKey}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (!res.ok) {
            throw new Error(`Failed to fetch ratings: ${res.statusText}`);
        }
        const data = await res.json();
        if (data.ratings) {
            await acquireSyncLock();
            try {
                const database = await getDb();
                await database.withTransactionAsync(async () => {
                    for (const r of data.ratings) {
                        const stars = r.stars ?? r.rating;
                        if (!stars || stars < 1 || stars > 5) {
                            console.warn(`[DB] Skipping invalid rating in getMemberRatings:`, r);
                            continue;
                        }
                        const rId = r.id ?? null;
                        const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                        const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                        if (!rId || !targetPubkey || !raterPubkey) {
                            console.warn(`[DB] Skipping rating due to missing required keys in getMemberRatings:`, r);
                            continue;
                        }
                        await database.runAsync(`
                            INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            rId,
                            targetPubkey,
                            raterPubkey,
                            r.role ?? 'provider',
                            stars,
                            r.comment ?? null,
                            r.transactionId ?? r.transaction_id ?? null,
                            r.createdAt ?? r.created_at ?? new Date().toISOString()
                        ]);
                    }
                });
            } finally {
                releaseSyncLock();
            }
        }
        return data;
    } catch (e: any) {
        console.warn('Failed to fetch ratings, defaulting to local DB:', e.message);
        await acquireSyncLock();
        try {
            const database = await getDb();
            const rows = await database.getAllAsync<any>(`
                SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                       m.callsign as rater_callsign, m.avatar_url as rater_avatar
                FROM ratings r
                LEFT JOIN members m ON r.rater_pubkey = m.public_key
                WHERE r.target_pubkey = ?
                ORDER BY r.created_at DESC
            `, [publicKey]);
            
            const count = rows.length;
            const average = count > 0 ? rows.reduce((sum, r) => sum + r.stars, 0) / count : 0;
            const provRows = rows.filter(r => r.role === 'provider');
            const recvRows = rows.filter(r => r.role === 'receiver');
            const provAvg = provRows.length > 0 ? provRows.reduce((sum, r) => sum + r.stars, 0) / provRows.length : 0;
            const recvAvg = recvRows.length > 0 ? recvRows.reduce((sum, r) => sum + r.stars, 0) / recvRows.length : 0;
            
            return {
                ratings: rows.map(r => ({
                    id: r.id,
                    targetPubkey: r.target_pubkey,
                    raterPubkey: r.rater_pubkey,
                    stars: r.stars,
                    comment: r.comment,
                    role: r.role,
                    transactionId: r.transaction_id,
                    createdAt: r.created_at,
                    rater_callsign: r.rater_callsign || 'Unknown',
                    rater_avatar: r.rater_avatar || null
                })),
                average,
                count,
                asProvider: { average: provAvg, count: provRows.length },
                asReceiver: { average: recvAvg, count: recvRows.length }
            };
        } catch (localErr) {
            return { ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } };
        } finally {
            releaseSyncLock();
        }
    }
}

/** Reviews the given member has WRITTEN about others, newest first. */
export async function getRatingsGiven(raterPubkey: string): Promise<any[]> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (anchorUrl) {
        try {
            const res = await fetch(`${anchorUrl}/api/ratings/${raterPubkey}?direction=given`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                const data = await res.json();
                if (data.ratings) {
                    await acquireSyncLock();
                    try {
                        const database = await getDb();
                        await database.withTransactionAsync(async () => {
                            for (const r of data.ratings) {
                                const stars = r.stars ?? r.rating;
                                if (!stars || stars < 1 || stars > 5) {
                                    console.warn(`[DB] Skipping invalid rating in getRatingsGiven:`, r);
                                    continue;
                                }
                                const rId = r.id ?? null;
                                const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                                const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                                if (!rId || !targetPubkey || !raterPubkey) {
                                    console.warn(`[DB] Skipping rating due to missing required keys in getRatingsGiven:`, r);
                                    continue;
                                }
                                await database.runAsync(`
                                    INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                `, [
                                    rId,
                                    targetPubkey,
                                    raterPubkey,
                                    r.role ?? 'provider',
                                    stars,
                                    r.comment ?? null,
                                    r.transactionId ?? r.transaction_id ?? null,
                                    r.createdAt ?? r.created_at ?? new Date().toISOString()
                                ]);
                            }
                        });
                    } finally {
                        releaseSyncLock();
                    }
                    
                    return data.ratings.map((r: any) => ({
                        id: r.id,
                        target_pubkey: r.targetPubkey || r.target_pubkey,
                        rater_pubkey: r.raterPubkey || r.rater_pubkey,
                        stars: r.stars,
                        comment: r.comment,
                        role: r.role,
                        transaction_id: r.transactionId || r.transaction_id,
                        created_at: r.createdAt || r.created_at,
                        target_callsign: r.target_callsign || r.targetCallsign || 'Unknown',
                        target_avatar: r.target_avatar || r.targetAvatar || null
                    }));
                }
            }
        } catch (e: any) {
            console.warn('Failed to fetch given ratings from server, falling back to local DB:', e.message);
        }
    }

    await acquireSyncLock();
    try {
        const database = await getDb();
        return await database.getAllAsync<any>(`
            SELECT r.id, r.target_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                   m.callsign as target_callsign, m.avatar_url as target_avatar
            FROM ratings r
            LEFT JOIN members m ON r.target_pubkey = m.public_key
            WHERE r.rater_pubkey = ?
            ORDER BY r.created_at DESC
        `, [raterPubkey]);
    } catch (e) {
        console.warn('getRatingsGiven failed:', e);
        return [];
    } finally {
        releaseSyncLock();
    }
}

export async function getMarketplaceTransactions(publicKey: string, filter?: { status?: string }, limit = 50, offset = 0) {
    const database = await getDb();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    let query = `
        SELECT mt.*, COALESCE(p.title, mt.post_title) as postTitle, p.photos as postPhotos, m1.callsign as buyerCallsign, m1.avatar_url as buyerAvatar, m2.callsign as sellerCallsign, m2.avatar_url as sellerAvatar,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
    `;
    const params: any[] = [publicKey, publicKey];
    if (filter?.status) { 
        query += " AND mt.status = ?"; 
        params.push(filter.status); 
    }
    query += " ORDER BY mt.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = await database.getAllAsync<any>(query, params);
    return rows.map(r => {
        let coverImg = r.cover_image;
        if (!coverImg && r.postPhotos) {
            try { 
                const arr = Array.isArray(r.postPhotos) ? r.postPhotos : JSON.parse(r.postPhotos); 
                if (arr.length > 0) coverImg = arr[0]; 
            } catch {}
        }
        if (coverImg && coverImg.startsWith('/')) {
            coverImg = `${anchorUrl}${coverImg}`;
        }
        return {
            id: r.id, 
            postId: r.post_id, 
            postTitle: r.postTitle, 
            buyerPublicKey: r.buyer_pubkey, 
            buyerCallsign: r.buyerCallsign, 
            sellerPublicKey: r.seller_pubkey, 
            sellerCallsign: r.sellerCallsign, 
            credits: r.credits, 
            status: r.status, 
            createdAt: r.created_at, 
            completedAt: r.completed_at,
            coverImage: coverImg,
            buyerAvatar: r.buyerAvatar || null,
            sellerAvatar: r.sellerAvatar || null,
            ratedByBuyer: !!r.ratedByBuyer,
            ratedBySeller: !!r.ratedBySeller
        };
    });
}

// ===================== FINANCIALS =====================

/**
 * Return pledge history for a user: transactions sent to project_ wallets.
 * Joins to the local projects table to get project titles.
 */
export async function getPledgeHistory(pubkey: string) {
    const database = await getDb();
    // Pledges are recorded as ledger transfers from the member to 'project_<id>'
    const rows = await database.getAllAsync<any>(
        `SELECT t.id, t.amount, t.memo, t.timestamp,
                REPLACE(t.to_pubkey, 'project_', '') as project_id,
                p.title as projectTitle
         FROM transactions t
         LEFT JOIN projects p ON p.id = REPLACE(t.to_pubkey, 'project_', '')
         WHERE t.from_pubkey = ? AND t.to_pubkey LIKE 'project_%'
         ORDER BY t.timestamp DESC LIMIT 50`,
        [pubkey]
    );
    return rows.map(r => ({
        id: r.id,
        amount: r.amount,
        projectId: r.project_id,
        projectTitle: r.projectTitle || 'Community Project',
        timestamp: r.timestamp,
        memo: r.memo,
    }));
}

/**
 * Return total beans the user currently has locked in active marketplace escrow.
 * Escrow is created when a buyer requests a post (status = 'pending' or 'requested').
 */
export async function getEscrowTotal(pubkey: string): Promise<number> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(
        `SELECT COALESCE(SUM(credits), 0) as total
         FROM marketplace_transactions
         WHERE buyer_pubkey = ? AND status IN ('pending', 'requested')`,
        [pubkey]
    );
    return rows[0]?.total ?? 0;
}

// ===================== FRIENDS =====================

/** Get all friends from local SQLite (INNER JOIN to avoid ghost friends) */
export async function getFriendsLocal(ownerPubkey: string): Promise<any[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(
        `SELECT f.friend_pubkey as publicKey, m.callsign, m.avatar_url, f.added_at as addedAt, f.is_guardian as isGuardian, m.joined_at as joinedAt
         FROM friends f
         INNER JOIN members m ON f.friend_pubkey = m.public_key
         WHERE f.owner_pubkey = ?
         ORDER BY f.added_at DESC`,
        [ownerPubkey]
    );
    return rows.map((r: any) => ({
        ...r,
        isGuardian: !!r.isGuardian,
    }));
}

/** Check if a pubkey is a friend */
export async function isFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<boolean> {
    const database = await getDb();
    const row = await database.getFirstAsync<any>(
        'SELECT 1 FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?',
        [ownerPubkey, friendPubkey]
    );
    return !!row;
}

/** Add a friend locally + sync to server */
export async function addFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<void> {
    if (ownerPubkey === friendPubkey) return;
    const database = await getDb();
    await database.runAsync(
        'INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)',
        [ownerPubkey, friendPubkey, new Date().toISOString()]
    );
    // Fire-and-forget server sync
    _syncFriendToServer('add', ownerPubkey, friendPubkey).catch(e => console.warn('[Friends] Server sync failed:', e.message));
}

/** Remove a friend locally + sync to server */
export async function removeFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<void> {
    const database = await getDb();
    await database.runAsync(
        'DELETE FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?',
        [ownerPubkey, friendPubkey]
    );
    // Fire-and-forget server sync
    _syncFriendToServer('remove', ownerPubkey, friendPubkey).catch(e => console.warn('[Friends] Server sync failed:', e.message));
}

/** Server sync helper for friend add/remove */
async function _syncFriendToServer(action: 'add' | 'remove', ownerPubkey: string, friendPubkey: string) {
    const endpoint = action === 'add' ? '/api/friends/add' : '/api/friends/remove';
    await _signedRequest(endpoint, { ownerPubkey, friendPubkey });
}

/** Fetch friends from server (used by sync) */
export async function fetchFriendsFromServer(publicKey: string): Promise<any[]> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return [];
    try {
        const res = await fetch(`${anchorUrl}/api/friends/${publicKey}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (res.ok) return await res.json();
    } catch (e) {
        console.warn('[Friends] Failed to fetch from server:', e);
    }
    return [];
}

/** Get recent chat peers (for "Recents" section in contact picker) */
export async function getRecentChatMembers(myPubkey: string, limit = 10): Promise<any[]> {
    const database = await getDb();
    return database.getAllAsync<any>(
        `SELECT DISTINCT m.public_key as publicKey, m.callsign, m.avatar_url, m.joined_at as joinedAt,
                MAX(msg.timestamp) as lastChatAt
         FROM conversation_participants cp
         JOIN conversations c ON cp.conversation_id = c.id
         JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.public_key != ?
         JOIN members m ON m.public_key = cp2.public_key
         LEFT JOIN messages msg ON msg.conversation_id = c.id
         WHERE cp.public_key = ? AND c.type = 'dm' AND c.post_id IS NULL
         GROUP BY m.public_key
         ORDER BY lastChatAt DESC
         LIMIT ?`,
        [myPubkey, myPubkey, limit]
    );
}

// ======================== SOCIAL RECOVERY & GUARDIANS ========================

export async function setGuardianApi(friendPubkey: string, isGuardian: boolean): Promise<boolean> {
    const identity = await loadIdentity();
    if (!identity) return false;

    // Locally update DB first
    const database = await getDb();
    await database.runAsync(`UPDATE friends SET is_guardian=? WHERE owner_pubkey=? AND friend_pubkey=?`,
        [isGuardian ? 1 : 0, identity.publicKey, friendPubkey]);

    try {
        await _signedRequest('/api/friends/guardian', { friendPubkey, isGuardian });
        return true;
    } catch (e) {
        console.warn('[Guardians] Server sync failed:', e);
        return false;
    }
}

export async function lookupRecoveryCallsign(callsign: string): Promise<any[]> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Not connected');
    const res = await fetch(`${anchorUrl}/api/recovery/lookup/${encodeURIComponent(callsign)}`);
    if (!res.ok) throw new Error('Lookup failed');
    return res.json();
}

export async function createRecoveryRequest(oldPubkey: string, guardianGuess: string, newIdentity: any): Promise<any> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Not connected');

    const bodyObj = { oldPubkey, guardianGuess, newPubkey: newIdentity.publicKey };
    const bodyStr = JSON.stringify(bodyObj);
    const headers = await buildSignedHeaders('POST', '/api/recovery/request', bodyStr, newIdentity.privateKey, newIdentity.publicKey);

    const res = await fetch(`${anchorUrl}/api/recovery/request`, {
        method: 'POST',
        headers,
        body: bodyStr,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

export async function getPendingRecoveryRequests(): Promise<any[]> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return [];
    const identity = await loadIdentity();
    if (!identity) return [];

    const res = await fetch(`${anchorUrl}/api/recovery/pending/${identity.publicKey}`, {
        headers: { 'X-Public-Key': identity.publicKey }
    });
    if (!res.ok) throw new Error('Failed to fetch requests');
    return res.json();
}

export async function approveRecoveryRequest(requestId: string): Promise<void> {
    await sendRecoveryDecision(requestId, 'approve');
}

export async function rejectRecoveryRequest(requestId: string): Promise<void> {
    await sendRecoveryDecision(requestId, 'reject');
}

async function sendRecoveryDecision(requestId: string, decision: 'approve' | 'reject' | 'cancel'): Promise<void> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Not connected');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity');

    const bodyStr = JSON.stringify({ requestId });
    const headers = await buildSignedHeaders('POST', `/api/recovery/${decision}`, bodyStr, identity.privateKey, identity.publicKey);

    const res = await fetch(`${anchorUrl}/api/recovery/${decision}`, {
        method: 'POST',
        headers,
        body: bodyStr,
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${decision} request`);
    }
}

export async function cancelRecoveryRequest(requestId: string, identityToUse?: any): Promise<void> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Not connected');
    const identity = identityToUse || await loadIdentity();
    if (!identity) throw new Error('No identity');

    const bodyStr = JSON.stringify({ requestId });
    const headers = await buildSignedHeaders('POST', '/api/recovery/cancel', bodyStr, identity.privateKey, identity.publicKey);

    const res = await fetch(`${anchorUrl}/api/recovery/cancel`, {
        method: 'POST',
        headers,
        body: bodyStr,
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to cancel request');
    }
}

export async function getRecoveryStatus(pubkey: string): Promise<any> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return { status: 'none' };
    try {
        const res = await fetch(`${anchorUrl}/api/recovery/status/${pubkey}`);
        if (!res.ok) return { status: 'none' };
        return res.json();
    } catch {
        return { status: 'none' };
    }
}

export async function getMemberPosts(pubkey: string) {
    const database = await waitForInit();
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    const rows = await database.getAllAsync<any>(`
        SELECT * FROM posts
        WHERE author_pubkey = ? AND status = 'active'
        ORDER BY created_at DESC
    `, [pubkey]);

    return rows.map(r => {
        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                // Resolve relative photo paths against the active node (same as getPosts/getPost)
                if (Array.isArray(r.photos)) {
                    r.photos = r.photos.map((p: string) => p && p.startsWith('/') ? `${anchorUrl}${p}` : p);
                }
            } catch (e) { r.photos = []; }
        }
        return r;
    });
}

export async function getUnreadCountForPost(postId: string, myPubkey: string, peerPubkey?: string): Promise<number> {
    const database = await getDb();
    let query = `
        SELECT COUNT(msg.id) as unreadCount 
        FROM messages msg
        JOIN conversations c ON msg.conversation_id = c.id
        WHERE c.post_id = ?
        AND msg.author_pubkey != ?
        AND (msg.timestamp > IFNULL((SELECT last_read_at FROM conversation_participants WHERE conversation_id = c.id AND public_key = ?), '2000-01-01'))
    `;
    const params: any[] = [postId, myPubkey, myPubkey];

    if (peerPubkey) {
        query += ` AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.public_key = ?)`;
        params.push(peerPubkey);
    }

    const row = await database.getFirstAsync<{unreadCount: number}>(query, params);
    return row?.unreadCount || 0;
}

export async function getDatabaseStats() {
    const database = await getDb();
    
    let membersCount = 0;
    let postsCount = 0;
    let txCount = 0;
    let msgCount = 0;
    let integrity = 'Unknown';

    try {
        const membersRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM members');
        membersCount = membersRow?.count || 0;
    } catch (e) {}

    try {
        const postsRow = await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) as count FROM posts WHERE status IN ('active', 'pending')");
        postsCount = postsRow?.count || 0;
    } catch (e) {}

    try {
        const txRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM transactions');
        txCount = txRow?.count || 0;
    } catch (e) {}

    try {
        const msgRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM messages');
        msgCount = msgRow?.count || 0;
    } catch (e) {}
    
    try {
        const integrityRow = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
        integrity = integrityRow?.integrity_check || 'ok';
    } catch (e: any) {
        integrity = e.message || 'error';
    }

    return {
        members: membersCount,
        posts: postsCount,
        transactions: txCount,
        messages: msgCount,
        integrity
    };
}

