/**
 * Questions at the terminal for the `beanpool` shell commands (restore-command.ts, restore-point-command.ts). One reader
 * over stdin for the whole run, so a piped answer for each question works as well as typing them. A secret (a recovery
 * code) is not echoed on a terminal.
 *
 * A question waits {@link PROMPT_GIVE_UP_MS} at most, then the command gives up (#2017 confirmation review N7): it holds
 * the node's lock while it asks (node-running-lock.ts), and a node started then waits for it, so a session dropped at a
 * question (an SSH connection lost, its `docker compose run` container left running) must not keep the node down for
 * days. Every question is asked before anything is changed.
 */
import readline from 'node:readline';

/** Ask one question; the line typed, or null when stdin has ended. */
export type Ask = (question: string, opts?: { secret?: boolean }) => Promise<string | null>;

/** 30 minutes. BEANPOOL_PROMPT_GIVE_UP_MS sets it shorter, for tests. */
export const PROMPT_GIVE_UP_MS = 30 * 60_000;

function giveUpMs(): number {
    const ms = Number(process.env.BEANPOOL_PROMPT_GIVE_UP_MS);
    return Number.isFinite(ms) && ms > 0 ? ms : PROMPT_GIVE_UP_MS;
}

function inWords(ms: number): string {
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} s`;
}

export function terminalAsk(): { ask: Ask; close: () => void } {
    const tty = !!process.stdin.isTTY;
    const waitMs = giveUpMs();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    const lines: string[] = [];
    const waiting: Array<(line: string | null) => void> = [];
    let ended = false;
    let muted = false;
    (rl as any)._writeToOutput = (s: string) => { if (!muted) process.stdout.write(s); };
    rl.on('line', (l) => {
        const w = waiting.shift();
        if (w) w(l); else lines.push(l);
    });
    rl.on('close', () => {
        ended = true;
        while (waiting.length) waiting.shift()!(null);
    });
    const ask: Ask = (question, opts = {}) => new Promise((resolve) => {
        process.stdout.write(question);
        muted = !!opts.secret && tty;
        const done = (l: string | null) => {
            if (muted) process.stdout.write('\n');
            muted = false;
            resolve(l);
        };
        if (lines.length) done(lines.shift()!);
        else if (ended) done(null);
        else {
            const giveUp = setTimeout(() => {
                if (muted) process.stdout.write('\n');
                process.stderr.write(`\nNo answer in ${inWords(waitMs)}: this command gives up, so the node can start. Nothing was changed.\n`);
                process.exit(1);
            }, waitMs);
            waiting.push((l) => {
                clearTimeout(giveUp);
                done(l);
            });
        }
    });
    return { ask, close: () => rl.close() };
}
