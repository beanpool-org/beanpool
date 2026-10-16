/**
 * Unit tests for atomic file writer and stale temp cleanup utilities in write-file-atomic.ts:
 * - writeFileAtomic (string, Uint8Array, mode preservation, read-only guard)
 * - cleanStaleWriteTemps (temp file pattern matching, pid check, stale cleanup)
 * - fsyncDir (directory flush)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-write-file-atomic.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic, cleanStaleWriteTemps, fsyncDir } from './write-file-atomic.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main(): void {
    console.log('Running test-write-file-atomic...\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-atomic-'));

    try {
        // =========================================================================
        // 1. writeFileAtomic - basic string and Uint8Array writes
        // =========================================================================
        console.log('--- Testing writeFileAtomic basic writes ---');
        const strFile = path.join(tmpDir, 'test-str.txt');
        writeFileAtomic(strFile, 'hello atomic world');
        assert(fs.existsSync(strFile), 'writeFileAtomic creates target file for string content');
        assert(fs.readFileSync(strFile, 'utf8') === 'hello atomic world', 'File content matches written string');

        const binFile = path.join(tmpDir, 'test-bin.dat');
        const binData = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
        writeFileAtomic(binFile, binData);
        assert(fs.existsSync(binFile), 'writeFileAtomic creates target file for Uint8Array content');
        const readBin = fs.readFileSync(binFile);
        assert(Buffer.compare(readBin, Buffer.from(binData)) === 0, 'File content matches written Uint8Array');

        // =========================================================================
        // 2. writeFileAtomic - mode preservation & mode options
        // =========================================================================
        console.log('\n--- Testing writeFileAtomic mode options ---');
        const modeFile = path.join(tmpDir, 'test-mode.txt');
        writeFileAtomic(modeFile, 'initial', { newMode: 0o600 });
        const initialStat = fs.statSync(modeFile);
        assert((initialStat.mode & 0o777) === 0o600, 'writeFileAtomic respects newMode option (0o600)');

        // Overwrite existing file without passing mode -> should preserve 0o600
        writeFileAtomic(modeFile, 'updated');
        const updatedStat = fs.statSync(modeFile);
        assert((updatedStat.mode & 0o777) === 0o600, 'writeFileAtomic preserves existing mode (0o600) on overwrite');
        assert(fs.readFileSync(modeFile, 'utf8') === 'updated', 'Updated content is written correctly');

        // Overwrite with explicit mode option override
        writeFileAtomic(modeFile, 'override-mode', { mode: 0o644 });
        const overrideStat = fs.statSync(modeFile);
        assert((overrideStat.mode & 0o777) === 0o644, 'writeFileAtomic respects explicit mode override option (0o644)');

        // =========================================================================
        // 3. writeFileAtomic - read-only target refusal
        // =========================================================================
        console.log('\n--- Testing writeFileAtomic read-only guard ---');
        const roFile = path.join(tmpDir, 'test-readonly.txt');
        fs.writeFileSync(roFile, 'readonly-content', { mode: 0o400 });
        let threw = false;
        try {
            writeFileAtomic(roFile, 'attempted-write');
        } catch (err) {
            threw = true;
            assert((err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM', 'Error code is EACCES/EPERM on read-only target');
        }
        assert(threw, 'writeFileAtomic throws when target file is read-only');
        assert(fs.readFileSync(roFile, 'utf8') === 'readonly-content', 'Read-only target content remains untouched');
        // Restore permissions so cleanup works
        fs.chmodSync(roFile, 0o644);

        // =========================================================================
        // 4. cleanStaleWriteTemps
        // =========================================================================
        console.log('\n--- Testing cleanStaleWriteTemps ---');
        const staleDir = path.join(tmpDir, 'stale-test');
        fs.mkdirSync(staleDir, { recursive: true });

        // Stale temp file matching current PID
        const selfTmp = path.join(staleDir, `.target.tmp-${process.pid}-12345678`);
        fs.writeFileSync(selfTmp, 'self temp');

        // Stale temp file with a non-existent PID (PID 9999999 is highly unlikely to exist)
        const deadTmp = path.join(staleDir, `.target.tmp-9999999-abcdef01`);
        fs.writeFileSync(deadTmp, 'dead temp');

        // Non-temp file in same dir
        const normalFile = path.join(staleDir, 'normal.txt');
        fs.writeFileSync(normalFile, 'normal file');

        // Unrelated dotfile
        const otherDotfile = path.join(staleDir, '.other-file.tmp');
        fs.writeFileSync(otherDotfile, 'other dotfile');

        const removed = cleanStaleWriteTemps(staleDir);
        assert(removed.length === 2, 'cleanStaleWriteTemps removed 2 stale temp files');
        assert(!fs.existsSync(selfTmp), 'Current PID temp file removed');
        assert(!fs.existsSync(deadTmp), 'Non-existent PID temp file removed');
        assert(fs.existsSync(normalFile), 'Normal file retained');
        assert(fs.existsSync(otherDotfile), 'Unrelated dotfile retained');

        // =========================================================================
        // 5. fsyncDir
        // =========================================================================
        console.log('\n--- Testing fsyncDir ---');
        let fsyncThrew = false;
        try {
            fsyncDir(tmpDir);
            fsyncDir('/nonexistent-dir-for-test-fsync');
        } catch {
            fsyncThrew = true;
        }
        assert(!fsyncThrew, 'fsyncDir handles valid and non-existent directories gracefully without throwing');

    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ test-write-file-atomic PASSED.');
    process.exit(0);
}

try {
    main();
} catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
}
