/**
 * `beanpool lights-out on [--address http://192.168.8.1:8080] | off | status`, on the laptop's own shell, inside the node's
 * container (design scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §4.4; services/lights-out.ts).
 *
 * For the owner when no phone can sign in and the browser can't either: whoever runs this holds the data folder already,
 * which is more than any session. The running node does the switch: this process leaves data/lights-out-request.json and
 * waits for the answer (services/lights-out-files.ts), as `beanpool pair` does. The node's log keeps a SECURITY line.
 *
 * Exit codes: 0 done, 1 refused or no answer (nothing changed), 2 usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    LIGHTS_OUT_ANSWER_MS, LIGHTS_OUT_PICKUP_MS, LIGHTS_OUT_REQUEST_FILE, takeLightsOutAnswer, writeLightsOutRequest,
} from './services/lights-out-files.js';

export const LIGHTS_OUT_USAGE = `Usage: beanpool lights-out on [--address http://<the laptop's number>:8080] | off | status

Opens the hall: members' phones reach this server by its number on the hall Wi-Fi, with no internet.
  on         turn lights-out on. --address is the laptop's address on the hall Wi-Fi, for the poster.
  off        turn it off, once the internet is back.
  status     say whether it is on, the address, and how old the record is.
The node must be running. Only the server's own shell can do this, or an owner in Settings or the app.`;

interface Io { out: (l: string) => void; err: (l: string) => void }

/** The node takes the file within ~2 s; past this it is probably not running. The node refuses a request older than the two
 *  together (services/lights-out-files.ts LIGHTS_OUT_REQUEST_MAX_AGE_MS). */
const PICKUP_MS = LIGHTS_OUT_PICKUP_MS;
const ANSWER_MS = LIGHTS_OUT_ANSWER_MS;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitMs(name: string, fallback: number): number {
    const v = Number(process.env[name]);
    return process.env.NODE_ENV === 'test' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function runLightsOut(args: string[], io: Io): Promise<number> {
    const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const [action, ...rest] = args;
    if (action !== 'on' && action !== 'off' && action !== 'status') { io.err(LIGHTS_OUT_USAGE); return 2; }
    let address: string | null = null;
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--address' && action === 'on' && typeof rest[i + 1] === 'string') { address = rest[i + 1]; i++; continue; }
        io.err(LIGHTS_OUT_USAGE);
        return 2;
    }
    if (!fs.existsSync(path.join(dir, 'state.db'))) {
        io.err(`Nothing was changed. No node database at ${path.join(dir, 'state.db')}. Run this inside the node's container, or set BEANPOOL_DATA_DIR.`);
        return 1;
    }
    let id: string;
    try {
        id = writeLightsOutRequest({ action, address }, dir);
    } catch (e: any) {
        io.err(`Nothing was changed. ${e?.message || e}`);
        return 1;
    }
    const started = Date.now();
    const pickupMs = waitMs('BEANPOOL_LIGHTS_OUT_PICKUP_MS', PICKUP_MS);
    const answerMs = waitMs('BEANPOOL_LIGHTS_OUT_ANSWER_MS', ANSWER_MS);
    const request = path.join(dir, LIGHTS_OUT_REQUEST_FILE);
    while (Date.now() - started < pickupMs + answerMs) {
        await pause(200);
        const answer = takeLightsOutAnswer(id, dir);
        if (answer) {
            const say = answer.ok ? io.out : io.err;
            for (const l of answer.lines) say(l);
            return answer.ok ? 0 : 1;
        }
        if (fs.existsSync(request) && Date.now() - started > pickupMs) {
            // Never half-done: a request the node has not taken is withdrawn.
            try { fs.rmSync(request, { force: true }); } catch { /* gone */ }
            io.err('The node did not take it. Start the node (docker compose up -d), then run this again. Nothing was changed.');
            return 1;
        }
    }
    io.err('The node took it but did not answer in time: run `beanpool lights-out status` to see where it stands.');
    return 1;
}
