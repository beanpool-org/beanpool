/**
 * Shared by the three schema-upgrade suites (not a suite itself): test-schema-upgrade-fresh-shape.ts,
 * test-schema-upgrade-triggers-visitors.ts and test-schema-upgrade-markers-watermarks.ts. They were one suite until it
 * took 4m00s-4m56s on CI against the runner's 300 s per suite (killed at 300 s on PR #1479's Test-All run 36997955477).
 *
 * Each case boots the REAL initSchema() against a data dir under os.tmpdir() (the runner gives every suite its own
 * TMPDIR) and removes it when it is done. No suite listens on a port.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');
export const DB_TS_PATH = path.join(__dirname, 'db', 'db.ts');

let run = 0, passed = 0;
export function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

export const columns = (db: Database.Database, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r => r.name).sort();

export const indexes = (db: Database.Database, table: string): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`)
        .all(table) as any[]).map(r => r.name).sort();

/**
 * Boot the REAL initSchema() against a data dir, in a child process (the db module is a singleton). `env` adds to the
 * environment (NODE_ROLE=backup boots it as a standby); `source`, when given, is the boot script instead, and must
 * print BOOT_OK.
 */
export function bootInto(dir: string, env: Record<string, string> = {}, source?: string): { ok: boolean; output: string } {
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, source ?? `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    try {
        const out = execFileSync('pnpm', ['exec', 'tsx', script], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: out.includes('BOOT_OK'), output: out };
    } catch (e: any) {
        return { ok: false, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` };
    }
}

export const tmp = (name: string): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-upgrade-${name}-`));

/**
 * Every `(table, column)` a guarded ALTER adds AFTER `db.exec(schemaSql)`, minus any also added before it.
 *
 * A duplicate ALTER below the exec is harmless when the column was already added above — several exist for
 * historical reasons — so only columns whose FIRST appearance is late are at risk.
 */
export function lateAddedColumns(): string[] {
    const src = fs.readFileSync(DB_TS_PATH, 'utf-8');
    const marker = src.indexOf('db.exec(schemaSql)');
    if (marker < 0) throw new Error('Could not find db.exec(schemaSql) in db.ts — this check needs rewriting');
    const cols = (text: string) =>
        [...text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map(m => `${m[1]}.${m[2]}`);
    const early = new Set(cols(src.slice(0, marker)));
    return [...new Set(cols(src.slice(marker)))].filter(c => !early.has(c));
}

/**
 * Every index/trigger/view `db.exec(schemaSql)` creates, with the table it is defined ON.
 *
 * Triggers are read through to their `END;` — stopping at the first `;` would truncate the body and miss the
 * column references inside it, which is where the FTS5 mirror names `search_keywords`.
 */
export function schemaObjects(): { kind: string; name: string; table?: string; body: string }[] {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const out: { kind: string; name: string; table?: string; body: string }[] = [];
    for (const m of schema.matchAll(/CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\s+(?:IF NOT EXISTS\s+)?(\w+)([\s\S]*?);\s*(?=\n|$)/gi)) {
        const [, kind, name, rest] = m;
        let body = rest;
        if (kind.toUpperCase() === 'TRIGGER') {
            // Tolerant of `END ;` and of case, and LOUD when it finds nothing (review finding). The previous
            // `indexOf('END;')` returned -1 on any variation, and `slice(index, -1 + 4)` then produced an
            // EMPTY body — so the dependency check below found no column references and silently passed.
            // A false negative in a safety check is worse than no check, so this throws instead.
            const tail = /END\s*;/gi;
            tail.lastIndex = m.index!;
            const found = tail.exec(schema);
            if (!found) {
                throw new Error(`Could not find the closing END; of TRIGGER ${name} in schema.sql — `
                    + 'this parser needs updating before it can be trusted');
            }
            body = schema.slice(m.index!, found.index + found[0].length);
        }
        out.push({ kind: kind.toUpperCase(), name, table: (body.match(/\bON\s+(\w+)/i) || [])[1], body });
    }
    return out;
}

/**
 * Recreate a historical table by taking the CURRENT definition from schema.sql and dropping the columns that
 * did not exist then. Derived rather than pasted, so it keeps working as the table evolves.
 */
export function legacyDdl(table: string, withoutColumns: string[]): string {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!match) throw new Error(`Could not find the ${table} table in schema.sql`);
    const body = match[1]
        .split('\n')
        // Comments and blank lines are dropped first. They carry no schema meaning, and leaving them in
        // defeats the trailing-comma fix below: `members` ends its column list with commentary, so the last
        // real column kept its comma and SQLite rejected the whole statement with "near ): syntax error".
        .filter(line => {
            const t = line.trim();
            return t !== '' && !t.startsWith('--');
        })
        .filter(line => !withoutColumns.includes(line.trim().split(/\s+/)[0]))
        .join('\n')
        // A trailing comma before `)` is a syntax error once the last column is removed.
        .replace(/,(\s*)$/, '$1');
    return `CREATE TABLE ${table} (${body}\n);`;
}

/**
 * A suite's entry: run `cases`, then print the count and `passedLine`. Exits 0 when every check passed, 1 otherwise.
 */
export function runSchemaSuite(title: string, passedLine: string, cases: () => Promise<void>): void {
    const main = async (): Promise<void> => {
        console.log(`Running schema upgrade tests: ${title}...\n`);
        await cases();
        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log(passedLine);
    };
    // Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
    // keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
    // In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
    // runs them in sequence), which is how a single test burns hours of Actions time. Reaching the exit 0
    // means every assertion above held; a failure throws, and exits non-zero.
    main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
