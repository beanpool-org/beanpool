/**
 * What a node sends the registrar as a label (community name, contact): PR #1410 review note 1. A character nobody can see
 * (Android's BidiFormatter isolates, a tab) must never keep a held name dark, so the node strips them and caps the length
 * to what the registrar accepts (apps/registrar/src/index.js labelProblem), before sending and when Settings saves.
 */
import { cleanLabel, REGISTRAR_COMMUNITY_NAME_MAX, REGISTRAR_CONTACT_MAX } from './config/clean-label.js';

let run = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    run++;
    if (!cond) { console.error(`✗ ${msg}`, detail ?? ''); process.exit(1); }
    console.log(`✓ ${msg}`);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(a === b, msg, a);

eq(cleanLabel('Byron Bay Exchange', 120), 'Byron Bay Exchange', 'a plain name is unchanged');
eq(cleanLabel('⁨مجتمع بايرون⁩', 120), 'مجتمع بايرون', 'BidiFormatter isolates are stripped, the Arabic kept');
eq(cleanLabel('Byron\tBay', 120), 'Byron Bay', 'a tab becomes a space');
eq(cleanLabel('A‮B C\u0007D\n', 120), 'AB CD', 'overrides, separators and bell go; a line break is a space');
eq(cleanLabel('  Ngurra  Bunya 共同体 🌱 ', 120), 'Ngurra Bunya 共同体 🌱', 'other scripts and emoji survive; spaces collapse and trim');
eq(cleanLabel('a‍b‌c', 120), 'a‍b‌c', 'zero-width joiners (Persian, emoji) are not touched');
eq([...(cleanLabel('🌱'.repeat(300), REGISTRAR_COMMUNITY_NAME_MAX) as string)].length, 120, 'cut to 120 characters, not UTF-16 units');
eq((cleanLabel('x'.repeat(400), REGISTRAR_CONTACT_MAX) as string).length, 254, 'contact cut to 254');
eq(cleanLabel('⁦⁩', 120), undefined, 'a label that is only invisible characters is nothing');
eq(cleanLabel(undefined, 120), undefined, 'undefined stays undefined');
eq(cleanLabel(12, 120), undefined, 'a non-string is nothing');
console.log(`\n✅ clean-label: ${run}/${run} passed`);
