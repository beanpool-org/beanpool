import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The web app signs nothing itself. Every signature a member makes here is built by one of @beanpool/core's builders
 * (request-signing.ts: buildBoundRequestHeaders, buildBoundWsParams, buildInviteTicket), over bytes core built, in
 * format 2, which names the community it was signed for. A hand-written signature is how the old, unbound format came
 * about (good at every community for five minutes), and signing text a node sent is how the phone's "Manage" button
 * could be made to forge a request for another community. So: no signing call anywhere in the app's source, and the
 * member key becomes a core Signer in one place only (lib/api.ts), which hands it only to core's builders.
 */

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name) || name === 'setupTests.ts') return [];
        return [path];
    });
}

const FILES = sourceFiles(SRC);
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const CORE_BUILDERS = ['buildBoundRequestHeaders', 'buildBoundWsParams', 'buildInviteTicket'];

describe('the web app signs only through core\'s builders', () => {
    it('finds the app\'s source', () => {
        expect(FILES.map(f => relative(SRC, f))).toEqual(expect.arrayContaining(['lib/api.ts', 'lib/sync.ts', 'pages/InvitePage.tsx']));
    });

    it('no file calls a signing function (WebCrypto\'s subtle.sign, noble\'s ed25519.sign, or any other sign())', () => {
        const offenders = FILES
            .filter(f => /\bsign\s*\(|\bsubtle\s*\.\s*sign\b|\bsignEd25519\b|\bsignWithPrivateKey\b|\bsignData\b/.test(readFileSync(f, 'utf8')))
            .map(f => relative(SRC, f));
        expect(offenders).toEqual([]);
    });

    it('the member key becomes a signer only in lib/api.ts, and is handed only to core\'s builders', () => {
        const makers = FILES.filter(f => /\bed25519Signer\s*\(/.test(readFileSync(f, 'utf8'))).map(f => relative(SRC, f));
        expect(makers).toEqual(['lib/api.ts']);

        const api = read('lib/api.ts');
        expect(api.match(/\bed25519Signer\s*\(/g)).toHaveLength(1);
        expect(api).toMatch(/function memberSigner\([^)]*\)[^{]*\{\s*return ed25519Signer\(/);

        const uses = [...api.matchAll(/\bmemberSigner\s*\(/g)]
            .map(m => m.index!)
            .filter(at => !api.slice(0, at).endsWith('function '));
        expect(uses).toHaveLength(3);
        for (const at of uses) {
            // Made inside the arguments of a call to one of core's builders: the nearest such call before it, with no
            // `;` between (so not a signer kept in a variable, and not one handed to anything else).
            const before = api.slice(0, at);
            const builderAt = Math.max(...CORE_BUILDERS.map(b => before.lastIndexOf(`${b}(`)));
            expect(builderAt).toBeGreaterThan(-1);
            expect(before.slice(builderAt)).not.toContain(';');
        }
    });
});
