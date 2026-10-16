/**
 * `beanpool pair` (design scratch/global-node/case19/DESIGN-standby-pin-fable.md D1, D2, D5): pairs this standby with
 * the main server whose pairing code is pasted (made under Replication Access there). The only way a standby's main
 * server is set or changed: no route writes data/standby-main.json, and whoever has this shell has the disk already.
 *
 *   beanpool pair [--code-file F] [--follow-new-server]
 *
 * The code is typed at the prompt (not echoed on a terminal) or read from F; never from the command line, which `ps`
 * and the shell history show (the recovery code's rule, restore-command.ts). It is checked whole (its checksum) before
 * anything is written. The running node does the pairing (services/standby-main.ts answerPairRequest): this process
 * leaves data/pair-request.json and waits for the answer, as `beanpool claim` hands a name over.
 *
 * Exit codes: 0 paired, 1 refused (nothing was changed), 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './recover-command.js';
import type { Ask } from './shell-prompt.js';
import {
    PAIR_REQUEST_FILE, PAIRING_CODE_MAX_CHARS, keyEnd, parsePairingCode, readStandbyMain, takePairAnswerFile, writePairRequestFile,
} from './services/standby-main.js';

export const PAIR_USAGE = `Usage: beanpool pair [--code-file F] [--follow-new-server]

Pairs this standby with the main server whose pairing code you paste (made under Replication Access there).
This standby then copies that server, keeps its locked take-over keys, and restores its backups, and nobody else's.

  --code-file F          read the pairing code from file F (otherwise it is asked for; never on the command line)
  --follow-new-server    this standby already follows another key; follow this one instead. The next copy is built
                         from nothing, and the copy held now is kept until it is accepted.`;

export interface PairIo {
    out: (s: string) => void;
    err: (s: string) => void;
    ask: Ask | null;
}

/** The node takes the file within ~2 s; past this it is probably not running. */
const PICKUP_MS = 15_000;
/** The node probes the main server's address (5 s at most) before it answers. */
const ANSWER_MS = 30_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitMs(name: string, fallback: number): number {
    const v = Number(process.env[name]);
    return process.env.NODE_ENV === 'test' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** What this server runs as, as config/node-role.ts roleFromSettings reads it, without loading the node's config. */
function roleHere(dir: string): 'primary' | 'backup' {
    try {
        const configured = JSON.parse(fs.readFileSync(path.join(dir, 'local-config.json'), 'utf-8'))?.nodeRole;
        if (configured === 'primary' || configured === 'backup') return configured;
    } catch { /* none */ }
    return process.env.NODE_ROLE === 'backup' ? 'backup' : 'primary';
}

function readCodeFile(file: string): string | null {
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > PAIRING_CODE_MAX_CHARS * 2) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/** The command. Returns the exit code. */
export async function runPair(args: string[], io: PairIo, dir = dataDir()): Promise<number> {
    let codeFile: string | null = null;
    let follow = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--follow-new-server') { follow = true; continue; }
        if (a === '--code-file') {
            const v = args[i + 1];
            if (!v || v.startsWith('--')) { io.err(PAIR_USAGE); return 2; }
            codeFile = v; i++;
            continue;
        }
        if (a.startsWith('bpair1-')) {
            io.err('A pairing code is never given on the command line (the shell history and ps show it): '
                + 'use --code-file F, or type it when asked. Nothing was changed.');
            return 2;
        }
        io.err(PAIR_USAGE);
        return 2;
    }

    if (!fs.existsSync(path.join(dir, 'state.db'))) {
        io.err(`Nothing was changed. No node database at ${path.join(dir, 'state.db')}. Run this inside the node's container, or set BEANPOOL_DATA_DIR.`);
        return 1;
    }
    if (roleHere(dir) !== 'backup') {
        io.err('Nothing was changed. This server is a main server; a standby has NODE_ROLE=backup.');
        return 1;
    }

    let raw: string | null;
    if (codeFile) {
        raw = readCodeFile(codeFile);
        if (raw === null) { io.err(`Nothing was changed. ${codeFile} could not be read as a pairing code.`); return 1; }
    } else if (io.ask) {
        raw = await io.ask('Pairing code (from Replication Access on the main server): ', { secret: true });
        if (raw === null) { io.err('Nothing was changed. No pairing code was typed.'); return 1; }
    } else {
        io.err(PAIR_USAGE);
        return 2;
    }
    const parsed = parsePairingCode(raw);
    if (!parsed.ok) { io.err(`${parsed.why} Nothing was changed.`); return 1; }
    const code = parsed.code;

    const pin = readStandbyMain(dir);
    io.out(`Main server: ${code.url}, community ${code.communityId}, key ${keyEnd(code.peerId)}`);
    io.out(`This standby: ${pin ? `paired to ${keyEnd(pin.peerId)}` : 'not paired yet'}`);
    if (pin && pin.peerId !== code.peerId && !follow) {
        io.err(`This standby follows ${keyEnd(pin.peerId)}, and this code names ${keyEnd(code.peerId)}.`);
        io.err('To follow that server instead: beanpool pair --follow-new-server. Nothing was changed.');
        return 1;
    }

    const id = crypto.randomBytes(16).toString('hex');
    try {
        writePairRequestFile({ v: 1, id, code: raw.replace(/\s+/g, ''), followNewServer: follow, at: Date.now() }, dir);
    } catch (e: any) {
        io.err(`Nothing was changed. ${e?.message || e}`);
        return 1;
    }
    const started = Date.now();
    const pickupMs = waitMs('BEANPOOL_PAIR_PICKUP_MS', PICKUP_MS);
    const answerMs = waitMs('BEANPOOL_PAIR_ANSWER_MS', ANSWER_MS);
    const request = path.join(dir, PAIR_REQUEST_FILE);
    while (Date.now() - started < pickupMs + answerMs) {
        await pause(250);
        const answer = takePairAnswerFile(id, dir);
        if (answer) {
            const say = answer.ok ? io.out : io.err;
            for (const l of answer.lines) say(l);
            if (answer.amber) io.err(answer.amber);
            return answer.ok ? 0 : 1;
        }
        if (fs.existsSync(request) && Date.now() - started > pickupMs) {
            // Never half-done: a request the node has not taken is withdrawn.
            try { fs.rmSync(request, { force: true }); } catch { /* gone */ }
            io.err('The node did not take the pairing. Start the node, then run this again. Nothing was changed.');
            return 1;
        }
    }
    io.err('The node took the pairing but did not answer in time: check its log, and `beanpool pair` again to see where it stands.');
    return 1;
}
