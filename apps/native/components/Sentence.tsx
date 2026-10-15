/**
 * A translated sentence with a link (or any element) inside it, kept ONE sentence for the translator:
 *
 *   <Sentence text={t('By joining you agree to our {terms} and {privacy}.')} parts={{ terms: <Text …>…</Text>, privacy: … }} />
 *
 * Each `{name}` in the text is replaced by its element, wherever the language put it; a placeholder with no element is
 * left as written. Gluing pieces together instead (`t('By joining you agree to our') + link`) breaks in any language whose
 * word order differs and in right-to-left text, and words:check refuses it (design §2.5 rule 1).
 */

import React from 'react';

export function sentenceParts(text: string, names: readonly string[]): (string | { name: string })[] {
    const out: (string | { name: string })[] = [];
    let last = 0;
    for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
        if (!names.includes(m[1])) continue;
        if (m.index! > last) out.push(text.slice(last, m.index));
        out.push({ name: m[1] });
        last = m.index! + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

export function Sentence({ text, parts }: { text: string; parts: Record<string, React.ReactElement> }) {
    return (
        <>
            {sentenceParts(text, Object.keys(parts)).map((piece, i) => (
                typeof piece === 'string' ? <React.Fragment key={i}>{piece}</React.Fragment> : <React.Fragment key={i}>{parts[piece.name]}</React.Fragment>
            ))}
        </>
    );
}
