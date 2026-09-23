import { WebSocket } from 'ws';
import { db } from './db/db.js';
import { sanitizeMessage } from './sanitize-message.js';

// Re-exported so `import { sanitizeMessage } from './logger.js'` keeps working. The function itself moved
// to a database-free file so the process-level error net can redact without importing the database.
export { sanitizeMessage };

export const logClients = new Set<WebSocket>();

export function addLogClient(ws: WebSocket) {
    logClients.add(ws);
}

export function removeLogClient(ws: WebSocket) {
    logClients.delete(ws);
}

/**
 * Formats a log entry beautifully for the standard terminal output.
 */
function formatConsoleLog(entry: { timestamp: string; level: string; category: string; message: string }): string {
    const { timestamp, level, category, message } = entry;
    const colors = {
        reset: '\x1b[0m',
        blue: '\x1b[36m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        purple: '\x1b[35m',
        green: '\x1b[32m',
        gray: '\x1b[90m'
    };

    let levelColor = colors.blue;
    if (level === 'WARN') levelColor = colors.yellow;
    if (level === 'ERROR') levelColor = colors.red;
    if (level === 'SECURITY') levelColor = colors.purple;
    if (level === 'SYNC') levelColor = colors.green;

    return `${colors.gray}[${timestamp}]${colors.reset} ${levelColor}[${level}]${colors.reset} ${colors.gray}[${category}]${colors.reset} ${message}`;
}

/**
 * Write a sanitized log message to SQLite and broadcast via WebSockets.
 */
export function writeLog(
    level: 'INFO' | 'WARN' | 'ERROR' | 'SECURITY' | 'SYNC',
    category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS',
    message: string,
    metadata?: any
) {
    const sanitizedMessage = sanitizeMessage(message);
    const sanitizedMetadata = metadata ? sanitizeMessage(JSON.stringify(metadata)) : null;

    try {
        // Insert log entry
        const stmt = db.prepare(`
            INSERT INTO system_logs (level, category, message, metadata)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(level, category, sanitizedMessage, sanitizedMetadata);
        const insertId = result.lastInsertRowid;

        // Bounded database: prune items older than 2500 entries (every 100 insertions)
        if (typeof insertId === 'number' && insertId % 100 === 0) {
            db.prepare(`
                DELETE FROM system_logs
                WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 2499)
            `).run();
        }

        // Get the newly written log (so timestamp matches SQLite's default)
        const logEntry = db.prepare('SELECT * FROM system_logs WHERE id = ?').get(insertId) as any;

        if (logEntry) {
            // Log to local console output
            console.log(formatConsoleLog(logEntry));

            // Stream in real-time to active WebSocket dashboard connections
            const payload = JSON.stringify({ type: 'log', data: logEntry });
            for (const client of logClients) {
                if (client.readyState === 1) { // OPEN
                    client.send(payload);
                }
            }
        }
    } catch (err: any) {
        console.error('Failed to write administrative log:', err.message);
    }
}

export const logger = {
    info: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('INFO', category, message, metadata),
    warn: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('WARN', category, message, metadata),
    error: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('ERROR', category, message, metadata),
    security: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('SECURITY', category, message, metadata),
    sync: (category: 'P2P' | 'LEDGER' | 'TLS' | 'ADMIN' | 'AUTH' | 'DB' | 'SYS', message: string, metadata?: any) => writeLog('SYNC', category, message, metadata),
};
