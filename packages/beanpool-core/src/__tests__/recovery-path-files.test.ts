/**
 * Which files are on the 12 words' key path, computed rather than listed (review of #1941, N10 and N-d).
 *
 * The words-layer check (#1941, words.test.ts "no file that turns words into a key reaches the words layer") names six
 * files. The review found 13 more that also hold, check or turn the words into a key: native restore-account.ts,
 * sso-recovery.ts, identity.ts, add-words.ts, owner-words.ts, vault.ts, group-history-unlock.ts, recovery-kit.ts; web
 * lib/identity.ts, lib/join-recovery.ts, lib/recovery-kit.ts; core keeper-crypto.ts, recovery-kit.ts. A fixed list
 * misses the next one too, so here the list is every module that imports or defines a word helper: a name exported
 * by core's word modules (the words, the key from them, the owners' check, the kit, the keepers' split), or one of the
 * apps' own (the derivation in native utils/crypto.ts and web lib/mnemonic.ts, and the identity modules' functions that
 * take, keep or read back an account's words).
 *
 * The scan covers the layers below the screens: core, native utils and web lib. Screens (native app/ and components/,
 * web pages/ and components/) take the words through these modules and have UI sentences of their own to translate.
 * The server parses no member's words (measured: no server module imports a word helper; the one route that names
 * owner-words-check.ts uses only its URL path).
 *
 * The rule each one keeps: nothing on it can route a word through the words layer. No `t`, `tn`, `word`, `wordsFor` or
 * `setLanguage` imported (from core or from the words module), no namespace import of the words module, and no call
 * of `t(`, `tn(` or `word(`. A date in the member's language (`formatDate`, the printed kit's date) is not a word and
 * is allowed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Core's word modules: every name they export means "the 12 words". */
const CORE_WORD_MODULES = [
    'packages/beanpool-core/src/recovery-words.ts',
    'packages/beanpool-core/src/recovery-words-seed.ts',
    'packages/beanpool-core/src/bip39-english.ts',
    'packages/beanpool-core/src/owner-words-check.ts',
    'packages/beanpool-core/src/recovery-kit.ts',
    'packages/beanpool-core/src/recovery-split.ts',
];
/** The apps' own: the derivation (native utils/crypto.ts, web lib/mnemonic.ts, lib/bip39-wordlist.ts), and the identity
 *  modules' functions that make an account from words, keep them, or read them back to show (words-behind-lock.ts). */
const APP_WORD_HELPERS = [
    'WORDLIST', 'validateMnemonic', 'mnemonicToKeypair', 'generateMnemonic',
    'identityFromMnemonic', 'createIdentityFromMnemonic', 'restoreFromWords', 'addMnemonicToIdentity', 'getMnemonic', 'readWordsBehindLock',
];
/** The layers below the screens. */
const SCAN_DIRS = ['packages/beanpool-core/src', 'apps/native/utils', 'apps/pwa/src/lib'];

/** Comments out, so a file that only mentions a helper in its notes is not counted, and a note saying "t()" is not a call. */
function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function exportedNames(src: string): string[] {
    const names: string[] = [];
    for (const m of src.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([\w$]+)/g)) names.push(m[1]);
    for (const m of src.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
            if (name) names.push(name);
        }
    }
    return names;
}

export function wordHelperNames(): string[] {
    const fromCore = CORE_WORD_MODULES.flatMap((file) => exportedNames(code(readFileSync(join(ROOT, file), 'utf8'))));
    return [...new Set([...fromCore, ...APP_WORD_HELPERS])].sort();
}

/** Every non-test module in the scanned layers that imports or defines a word helper, repo-relative and sorted. */
export function recoveryPathFiles(): string[] {
    const helper = new RegExp(String.raw`\b(?:${wordHelperNames().map((n) => n.replace(/\$/g, '\\$')).join('|')})\b`);
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) {
                if (helper.test(code(readFileSync(path, 'utf8')))) found.push(relative(ROOT, path));
            }
        }
    };
    for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
    return found.sort();
}

const WORDS_LAYER_NAMES = ['t', 'tn', 'word', 'wordsFor', 'setLanguage'];
/** A module specifier that is the words layer: core itself, or the words module by any relative or deep path. */
const WORDS_MODULE = String.raw`['"](?:@beanpool/core|(?:[^'"]*/)?words(?:\.js)?)['"]`;

/** What a key-path file does that could route a word through the words layer, or [] when it does nothing of the kind. */
export function wordsLayerUse(src: string): string[] {
    const s = code(src);
    const seen: string[] = [];
    for (const m of s.matchAll(new RegExp(String.raw`\b(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${WORDS_MODULE}`, 'g'))) {
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (WORDS_LAYER_NAMES.includes(name)) seen.push(`imports ${name}`);
        }
    }
    for (const m of s.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*${WORDS_MODULE}\s*\)`, 'g'))) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(':')[0].trim();
            if (WORDS_LAYER_NAMES.includes(name)) seen.push(`imports ${name}`);
        }
    }
    if (new RegExp(String.raw`\bimport\s*\*\s*as\s+[\w$]+\s+from\s*['"](?:[^'"]*/)?words(?:\.js)?['"]`).test(s)) seen.push('imports the words module whole');
    for (const m of s.matchAll(/(?<![\w$])(t|tn|word)\s*\(/g)) seen.push(`calls ${m[1]}(`);
    return [...new Set(seen)];
}

describe('the 12 words\' key path, computed', () => {
    const files = recoveryPathFiles();

    it('covers the six files the words-layer check names, and every file the review found it missing', () => {
        expect(files).toEqual(expect.arrayContaining([
            // The words-layer check's six.
            'packages/beanpool-core/src/recovery-words.ts',
            'packages/beanpool-core/src/recovery-words-seed.ts',
            'packages/beanpool-core/src/bip39-english.ts',
            'packages/beanpool-core/src/owner-words-check.ts',
            'apps/native/utils/crypto.ts',
            'apps/pwa/src/lib/mnemonic.ts',
            // N10.
            'apps/native/utils/restore-account.ts',
            'apps/native/utils/sso-recovery.ts',
            'apps/native/utils/identity.ts',
            'apps/native/utils/add-words.ts',
            'apps/native/utils/owner-words.ts',
            'apps/native/utils/vault.ts',
            'apps/pwa/src/lib/identity.ts',
            'apps/pwa/src/lib/join-recovery.ts',
            'packages/beanpool-core/src/keeper-crypto.ts',
            // N-d's computed scan.
            'apps/native/utils/group-history-unlock.ts',
            'apps/native/utils/recovery-kit.ts',
            'apps/pwa/src/lib/recovery-kit.ts',
            'packages/beanpool-core/src/recovery-kit.ts',
            // Also on it: the keepers' split of the phrase, the web's sealed-copy restore, and the phone's words read back to show.
            'packages/beanpool-core/src/recovery-split.ts',
            'apps/pwa/src/lib/web-restore.ts',
            'apps/native/utils/words-behind-lock.ts',
        ]));
    });

    it('no file on it reaches the words layer', () => {
        const reached = files.flatMap((file) => wordsLayerUse(readFileSync(join(ROOT, file), 'utf8')).map((use) => `${file}: ${use}`));
        expect(reached).toEqual([]);
    });
});

describe('the scan itself', () => {
    it('finds a helper imported under another name, and ignores one only mentioned in a comment', () => {
        const names = wordHelperNames();
        expect(names).toEqual(expect.arrayContaining(['BIP39_ENGLISH', 'normaliseRecoveryWords', 'lowercaseRecoveryWords', 'seedFromRecoveryWords',
            'recoveryWordsMatchPublicKey', 'recoveryWordsMatchSeed', 'checkOwnerWords', 'recoveryKitHtml', 'mnemonicToKeypair', 'WORDLIST']));
        expect(code('// see normaliseRecoveryWords\n/** recoveryKitHtml */\nconst url = "https://x.example/t(";')).not.toMatch(/normaliseRecoveryWords|recoveryKitHtml/);
    });

    it('sees each way a file could reach the words layer, and lets a date through', () => {
        expect(wordsLayerUse("import { t } from '@beanpool/core';\nt('Saved');")).toEqual(['imports t', 'calls t(']);
        expect(wordsLayerUse("import { tn as plural, formatDate } from './words.js';")).toEqual(['imports tn']);
        expect(wordsLayerUse("import { wordsFor } from '@beanpool/core/dist/words.js';")).toEqual(['imports wordsFor']);
        expect(wordsLayerUse("export { setLanguage } from './words.js';")).toEqual(['imports setLanguage']);
        expect(wordsLayerUse("const { word: w } = await import('@beanpool/core');")).toEqual(['imports word']);
        expect(wordsLayerUse("import * as W from '../words';")).toEqual(['imports the words module whole']);
        expect(wordsLayerUse('const s = core.tn(2, a, b);')).toEqual(['calls tn(']);
        // A date in the member's language is not a word (the printed kit's date, #1941's recovery-kit.ts).
        expect(wordsLayerUse("import { formatDate } from './words.js';\nformatDate(d, 'day-month-year');")).toEqual([]);
        // Names that only end in t or word, and notes, are not calls.
        expect(wordsLayerUse('split(x); wordIndex(w); sort(); // t(word)\n/* tn(2) */')).toEqual([]);
    });
});
