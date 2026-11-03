/**
 * The files `beanpool lights-out` and the running node hand each other (services/lights-out.ts, lights-out-command.ts), the
 * pattern of `beanpool pair`: the command leaves data/lights-out-request.json, the node takes it within ~2 s and answers
 * in data/lights-out-answer.json. Nothing heavy is imported here: the command loads no part of the node.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../write-file-atomic.js';

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

export const LIGHTS_OUT_REQUEST_FILE = 'lights-out-request.json';
export const LIGHTS_OUT_ANSWER_FILE = 'lights-out-answer.json';

export interface LightsOutRequest { v: 1; id: string; action: 'on' | 'off' | 'status'; address: string | null; at: number }
export interface LightsOutAnswer { v: 1; id: string; ok: boolean; lines: string[] }

function readSmall(file: string): string | null {
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > 4096) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

export function writeLightsOutRequest(req: Omit<LightsOutRequest, 'v' | 'id' | 'at'>, dir = dataDir()): string {
    const id = crypto.randomBytes(12).toString('hex');
    writeFileAtomic(path.join(dir, LIGHTS_OUT_REQUEST_FILE), JSON.stringify({ v: 1, id, at: Date.now(), ...req }), { mode: 0o600 });
    return id;
}

export function takeLightsOutAnswer(id: string, dir = dataDir()): LightsOutAnswer | null {
    const file = path.join(dir, LIGHTS_OUT_ANSWER_FILE);
    const text = readSmall(file);
    if (text === null) return null;
    try {
        const a = JSON.parse(text);
        if (!a || a.v !== 1 || a.id !== id) return null;
        try { fs.unlinkSync(file); } catch { /* gone */ }
        return { v: 1, id, ok: a.ok === true, lines: Array.isArray(a.lines) ? a.lines.filter((l: unknown) => typeof l === 'string') : [] };
    } catch {
        return null;
    }
}

/** In the node: the request, and the file gone; null when there is none (anything that is not one is removed). */
export function takeLightsOutRequest(dir = dataDir()): LightsOutRequest | null {
    const file = path.join(dir, LIGHTS_OUT_REQUEST_FILE);
    let there = false;
    try { there = !!fs.lstatSync(file); } catch { return null; }
    const text = readSmall(file);
    if (there) { try { fs.rmSync(file, { force: true }); } catch { /* a directory: left */ } }
    if (text === null) return null;
    try {
        const r = JSON.parse(text);
        if (!r || r.v !== 1 || typeof r.id !== 'string' || !/^[0-9a-f]{16,32}$/.test(r.id)) return null;
        if (r.action !== 'on' && r.action !== 'off' && r.action !== 'status') return null;
        return { v: 1, id: r.id, action: r.action, address: typeof r.address === 'string' ? r.address : null, at: Number(r.at) || Date.now() };
    } catch {
        return null;
    }
}

