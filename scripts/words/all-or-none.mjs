// all-or-none.mjs — sentences that a test holds to "in every language's catalog, or in none".
//
// A drafting round that fills such a sentence in some languages and not the others turns that test red: the 4 Nov
// machine-drafting PRs (#2841, #2842) each broke 20 checks of language-switch-render.test.ts that way, because
// `words:draft --briefs` asked for the welcome screens' sentences one language at a time.
//
// So the group's rule lives here, ONCE. The test reads its sentences with `cardSentences` from this file, and
// `words:draft` (draft.mjs) reads the same ones through ALL_OR_NONE_GROUPS, so the two cannot drift apart. Keep this file
// free of anything the phone's bundle would need: it is read by node scripts and by the test, never by the app.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The source with what is not on a phone's card taken out: every call that hands its words to one of the phone's own
 * dialogs (an alert, the phone's lock prompt), which the phone draws and wraps itself, and what only the web build
 * draws. What is left is the phone's cards. (Moved from language-switch-render.test.ts, unchanged.)
 * @param {string} src
 * @returns {string}
 */
export function onPhoneCards(src) {
    let out = src;
    for (const name of ['Alert.alert(', 'authenticateUser(', 'readWordsBehindLock(', "Platform.OS === 'web' && ("]) {
        for (let at = out.indexOf(name); at >= 0; at = out.indexOf(name, at + 1)) {
            let depth = 0;
            let end = at + name.length - 1;
            for (; end < out.length; end++) {
                if (out[end] === '(') depth++;
                else if (out[end] === ')' && --depth === 0) break;
            }
            out = out.slice(0, at) + ' '.repeat(end + 1 - at) + out.slice(end + 1);
        }
    }
    return out;
}

/**
 * The sentences a phone card reads through `t('…')`, in the order the source has them (a repeat is repeated).
 * @param {string} src
 * @returns {string[]}
 */
export function cardSentences(src) {
    return Array.from(onPhoneCards(src).matchAll(/\bt\((['"])((?:(?!\1)[^\\]|\\.)*)\1/g)).map((m) => m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
}

/**
 * The groups. `folder`: the words folder whose catalogs hold the group (the rule is per folder: apps/native/words/<lang>.json).
 * `sources`: the files whose sentences make the group, joined with a line break in this order. `sentences`: reads them.
 * `test`: the test that holds the rule, which a brief names so a drafter knows why.
 */
export const ALL_OR_NONE_GROUPS = Object.freeze([
    Object.freeze({
        // The home screen's two doors and the join screen (DESIGN-global-entry §B.3): "A sentence the drafting pass has reached
        // is in every language" (language-switch-render.test.ts, S3j). A sentence it hasn't reached shows its English.
        name: 'welcome screens',
        folder: 'apps/native/words',
        sources: Object.freeze(['apps/native/app/welcome.tsx', 'apps/native/components/WelcomeDoors.tsx']),
        sentences: cardSentences,
        test: 'apps/native/utils/__tests__/language-switch-render.test.ts',
    }),
]);

/**
 * The sentences of one group, read from the group's source files under `root`. A source file the tree doesn't have (a test
 * fixture) adds nothing.
 * @param {{ sources: readonly string[], sentences: (src: string) => string[] }} group
 * @param {string} root
 * @returns {Set<string>}
 */
export function groupSentences(group, root) {
    const texts = [];
    for (const rel of group.sources) {
        const file = path.join(root, rel);
        if (fs.existsSync(file)) texts.push(fs.readFileSync(file, 'utf8'));
    }
    return new Set(texts.length > 0 ? group.sentences(texts.join('\n')) : []);
}
