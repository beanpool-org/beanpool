import { WebSocket } from 'ws';
import { db } from './db/db.js';

export const logClients = new Set<WebSocket>();

export function addLogClient(ws: WebSocket) {
    logClients.add(ws);
}

export function removeLogClient(ws: WebSocket) {
    logClients.delete(ws);
}

/**
 * Sanitizes input message by redacting sensitive items (private keys, passwords, mnemonics).
 */
export function sanitizeMessage(msg: string): string {
    if (!msg) return '';
    let sanitized = msg;

    // 1. BIP39 Mnemonic Seed Phrase (12 to 24 words)
    // Matches 12 to 24 lowercase space-separated words of 3-12 chars.
    sanitized = sanitized.replace(/\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/gi, '[REDACTED_MNEMONIC]');

    // 2. PEM Private Keys
    sanitized = sanitized.replace(/-----BEGIN\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----[\s\S]+?-----END\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----/gi, '[REDACTED_PRIVATE_KEY]');

    // 3. Secrets, passwords, tokens, salt, hashes, api keys in JSON / form / query formats
    sanitized = sanitized.replace(/(["']?(?:password|authToken|token|salt|adminHash|newPassword|currentPassword|secret|privateKey|private_key|seed|keyBytes|apiKey|api_key|authorization)["']?\s*[:=]\s*["']?)[a-zA-Z0-9_\-\.\+=\/]{12,}(["']?)/gi, '$1[REDACTED_CREDENTIAL]$2');

    // 4. Standalone Hex seed strings / keys (64 or 128 hex chars)
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{64}\b/gi, '[REDACTED_HEX_KEY_64]');
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{128}\b/gi, '[REDACTED_HEX_KEY_128]');

    return sanitized;
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

        // Bounded database: prune items older than 2500 entries
        db.prepare(`
            DELETE FROM system_logs
            WHERE id < (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1 OFFSET 2499)
        `).run();

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
