/**
 * Storage Health, Disk Breakdown & Pruning Service.
 *
 * Implements docs/settings-ia.md §5 item 3:
 * 1. Disk usage breakdown: database vs media vs logs.
 * 2. 80% safety warning threshold to prevent SD card runaway.
 * 3. One-click "clean orphaned media & compress logs" that previews
 *    what it will remove before performing the deletion.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db as defaultDb } from '../db/db.js';

export interface DiskBreakdownItem {
    dbSizeBytes: number;
    walSizeBytes: number;
    shmSizeBytes: number;
    snapshotsSizeBytes: number;
    totalBytes: number;
}

export interface MediaBreakdownItem {
    postPhotosBytes: number;
    postPhotosCount: number;
    pulseThumbnailsBytes: number;
    pulseThumbnailsCount: number;
    totalBytes: number;
}

export interface LogsBreakdownItem {
    systemLogsBytes: number;
    systemLogsCount: number;
    logFilesBytes: number;
    totalBytes: number;
}

export interface DiskHealth {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    warning: boolean; // true if usedPercent >= 80
    databaseBytes: number;
    mediaBytes: number;
    logsBytes: number;
    breakdown: {
        database: DiskBreakdownItem;
        media: MediaBreakdownItem;
        logs: LogsBreakdownItem;
    };
}

export interface StorageCleanPreview {
    orphanedPostPhotos: {
        count: number;
        totalBytes: number;
    };
    orphanedThumbnails: {
        count: number;
        totalBytes: number;
    };
    compressibleLogs: {
        count: number;
        totalBytes: number;
        oldestTimestamp?: string;
        newestTimestamp?: string;
    };
    totalReclaimableBytes: number;
}

export interface StorageCleanResult {
    success: boolean;
    removedPhotosCount: number;
    removedPhotosBytes: number;
    removedThumbnailsCount: number;
    removedThumbnailsBytes: number;
    compressedLogsCount: number;
    compressedLogsBytes: number;
    totalReclaimedBytes: number;
}

let simulatedDiskUsagePercent: number | null = null;

export function setSimulatedDiskUsageForTesting(percent: number | null): void {
    simulatedDiskUsagePercent = percent;
}

/**
 * Calculates disk breakdown and capacity utilization for the community node.
 */
export function getDiskHealth(options?: { db?: any; dataDir?: string }): DiskHealth {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    // 1. Filesystem capacity via statfs
    let totalBytes = 64 * 1024 * 1024 * 1024; // Default 64 GB fallback
    let freeBytes = 32 * 1024 * 1024 * 1024;  // Default 32 GB fallback
    try {
        if (typeof fs.statfsSync === 'function') {
            const statfs = fs.statfsSync(dataDir);
            const bsize = statfs.bsize || 4096;
            totalBytes = Number(statfs.blocks) * bsize;
            freeBytes = Number(statfs.bavail) * bsize;
        }
    } catch {}

    let usedBytes = Math.max(0, totalBytes - freeBytes);
    let usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    if (simulatedDiskUsagePercent !== null) {
        usedPercent = simulatedDiskUsagePercent;
        usedBytes = Math.round((totalBytes * usedPercent) / 100);
        freeBytes = totalBytes - usedBytes;
    }

    const warning = usedPercent >= 80;

    // 2. Database Breakdown
    const dbFile = path.join(dataDir, 'state.db');
    const walFile = `${dbFile}-wal`;
    const shmFile = `${dbFile}-shm`;
    const snapshotsDir = path.join(dataDir, 'snapshots');

    let dbSizeBytes = 0;
    let walSizeBytes = 0;
    let shmSizeBytes = 0;
    let snapshotsSizeBytes = 0;

    try {
        if (fs.existsSync(dbFile)) dbSizeBytes = fs.statSync(dbFile).size;
        if (fs.existsSync(walFile)) walSizeBytes = fs.statSync(walFile).size;
        if (fs.existsSync(shmFile)) shmSizeBytes = fs.statSync(shmFile).size;
        if (fs.existsSync(snapshotsDir)) {
            for (const f of fs.readdirSync(snapshotsDir)) {
                try {
                    const snapPath = path.join(snapshotsDir, f);
                    snapshotsSizeBytes += fs.statSync(snapPath).size;
                } catch {}
            }
        }
    } catch {}

    const databaseTotal = dbSizeBytes + walSizeBytes + shmSizeBytes + snapshotsSizeBytes;

    // 3. Media Breakdown
    let postPhotosBytes = 0;
    let postPhotosCount = 0;
    try {
        const row = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(LENGTH(photo_data)), 0) as bytes FROM post_photos').get() as any;
        postPhotosCount = row?.c || 0;
        postPhotosBytes = row?.bytes || 0;
    } catch {}

    let pulseThumbnailsBytes = 0;
    let pulseThumbnailsCount = 0;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                try {
                    const st = fs.statSync(path.join(thumbDir, f));
                    if (st.isFile()) {
                        if (f.endsWith('.bin')) {
                            pulseThumbnailsCount++;
                        }
                        pulseThumbnailsBytes += st.size;
                    }
                } catch {}
            }
        } catch {}
    }

    const mediaTotal = postPhotosBytes + pulseThumbnailsBytes;

    // 4. Logs Breakdown
    let systemLogsCount = 0;
    let systemLogsBytes = 0;
    try {
        const row = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(LENGTH(message) + LENGTH(COALESCE(metadata, ''))), 0) as bytes FROM system_logs").get() as any;
        systemLogsCount = row?.c || 0;
        systemLogsBytes = row?.bytes || 0;
    } catch {}

    let logFilesBytes = 0;
    const logsDir = path.join(dataDir, 'logs');
    if (fs.existsSync(logsDir)) {
        try {
            for (const f of fs.readdirSync(logsDir)) {
                try {
                    logFilesBytes += fs.statSync(path.join(logsDir, f)).size;
                } catch {}
            }
        } catch {}
    }

    const logsTotal = systemLogsBytes + logFilesBytes;

    return {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent,
        warning,
        databaseBytes: databaseTotal,
        mediaBytes: mediaTotal,
        logsBytes: logsTotal,
        breakdown: {
            database: {
                dbSizeBytes,
                walSizeBytes,
                shmSizeBytes,
                snapshotsSizeBytes,
                totalBytes: databaseTotal,
            },
            media: {
                postPhotosBytes,
                postPhotosCount,
                pulseThumbnailsBytes,
                pulseThumbnailsCount,
                totalBytes: mediaTotal,
            },
            logs: {
                systemLogsBytes,
                systemLogsCount,
                logFilesBytes,
                totalBytes: logsTotal,
            },
        },
    };
}

/**
 * Previews what orphaned media and compressible logs will be removed before actually cleaning.
 */
export function getStorageCleanPreview(options?: { db?: any; dataDir?: string }): StorageCleanPreview {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    // 1. Orphaned Post Photos (photos whose post no longer exists in posts table)
    let orphanedPhotosCount = 0;
    let orphanedPhotosBytes = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(photo_data)), 0) as totalBytes
            FROM post_photos
            WHERE post_id NOT IN (SELECT id FROM posts)
        `).get() as any;
        orphanedPhotosCount = row?.count || 0;
        orphanedPhotosBytes = row?.totalBytes || 0;
    } catch {}

    // 2. Orphaned Pulse Thumbnails (cached thumbnails whose item no longer exists in pulse_items)
    let orphanedThumbnailsCount = 0;
    let orphanedThumbnailsBytes = 0;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                if (f.endsWith('.bin')) {
                    const itemId = f.slice(0, -4);
                    try {
                        const exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ?').get(itemId);
                        if (!exists) {
                            orphanedThumbnailsCount++;
                            orphanedThumbnailsBytes += fs.statSync(path.join(thumbDir, f)).size;
                            const metaFile = path.join(thumbDir, `${itemId}.json`);
                            if (fs.existsSync(metaFile)) {
                                orphanedThumbnailsBytes += fs.statSync(metaFile).size;
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    // 3. Compressible Logs (system_logs older than 7 days or beyond the latest 500 rows)
    let compressibleLogsCount = 0;
    let compressibleLogsBytes = 0;
    let oldestTimestamp: string | undefined;
    let newestTimestamp: string | undefined;

    try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM system_logs').get() as any;
        const totalLogs = countRow?.count || 0;
        if (totalLogs > 500) {
            const pruneRow = db.prepare(`
                SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(message) + LENGTH(COALESCE(metadata, ''))), 0) as totalBytes,
                       MIN(timestamp) as oldest, MAX(timestamp) as newest
                FROM system_logs
                WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 499)
            `).get() as any;
            compressibleLogsCount = pruneRow?.count || 0;
            compressibleLogsBytes = pruneRow?.totalBytes || 0;
            oldestTimestamp = pruneRow?.oldest;
            newestTimestamp = pruneRow?.newest;
        }
    } catch {}

    const totalReclaimableBytes = orphanedPhotosBytes + orphanedThumbnailsBytes + compressibleLogsBytes;

    return {
        orphanedPostPhotos: {
            count: orphanedPhotosCount,
            totalBytes: orphanedPhotosBytes,
        },
        orphanedThumbnails: {
            count: orphanedThumbnailsCount,
            totalBytes: orphanedThumbnailsBytes,
        },
        compressibleLogs: {
            count: compressibleLogsCount,
            totalBytes: compressibleLogsBytes,
            oldestTimestamp,
            newestTimestamp,
        },
        totalReclaimableBytes,
    };
}

/**
 * Executes cleanup of orphaned media and compresses/prunes old logs.
 */
export function cleanStorageAndCompressLogs(options?: { db?: any; dataDir?: string }): StorageCleanResult {
    const db = options?.db || defaultDb;
    const dataDir = options?.dataDir || process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

    const preview = getStorageCleanPreview({ db, dataDir });

    // 1. Delete orphaned post photos
    let removedPhotosCount = 0;
    let removedPhotosBytes = preview.orphanedPostPhotos.totalBytes;
    try {
        const delRes = db.prepare(`
            DELETE FROM post_photos
            WHERE post_id NOT IN (SELECT id FROM posts)
        `).run();
        removedPhotosCount = delRes.changes || 0;
    } catch {}

    // 2. Delete orphaned pulse thumbnails
    let removedThumbnailsCount = 0;
    let removedThumbnailsBytes = preview.orphanedThumbnails.totalBytes;
    const thumbDir = path.join(dataDir, 'cache', 'pulse-thumbnails');
    if (fs.existsSync(thumbDir)) {
        try {
            for (const f of fs.readdirSync(thumbDir)) {
                if (f.endsWith('.bin')) {
                    const itemId = f.slice(0, -4);
                    try {
                        const exists = db.prepare('SELECT 1 FROM pulse_items WHERE id = ?').get(itemId);
                        if (!exists) {
                            try { fs.unlinkSync(path.join(thumbDir, f)); } catch {}
                            const metaFile = path.join(thumbDir, `${itemId}.json`);
                            try { if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile); } catch {}
                            removedThumbnailsCount++;
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    // 3. Compress / prune old logs
    let compressedLogsCount = 0;
    let compressedLogsBytes = preview.compressibleLogs.totalBytes;

    try {
        const countRow = db.prepare('SELECT COUNT(*) as count FROM system_logs').get() as any;
        const totalLogs = countRow?.count || 0;
        if (totalLogs > 500) {
            // Read rows to archive
            const rowsToArchive = db.prepare(`
                SELECT * FROM system_logs
                WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 499)
                ORDER BY id ASC
            `).all() as any[];

            if (rowsToArchive.length > 0) {
                const logsArchiveDir = path.join(dataDir, 'logs', 'archived');
                try {
                    if (!fs.existsSync(logsArchiveDir)) {
                        fs.mkdirSync(logsArchiveDir, { recursive: true });
                    }
                    const archiveFile = path.join(logsArchiveDir, `logs-${Date.now()}.json.gz`);
                    const jsonStr = JSON.stringify(rowsToArchive);
                    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
                    fs.writeFileSync(archiveFile, compressed);
                } catch {}

                const delLogs = db.prepare(`
                    DELETE FROM system_logs
                    WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 499)
                `).run();
                compressedLogsCount = delLogs.changes || rowsToArchive.length;
            }
        }

        // Reclaim SQLite pages
        try {
            db.pragma('incremental_vacuum');
        } catch {}
    } catch {}

    const totalReclaimedBytes = removedPhotosBytes + removedThumbnailsBytes + compressedLogsBytes;

    return {
        success: true,
        removedPhotosCount,
        removedPhotosBytes,
        removedThumbnailsCount,
        removedThumbnailsBytes,
        compressedLogsCount,
        compressedLogsBytes,
        totalReclaimedBytes,
    };
}
