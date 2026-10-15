/**
 * Questions at the terminal for the `beanpool` shell commands (restore-command.ts, restore-point-command.ts). One reader
 * over stdin for the whole run, so a piped answer for each question works as well as typing them. A secret (a recovery
 * code) is not echoed on a terminal.
 */
import readline from 'node:readline';

/** Ask one question; the line typed, or null when stdin has ended. */
export type Ask = (question: string, opts?: { secret?: boolean }) => Promise<string | null>;

export function terminalAsk(): { ask: Ask; close: () => void } {
    const tty = !!process.stdin.isTTY;
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
        else waiting.push(done);
    });
    return { ask, close: () => rl.close() };
}
