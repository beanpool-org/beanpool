/**
 * X8 part 1, check (5): the checks can fail. Each mutant below is src/ratchet.ts with one deliberate mistake, written to a
 * scratch folder in this package for the length of this file's run (.ratchet-mutant-*, ignored by git, removed after), and
 * imported in place of the real module. The table of message orders, the vodozemac replays and the key-erasure check then run
 * against it, and the ones named for that mutant must fail. A mutant whose line is no longer in src/ratchet.ts fails too, so
 * a rewrite of the module can't quietly retire a mutant. The unmutated copy, run the same way, must pass everything: so a
 * failure is the mutation's, not the copying's.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ratchet from '../ratchet.js';
import { checkKeyErasure, ratchetTable, replayVodozemac, runRow, vodozemacTranscripts, type RatchetApi } from './ratchet-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, '../ratchet.ts'), 'utf8');
const DIR = mkdtempSync(join(resolve(HERE, '../..'), '.ratchet-mutant-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Check = 'table' | 'oracle' | 'erasure';
interface Mutant {
    name: string;
    from: string;
    to: string;
    caughtBy: Check[];
}

const MUTANTS: Mutant[] = [
    { name: 'a used skipped key is kept (replays open)', from: '        next.skipped.splice(s, 1);\n', to: '', caughtBy: ['table'] },
    {
        name: 'no skip limit',
        from: 'if (wire.index - chain.index > RATCHET_MAX_SKIP)',
        to: 'if (wire.index - chain.index > RATCHET_MAX_SKIP * 1000)',
        caughtBy: ['table'],
    },
    { name: 'the MAC is not checked', from: "if (!equalBytes(expected, wire.mac)) throw new RatchetRefusedError('mac');", to: '', caughtBy: ['table'] },
    {
        name: "a receiving chain doesn't move on after a message",
        from: '    chain.chainKey = step.chainKey;\n    chain.index += 1;\n    return { state: next, plaintext };',
        to: '    return { state: next, plaintext };',
        caughtBy: ['table', 'erasure'],
    },
    {
        name: 'our sending chain survives their new ratchet key (no step per change of direction)',
        from: '        next.sending = null;\n        chain = {',
        to: '        chain = {',
        caughtBy: ['table', 'oracle'],
    },
    {
        name: 'the oldest receiving chain is not dropped at the cap',
        from: 'if (next.receiving.length > RATCHET_MAX_RECEIVING_CHAINS)',
        to: 'if (next.receiving.length > RATCHET_MAX_RECEIVING_CHAINS + 1)',
        caughtBy: ['table'],
    },
    {
        name: 'the oldest skipped keys are not dropped at the cap',
        from: 'next.skipped.splice(0, next.skipped.length - RATCHET_MAX_SKIPPED_KEYS)',
        to: 'void 0',
        caughtBy: ['table'],
    },
    {
        name: 'a refused message changes the state (receiving chains not copied)',
        from: 'receiving: s.receiving.map((c) => ({ ...c })),',
        to: 'receiving: s.receiving,',
        caughtBy: ['table'],
    },
    {
        name: 'a new ratchet key is taken with no key of ours out',
        from: "if (!next.sending) throw new RatchetRefusedError('unexpected-ratchet-key');",
        to: '',
        caughtBy: ['table'],
    },
    {
        name: "a pre-key message's session is not checked",
        from: "            throw new RatchetRefusedError('session-mismatch');\n        }\n        body = pre.message;",
        to: '        }\n        body = pre.message;',
        caughtBy: ['table'],
    },
    {
        name: 'the MAC is always cut to 8 bytes',
        from: 'hmac(sha256, keys.macKey, authenticated).slice(0, next.macBytes)',
        to: 'hmac(sha256, keys.macKey, authenticated).slice(0, 8)',
        caughtBy: ['table', 'oracle'],
    },
    {
        name: 'used message keys stay in the state (unreachable, but stealable)',
        from: '    const plaintext = open(step.messageKey, wire);\n',
        to: '    const plaintext = open(step.messageKey, wire);\n    next.skipped.push({ ratchetKey: chain.ratchetKey, index: -1, messageKey: step.messageKey });\n',
        caughtBy: ['erasure'],
    },
    {
        name: 'the chain and message steps swapped (0x01 and 0x02)',
        from: 'const CHAIN_STEP = Uint8Array.of(0x02);\nconst MESSAGE_STEP = Uint8Array.of(0x01);',
        to: 'const CHAIN_STEP = Uint8Array.of(0x01);\nconst MESSAGE_STEP = Uint8Array.of(0x02);',
        caughtBy: ['oracle'],
    },
    {
        name: "the root key doesn't advance on their new ratchet key",
        from: '        next.rootKey = step.rootKey;\n        next.sending = null;',
        to: '        next.sending = null;',
        caughtBy: ['oracle'],
    },
    { name: "the start's HKDF label", from: "utf8ToBytes('OLM_ROOT')", to: "utf8ToBytes('OLM_ROOT ')", caughtBy: ['oracle'] },
    { name: "the message keys' HKDF label", from: "utf8ToBytes('OLM_KEYS')", to: "utf8ToBytes('OLM-KEYS')", caughtBy: ['oracle', 'erasure'] },
];

const rows = ratchetTable(ratchet);
const transcripts = vodozemacTranscripts();

function fails(run: () => void): boolean {
    try {
        run();
        return false;
    } catch {
        return true;
    }
}

function checks(api: RatchetApi): Record<Check, boolean> {
    return {
        table: rows.some((row) => ([8, 32] as const).some((mac) => fails(() => runRow(api, row, mac)))),
        oracle: transcripts.some((t) => fails(() => replayVodozemac(api, t))),
        erasure: fails(() => checkKeyErasure(api, 8)),
    };
}

let n = 0;
async function load(source: string): Promise<RatchetApi> {
    const file = join(DIR, `ratchet-${(n += 1)}.ts`);
    writeFileSync(file, source);
    return (await import(file)) as RatchetApi;
}

describe('src/ratchet.ts: every deliberate mistake fails the checks', () => {
    it('the unmutated copy passes every check (so a failure below is the mutation)', async () => {
        expect(checks(await load(SOURCE))).toEqual({ table: false, oracle: false, erasure: false });
    });

    for (const m of MUTANTS) {
        it(`${m.name}: caught by ${m.caughtBy.join(' and ')}`, async () => {
            expect(SOURCE.split(m.from).length - 1, 'the line this mutant changes is in src/ratchet.ts exactly once').toBe(1);
            const caught = checks(await load(SOURCE.replace(m.from, m.to)));
            for (const c of m.caughtBy) expect(caught[c], `${c} catches it`).toBe(true);
        });
    }
});
