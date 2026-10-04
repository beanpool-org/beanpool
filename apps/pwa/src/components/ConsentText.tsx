/**
 * A known community's consent text, readable on a small screen (rehearsal 5 Oct, d1): the summary, then "Read all of
 * it" for the rest, the trades an admin can see one per line. Not a word changed: lib/known-consent.ts consentTextParts
 * splits the node's text where it already breaks, and joined the parts are the text again. The phone has the same
 * (apps/native/components/ConsentText.tsx).
 */
import { consentTextParts } from '../lib/known-consent';

export function ConsentText({ text, fontSize }: { text: string; fontSize: string }) {
    const { summary, rest } = consentTextParts(text);
    const p = { fontSize, lineHeight: 1.45, margin: '0 0 0.5rem' } as const;
    return (
        <div>
            <p style={p}>{summary}</p>
            {rest.length > 0 && (
                <details style={{ margin: '0 0 0.5rem' }}>
                    <summary style={{ fontSize, fontWeight: 700, cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Read all of it</summary>
                    {rest.map((b, i) => b.item
                        ? <ul key={i} style={{ ...p, paddingLeft: '1.25rem' }}><li>{b.text}</li></ul>
                        : <p key={i} style={p}>{b.text}</p>)}
                </details>
            )}
        </div>
    );
}
