/**
 * A refusal the apps read by the code before its sentence: `UNAUTHORIZED: Only a group convenor can …`, a 403 the phone and
 * the web take the code off and show the rest of. The sentence is marked with word() where it is written, as the argument
 * here (inside a template literal it would be a fragment to words:check), and the server's way out translates it and
 * keeps the code (apps/server/src/member-words.ts); everything inside the server still reads the English. Several
 * sentences, each marked on its own, are said one after the other.
 */
export function unauthorized(...sentences: string[]): string {
    return `UNAUTHORIZED: ${sentences.join(' ')}`;
}
