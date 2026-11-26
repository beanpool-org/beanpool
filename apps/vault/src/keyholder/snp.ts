import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { vaultB64, vaultUnb64 } from '@beanpool/core';
import { describeTcb, readSnpReport, snpEvidence, splitSnpEvidence, type SnpReport } from '../shared/snp-report.js';
import { noneAttestor, type Attestor } from './attestor.js';

// The report's layout and the evidence wrapper live in shared/ (the custodian's chip check reads them too).
export { readSnpReport, snpEvidence, splitSnpEvidence, SNP_EVIDENCE_MAGIC, SNP_EVIDENCE_VERSION, SNP_REPORT_SIZE } from '../shared/snp-report.js';
export type { SnpReport, SnpTcb } from '../shared/snp-report.js';

/**
 * AMD SEV-SNP reports for the keyholder's hello (vault comeback design §2.2). Linux's configfs-tsm gives them: make a
 * directory under /sys/kernel/config/tsm/report, write the 64 bytes of report data to its `inblob`, read the signed
 * report from `outblob` and the host's certificate table (if any) from `auxblob` (kernel ABI, configfs-tsm). Plain file
 * reads and writes, so no native module (hygiene.ts).
 *
 * The keyholder's sandbox makes /sys read-only and hides devices (beanpool-vault-keyholder.service), and stays so: a
 * small root helper (`vault-keyholder --attest-socket <path>`, beanpool-vault-attest.service) takes the 64 bytes on a
 * socket only root and the keyholder reach, and answers with the evidence. It holds no secret. If it lies, the
 * custodian's tool's checks fail (a report must carry the tool's own binding, signed by the chip) and the vault stays
 * locked. The checks here are belt and braces against a mistake, not the trust check, which is the tool's.
 *
 * Evidence bytes: "BVSN", a version byte (1), the 1,184-byte report, then the certificate table (may be empty)
 * (shared/snp-report.ts).
 */

export const TSM_REPORT_DIR = '/sys/kernel/config/tsm/report';
export const ATTEST_SOCKET = '/run/beanpool-vault/attest/attest.sock';
/** A request or an answer on the helper's socket larger than this is not one (a report plus a certificate table is ~10 KiB). */
const ATTEST_MAX_BYTES = 256 * 1024;

/** The file operations configfs-tsm needs; tests pass a fake that behaves like the kernel's. */
export interface TsmFs {
    mkdir(p: string): void;
    rmdir(p: string): void;
    read(p: string): Buffer | null;
    write(p: string, data: Uint8Array): void;
}

export const realTsmFs: TsmFs = {
    mkdir: p => mkdirSync(p),
    rmdir: p => rmdirSync(p),
    read: p => {
        try {
            return readFileSync(p);
        } catch {
            return null;
        }
    },
    write: (p, data) => writeFileSync(p, data),
};

const text = (b: Buffer | null) => (b === null ? null : b.toString('utf8').trim());

/**
 * One report over `reportData` (64 bytes) from configfs-tsm. Fails closed: the provider must be `sev_guest`, the
 * request at privilege level 0, the entry's generation moved by exactly our one write (nobody else wrote between), and
 * the report 1,184 bytes carrying our report data at VMPL 0. The entry is removed whatever happens.
 */
export function tsmReport(reportData: Uint8Array, opts: { dir?: string; fs?: TsmFs } = {}): { report: Buffer; auxblob: Buffer } {
    if (reportData.length !== 64) throw new Error('SEV-SNP report data is 64 bytes.');
    const fs = opts.fs ?? realTsmFs;
    const entry = path.join(opts.dir ?? TSM_REPORT_DIR, `beanpool-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdir(entry);
    try {
        const provider = text(fs.read(path.join(entry, 'provider')));
        if (provider !== 'sev_guest') throw new Error(`configfs-tsm's provider is ${provider ?? 'missing'}, not sev_guest.`);
        const privlevel = text(fs.read(path.join(entry, 'privlevel')));
        if (privlevel !== null && privlevel !== '0') throw new Error(`configfs-tsm asks at privilege level ${privlevel}, not 0.`);
        const before = Number(text(fs.read(path.join(entry, 'generation'))));
        if (!Number.isSafeInteger(before)) throw new Error('configfs-tsm has no generation counter.');
        fs.write(path.join(entry, 'inblob'), reportData);
        const report = fs.read(path.join(entry, 'outblob'));
        const auxblob = fs.read(path.join(entry, 'auxblob')) ?? Buffer.alloc(0);
        const after = Number(text(fs.read(path.join(entry, 'generation'))));
        if (after !== before + 1) throw new Error(`configfs-tsm's generation went from ${before} to ${after}: another writer, not our one write.`);
        if (!report) throw new Error('configfs-tsm gave no report.');
        const r = readSnpReport(report);
        if (!r.reportData.equals(Buffer.from(reportData))) throw new Error('The report does not carry the report data asked for.');
        if (r.vmpl !== 0) throw new Error(`The report was asked for at VMPL ${r.vmpl}, not 0.`);
        return { report: Buffer.from(report), auxblob: Buffer.from(auxblob) };
    } finally {
        try {
            fs.rmdir(entry);
        } catch {
            // Gone already, or the kernel keeps it busy: nothing secret is in it.
        }
    }
}

// ─── The helper's socket (root) and its client (the keyholder) ──────────────────────────────

/**
 * Root's helper: `{"reportData": "<base64url, 64 bytes>"}\n` in, `{"evidence": "<base64url>"}\n` (or `{"error": ...}`)
 * out, one request per connection. The socket is 0660 in a 0750 directory, both of the helper's group (its unit runs
 * as root with Group=vault-attest), which only the keyholder's user is in (sysusers), so the API cannot make the chip
 * work.
 */
export async function listenAttest(socketPath: string, opts: { report?: (data: Uint8Array) => { report: Buffer; auxblob: Buffer } } = {}):
    Promise<{ close(): Promise<void> }> {
    const report = opts.report ?? ((d: Uint8Array) => tsmReport(d));
    const dir = path.dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    chmodSync(dir, 0o750);
    if (existsSync(socketPath)) rmSync(socketPath);
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        let buf = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.length > ATTEST_MAX_BYTES) return void socket.destroy();
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            socket.removeAllListeners('data');
            let answer: { evidence: string } | { error: string };
            try {
                const req = JSON.parse(buf.slice(0, nl)) as { reportData?: unknown };
                const data = typeof req.reportData === 'string' ? vaultUnb64(req.reportData) : null;
                if (!data || data.length !== 64) throw new Error('reportData is 64 bytes, base64url.');
                const r = report(data);
                answer = { evidence: vaultB64(snpEvidence(r.report, r.auxblob)) };
            } catch (err) {
                answer = { error: err instanceof Error ? err.message : String(err) };
            }
            socket.end(`${JSON.stringify(answer)}\n`);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o660);
    return {
        close: () => new Promise<void>(resolve => {
            for (const s of sockets) s.destroy();
            server.close(() => resolve());
        }),
    };
}

/** Asks root's helper for evidence over `reportData`. Throws (never answers "no evidence") when it cannot. */
export function requestSnpEvidence(socketPath: string, reportData: Uint8Array, timeoutMs = 30_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buf = '';
        const done = (err: Error | null, value?: Buffer) => {
            clearTimeout(timer);
            socket.destroy();
            if (err) reject(err);
            else resolve(value as Buffer);
        };
        const timer = setTimeout(() => done(new Error('The SEV-SNP helper did not answer in time.')), timeoutMs);
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(`${JSON.stringify({ reportData: vaultB64(reportData) })}\n`));
        socket.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.length > ATTEST_MAX_BYTES) done(new Error('The SEV-SNP helper answered too much.'));
        });
        socket.on('error', err => done(new Error(`The SEV-SNP helper is not reachable: ${err.message}`)));
        socket.on('end', () => {
            try {
                const a = JSON.parse(buf) as { evidence?: unknown; error?: unknown };
                if (typeof a.evidence === 'string') {
                    const raw = vaultUnb64(a.evidence);
                    if (!raw) throw new Error('The SEV-SNP helper\'s evidence is not base64url.');
                    const evidence = Buffer.from(raw);
                    // Belt and braces: the helper's answer carries our report data, or it is not ours.
                    const { report } = splitSnpEvidence(evidence);
                    if (!readSnpReport(report).reportData.equals(Buffer.from(reportData))) throw new Error('The helper\'s report is not over our report data.');
                    return done(null, evidence);
                }
                done(new Error(`The SEV-SNP helper refused: ${typeof a.error === 'string' ? a.error : 'no answer'}`));
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
}

/**
 * The SEV-SNP attestor: every hello's evidence is a fresh report over its `bind`. It never falls back to `none`: if
 * the helper fails, the hello fails, and the custodian's tool sends nothing.
 */
export function snpAttestor(socketPath: string = ATTEST_SOCKET): Attestor {
    return {
        platform: 'sev-snp',
        async evidence(bind: Uint8Array): Promise<Uint8Array> {
            if (bind.length !== 64) throw new Error('An unlock binding is 64 bytes.');
            return requestSnpEvidence(socketPath, bind);
        },
    };
}

/**
 * The keyholder config's attestor: absent or `none` (no hardware proof), or `sev-snp` (reports from root's helper on
 * `attestSocket`). Anything else throws, and the keyholder does not start: an SNP image never falls back to `none`.
 */
export function attestorFrom(config: { attestor?: unknown; attestSocket?: unknown }): Attestor {
    if (config.attestor === undefined || config.attestor === 'none') return noneAttestor;
    if (config.attestor === 'sev-snp') {
        if (config.attestSocket !== undefined && typeof config.attestSocket !== 'string') throw new Error('attestSocket is a path.');
        return snpAttestor((config.attestSocket as string | undefined) ?? ATTEST_SOCKET);
    }
    throw new Error(`attestor ${JSON.stringify(config.attestor)} is not one this keyholder knows (none, sev-snp)`);
}

/** The boot check's lines (public values only): policy, VMPL, signer, and the three TCBs. */
export function describeSnpReport(r: SnpReport): string[] {
    const tcb = describeTcb;
    return [
        `report version ${r.version}, policy 0x${r.policy.toString(16)} (debug ${(r.policy >> 19n) & 1n ? 'ON' : 'off'}, migration agent ${(r.policy >> 18n) & 1n ? 'ON' : 'off'}), VMPL ${r.vmpl}`,
        `signer ${r.signingKey === 0 ? 'VCEK (the chip\'s own key)' : r.signingKey === 1 ? 'VLEK' : `unknown (${r.signingKey})`}${r.maskChipKey ? ', chip key masked' : ''}`,
        `reported TCB ${tcb(r.reportedTcb)}`,
        `committed TCB ${tcb(r.committedTcb)}; launch TCB ${tcb(r.launchTcb)}`,
        `measurement ${r.measurement.toString('hex')}`,
        // The custodian's tool names a chip it has not seen by these 8 characters (--accept-new-machine): compare them.
        `chip ${r.chipId.toString('hex').slice(0, 8)}…; CPUID family 0x${r.cpuid.family.toString(16)}, model 0x${r.cpuid.model.toString(16)}`,
    ];
}
