/**
 * The record of registrar names (engine/registrar-names.ts) keeps only what the registrar really gives, since it never
 * forgets (#1247's deciding review):
 *   1. only real registrar names: one label of 3-32 characters under beanpool.org (4115220781). A stray host in an
 *      answer, a stored address or a take-over envelope is never recorded, so a misbehaving registrar can't make one,
 *      such as 127.0.0.1, accepted here for good;
 *   2. a name that becomes current again no longer says this node renamed away from it (4115220714);
 *   3. a release answer with no `held_until` records no hold: the registrar freed the name at once (4115220670).
 */
import { initStateEngine, getNodeConfig, updateNodeConfig } from './state-engine.js';
import { recordRegistrarAnswer, registrarNames, parseRegistrarNames, isRegistrarNameHost } from './engine/registrar-names.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const NOW = Date.parse('2026-10-30T12:00:00Z');
const hosts = () => registrarNames(getNodeConfig(), NOW).map((e) => e.address).sort();
const entry = (h: string) => registrarNames(getNodeConfig(), NOW).find((e) => e.address === h);
const reset = () => updateNodeConfig({ registrarNames: [], publicAddress: null } as any);

function main() {
    console.log('Running registrar-names record tests...');
    initStateEngine();

    // 1. Only real registrar names.
    for (const [h, ok] of [
        ['aaa.beanpool.org', true], ['a-b-c.beanpool.org', true], [`${'a'.repeat(32)}.beanpool.org`, true],
        ['ab.beanpool.org', false], [`${'a'.repeat(33)}.beanpool.org`, false], ['-ab.beanpool.org', false],
        ['a.b.beanpool.org', false], ['127.0.0.1', false], ['evil.example', false], ['localhost', false],
    ] as const) assert(isRegistrarNameHost(h) === ok, `${h} is ${ok ? '' : 'not '}a registrar name`);

    reset();
    recordRegistrarAnswer({ status: 'live', name: '127.0.0.1' }, 'claim', NOW);
    recordRegistrarAnswer({ status: 'live', hostname: 'evil.example' }, 'claim', NOW);
    recordRegistrarAnswer({ status: 'live', name: 'ddd' }, 'claim', NOW);
    assert(JSON.stringify(hosts()) === JSON.stringify(['ddd.beanpool.org']),
        `answers naming 127.0.0.1 or evil.example record nothing; ddd is recorded (${JSON.stringify(hosts())})`);

    // A stored record (or a take-over envelope) holding a stray host: dropped when read.
    const parsed = parseRegistrarNames([
        { address: '127.0.0.1', role: 'former', status: 'live', since: new Date(NOW).toISOString() },
        { address: 'kept.beanpool.org', role: 'current', status: 'live', since: new Date(NOW).toISOString() },
    ]);
    assert(parsed.length === 1 && parsed[0].address === 'kept.beanpool.org', `a stored stray host is dropped, a real name kept (${JSON.stringify(parsed.map((e) => e.address))})`);

    // 2. Renamed away and back: the name current again carries no rename mark.
    reset();
    recordRegistrarAnswer({ status: 'live', name: 'aaa' }, 'claim', NOW);
    recordRegistrarAnswer({ status: 'live', name: 'bbb' }, 'claim', NOW + 1000);
    assert(entry('aaa.beanpool.org')?.role === 'former' && typeof entry('aaa.beanpool.org')?.renamedByUsAt === 'string',
        'claiming bbb makes aaa former, renamed away from');
    recordRegistrarAnswer({ status: 'live', name: 'aaa' }, 'claim', NOW + 2000);
    const back = entry('aaa.beanpool.org');
    assert(back?.role === 'current' && back?.formerSince === null && back?.renamedByUsAt === null,
        `aaa current again: no former mark, no rename mark (${JSON.stringify(back ?? null)})`);
    assert(entry('bbb.beanpool.org')?.role === 'former' && typeof entry('bbb.beanpool.org')?.renamedByUsAt === 'string',
        'and bbb is the one renamed away from');

    // 3. A release: the hold is the registrar's, or none.
    reset();
    recordRegistrarAnswer({ status: 'live', name: 'held' }, 'claim', NOW);
    const heldUntilS = Math.floor(NOW / 1000) + 30 * 86_400;
    recordRegistrarAnswer({ status: 'released', name: 'held', held_until: heldUntilS }, 'released', NOW);
    assert(Date.parse(entry('held.beanpool.org')?.heldUntil ?? '') === heldUntilS * 1000, "a release with held_until keeps the registrar's hold");
    recordRegistrarAnswer({ status: 'live', name: 'freed' }, 'claim', NOW);
    recordRegistrarAnswer({ status: 'released', name: 'freed' }, 'released', NOW);
    const freed = entry('freed.beanpool.org');
    assert(freed?.role === 'former' && freed?.status === 'released' && freed?.heldUntil === null && typeof freed?.releasedByUsAt === 'string',
        `a release with no held_until records no hold, and is still recorded (never forgotten) (${JSON.stringify(freed ?? null)})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main();
