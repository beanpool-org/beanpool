/**
 * A translated sentence with an element inside it (a bold name, a link, a coloured word), kept ONE sentence for the
 * translator, as the phone's components/Sentence.tsx does:
 *
 *   <Sentence text={t('Sold to {who}')} parts={{ who: <span className="font-bold">{name}</span> }} />
 *
 * (t() with no values leaves `{who}` in place, in every language and in the pseudo-locale.)
 * Each `{name}` in the text is replaced by its element, wherever the language put it; a placeholder with no element is
 * left as written. Gluing pieces together instead (`t('Sold to') + name`) breaks in any language whose word order
 * differs and in right-to-left text, and words:check refuses it (design §2.5 rule 1).
 */

import { Fragment, type ReactNode } from 'react';

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

export function Sentence({ text, parts }: { text: string; parts: Record<string, ReactNode> }) {
    return (
        <>
            {sentenceParts(text, Object.keys(parts)).map((piece, i) => (
                typeof piece === 'string' ? <Fragment key={i}>{piece}</Fragment> : <Fragment key={i}>{parts[piece.name]}</Fragment>
            ))}
        </>
    );
}
