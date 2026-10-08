import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * File modes in the image never depend on the caller's umask (image/build.sh, #1681). A build run under umask 077 (the
 * go-live scripts keep key files private that way) once copied every file into the image as 600/700, and vault-v1.0.0
 * booted on 1984 with no network (7 Oct). The vault-image workflow only ever builds under umask 022, so it cannot see it.
 *
 * So this runs a copy of the real build.sh, unchanged, under umask 077 and from private inputs (a checkout, Node, the
 * bundles and an --extra tree, all 600/700), as far as the point where mkosi would read the tree: stand-ins for the
 * bundles and Node's tarball (its pinned hash swapped for the stand-in's), and a `docker` that notes the tree it was
 * given and stops the build there. No Docker, no download: about a second a run.
 */

const IMAGE = fileURLToPath(new URL('../../image', import.meta.url));
const PINS = readFileSync(path.join(IMAGE, 'pins.env'), 'utf8');
const NODE_VERSION = /^NODE_VERSION=(.+)$/m.exec(PINS)![1];
const BUNDLES = ['vault-keyholder.mjs', 'vault-api.mjs', 'vault-launcher.mjs', 'vault-install.mjs', 'vault-egress.mjs'];
// The stand-in docker's own exit: the build got as far as mkosi.
const REACHED_MKOSI = 3;

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every entry under `root`: a directory's or file's mode in octal, a symlink's target. */
function listing(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (rel: string) => {
        const p = path.join(root, rel);
        const st = lstatSync(p);
        out[rel] = st.isSymbolicLink() ? `-> ${readlinkSync(p)}` : (st.mode & 0o7777).toString(8);
        if (st.isDirectory()) for (const name of readdirSync(p).sort()) visit(path.join(rel, name));
    };
    visit('.');
    return out;
}

/** A tree as a checkout made under umask 077 leaves it (600, 700 for programs and directories), or under 022. */
function setModes(root: string, isPrivate: boolean) {
    for (const [rel, mode] of Object.entries(listing(root))) {
        if (mode.startsWith('->')) continue;
        const program = lstatSync(path.join(root, rel)).isDirectory() || (parseInt(mode, 8) & 0o100) !== 0;
        chmodSync(path.join(root, rel), (program ? 0o755 : 0o644) & (isPrivate ? 0o700 : 0o777));
    }
}

interface Stage { buildSh: string; args: string[]; out: string; work: string; env: NodeJS.ProcessEnv; log: string }

/**
 * A scratch checkout to run build.sh in: build.sh (edited, for the refusal's own test), image-settings.mjs and the mkosi
 * tree; a stand-in scripts/bundle.mjs; Node's tarball in the cache under its pinned name, with pins.env naming its hash;
 * an --extra tree (as image/test-image/make.mjs lays over a test image); and a stand-in docker first on the PATH.
 * `unreadable` adds to the --extra tree a file only its owner can read and a directory nobody else can enter.
 */
function stage(name: string, opts: { isPrivate: boolean; edit?: (sh: string) => string; unreadable?: boolean }): Stage {
    const root = path.join(dir, name);
    const image = path.join(root, 'image');
    mkdirSync(image, { recursive: true });
    writeFileSync(path.join(image, 'build.sh'), (opts.edit ?? ((s) => s))(readFileSync(path.join(IMAGE, 'build.sh'), 'utf8')));
    copyFileSync(path.join(IMAGE, 'image-settings.mjs'), path.join(image, 'image-settings.mjs'));
    expect(spawnSync('cp', ['-R', path.join(IMAGE, 'mkosi'), path.join(image, 'mkosi')]).status).toBe(0);
    // The builder's tag is named after its Dockerfile.
    mkdirSync(path.join(image, 'builder'));
    copyFileSync(path.join(IMAGE, 'builder', 'Dockerfile'), path.join(image, 'builder', 'Dockerfile'));
    setModes(path.join(image, 'mkosi'), opts.isPrivate);

    const program = opts.isPrivate ? 0o700 : 0o755;
    const file = opts.isPrivate ? 0o600 : 0o644;
    const pkg = `node-v${NODE_VERSION}-linux-x64`;
    mkdirSync(path.join(root, 'node', pkg, 'bin'), { recursive: true });
    writeFileSync(path.join(root, 'node', pkg, 'bin', 'node'), '#!/bin/sh\n', { mode: program });
    writeFileSync(path.join(root, 'node', pkg, 'LICENSE'), 'stand-in\n', { mode: file });
    const cache = path.join(root, 'cache');
    mkdirSync(path.join(cache, 'packages'), { recursive: true });
    const txz = path.join(cache, `${pkg}.tar.xz`);
    // COPYFILE_DISABLE: macOS's tar would otherwise add ._ files for extended attributes.
    expect(spawnSync('tar', ['-cJf', txz, '-C', path.join(root, 'node'), pkg], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status).toBe(0);
    const pins = PINS.replace(/^NODE_SHA256=.*$/m, `NODE_SHA256=${createHash('sha256').update(readFileSync(txz)).digest('hex')}`);
    expect(pins).not.toBe(PINS);
    writeFileSync(path.join(image, 'pins.env'), pins);

    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'scripts', 'bundle.mjs'), [
        `import { mkdirSync, writeFileSync } from 'node:fs';`,
        `const out = process.argv[process.argv.indexOf('--out') + 1];`,
        `mkdirSync(out, { recursive: true });`,
        `for (const f of ${JSON.stringify(BUNDLES)}) writeFileSync(out + '/' + f, '// ' + f + '\\n', { mode: ${file} });`,
        '',
    ].join('\n'));

    const extra = path.join(root, 'extra');
    mkdirSync(path.join(extra, 'etc', 'beanpool-vault'), { recursive: true });
    mkdirSync(path.join(extra, 'usr', 'lib', 'beanpool-vault'), { recursive: true });
    writeFileSync(path.join(extra, 'etc', 'beanpool-vault', 'test.json'), '{}\n');
    writeFileSync(path.join(extra, 'usr', 'lib', 'beanpool-vault', 'test-driver'), '#!/bin/sh\n', { mode: 0o755 });
    setModes(extra, opts.isPrivate);
    if (opts.unreadable) {
        writeFileSync(path.join(extra, 'etc', 'left-private.conf'), 'x\n', { mode: 0o600 });
        mkdirSync(path.join(extra, 'srv', 'not-searchable'), { recursive: true });
        writeFileSync(path.join(extra, 'srv', 'not-searchable', 'readable'), 'x\n', { mode: 0o644 });
        chmodSync(path.join(extra, 'srv', 'not-searchable'), 0o744);
    }

    const keys = path.join(root, 'keys.json');
    writeFileSync(keys, JSON.stringify({ genesisCustodians: ['11', '22', '33'].map((b) => b.repeat(32)) }));

    // The stand-in docker: the builder is there, and the build (mkosi) stops before it starts, noting the tree it was given.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), [
        '#!/bin/sh',
        'case "$1" in',
        '    version) echo amd64 ;;',
        '    image) exit 0 ;;',
        `    run) for a in "$@"; do case "$a" in *:/work) printf '%s\\n' "\${a%:/work}" >> "$FAKE_DOCKER_LOG" ;; esac; done`,
        `         echo 'stand-in docker: stopped before mkosi' >&2; exit ${REACHED_MKOSI} ;;`,
        '    *) echo "stand-in docker: not expected: $*" >&2; exit 97 ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o755 });

    const out = path.join(root, 'out');
    const log = path.join(root, 'docker.log');
    return {
        buildSh: path.join(image, 'build.sh'),
        args: ['--custodian-keys', keys, '--version', '0.0.1', '--out', out, '--cache', cache, '--extra', extra],
        out,
        work: path.join(out, 'work'),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_LOG: log },
        log,
    };
}

function build(s: Stage, umask: '077' | '022') {
    return spawnSync('bash', ['-c', `umask ${umask}; exec bash "$0" "$@"`, s.buildSh, ...s.args], { env: s.env, encoding: 'utf8' });
}

/** The tree mkosi would have read: build.sh got as far as mkosi and handed it exactly ${out}/work. */
function reachedMkosi(s: Stage, r: ReturnType<typeof build>) {
    expect(r.stderr).toContain('stand-in docker: stopped before mkosi');
    expect(r.status).toBe(REACHED_MKOSI);
    expect(readFileSync(s.log, 'utf8').trim().split('\n').map((p) => realpathSync(p))).toEqual([realpathSync(s.work)]);
    return listing(s.work);
}

// What git holds for the repo's own mkosi tree: 644, 755 for programs and directories, symlinks as they are.
const gitModes = Object.fromEntries(Object.entries(listing(path.join(IMAGE, 'mkosi'))).map(([rel, mode]) => [rel,
    mode.startsWith('->') ? mode : (lstatSync(path.join(IMAGE, 'mkosi', rel)).isDirectory() || (parseInt(mode, 8) & 0o100) !== 0) ? '755' : '644']));

const withoutChmod = (sh: string) => {
    const lines = sh.split('\n');
    const kept = lines.filter((l) => !/^chmod -R .*"\$\{work\}"$/.test(l));
    expect(lines.length - kept.length).toBe(1);
    return kept.join('\n');
};

// A normal build (umask 022, a normal checkout): the tree the others are compared with.
let normalTree: Record<string, string> | undefined;
const normal = () => normalTree ??= (() => {
    const s = stage('normal', { isPrivate: false });
    return reachedMkosi(s, build(s, '022'));
})();

describe('the image\'s file modes do not depend on the caller\'s umask', () => {
    it('a normal build (umask 022, a normal checkout) hands mkosi git\'s modes', () => {
        const tree = normal();
        for (const [rel, mode] of Object.entries(gitModes)) expect([rel, tree[rel]]).toEqual([rel, mode]);
        // And what build.sh adds: Node, the bundles, the keyholder's config, the --extra tree, mkosi's apt sources.
        expect(tree['mkosi.extra/opt/node/bin/node']).toBe('755');
        expect(tree['mkosi.extra/opt/node/LICENSE']).toBe('644');
        for (const f of BUNDLES) expect(tree[`mkosi.extra/usr/lib/beanpool-vault/${f}`]).toBe('644');
        expect(tree['mkosi.extra/etc/beanpool-vault/keyholder.json']).toBe('644');
        expect(tree['mkosi.extra/etc/beanpool-vault/test.json']).toBe('644');
        expect(tree['mkosi.extra/usr/lib/beanpool-vault/test-driver']).toBe('755');
        expect(tree['mkosi.sandbox/etc/apt/sources.list.d/mkosi.sources']).toBe('644');
        for (const mode of Object.values(tree).filter((m) => !m.startsWith('->'))) expect(['644', '755']).toContain(mode);
    });

    it('under umask 077 with every input private (600/700), mkosi gets exactly the same tree, mode for mode', () => {
        const s = stage('private', { isPrivate: true });
        // The inputs really are private: the checkout, the bundles (written during the build) and the --extra tree.
        expect(lstatSync(path.join(s.buildSh, '..', 'mkosi', 'mkosi.conf')).mode & 0o777).toBe(0o600);
        expect(lstatSync(path.join(s.buildSh, '..', 'mkosi', 'mkosi.finalize')).mode & 0o777).toBe(0o700);
        const r = build(s, '077');
        expect(lstatSync(path.join(s.out, 'bundles', 'vault-api.mjs')).mode & 0o777).toBe(0o600);
        expect(reachedMkosi(s, r)).toEqual(normal());
    });

    it('on a normal build the normalisation changes nothing: without the chmod, mkosi gets the same tree (so the same image)', () => {
        const s = stage('normal-no-chmod', { isPrivate: false, edit: withoutChmod });
        expect(reachedMkosi(s, build(s, '022'))).toEqual(normal());
    });
});

describe('the refusal: a file not readable by every user stops the build before mkosi (with the chmod gone, it is all that is left)', () => {
    it('names the file only its owner can read and the directory nobody else can enter, and nothing else', () => {
        const s = stage('unreadable', { isPrivate: false, edit: withoutChmod, unreadable: true });
        const r = build(s, '022');
        expect(r.status).toBe(2);
        const [head, ...named] = r.stderr.trim().split('\n').filter((l) => !l.includes('(not a release image)'));
        expect(head).toBe('build.sh: not readable by every user, so the image would not run:');
        expect(named.sort()).toEqual([path.join(s.work, 'mkosi.extra/etc/left-private.conf'), path.join(s.work, 'mkosi.extra/srv/not-searchable')]);
        expect(existsSync(s.log)).toBe(false);
    });

    it('under umask 077 with private inputs it stops, and every path it names is one mkosi could not have used', () => {
        const s = stage('private-no-chmod', { isPrivate: true, edit: withoutChmod });
        const r = build(s, '077');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('build.sh: not readable by every user, so the image would not run:\n');
        const named = r.stderr.split('so the image would not run:\n')[1].trim().split('\n');
        expect(named.length).toBeGreaterThan(0);
        expect(named.length).toBeLessThanOrEqual(5);
        for (const p of named) {
            expect(p.startsWith(s.work)).toBe(true);
            const st = lstatSync(p);
            expect((st.mode & 0o004) === 0 || (st.isDirectory() && (st.mode & 0o001) === 0)).toBe(true);
        }
        expect(existsSync(s.log)).toBe(false);
    });
});
