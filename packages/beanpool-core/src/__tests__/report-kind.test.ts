// report-kind.ts: the one rule the server sorts and alerts on and the phone asks when it leaves a report's words out
// (#1938 confirmation 10, finding 1). The server's own checks are apps/server/src/test-alerts-reports.ts (4. and 12.).
import { describe, it, expect } from 'vitest';
import { CHILD_SAFETY_REASON, pickedChildSafety, reportKind } from '../report-kind';

describe('reportKind', () => {
    it('picked Child safety, by its prefix, never its words', () => {
        expect(CHILD_SAFETY_REASON).toBe('Child safety');
        expect(pickedChildSafety(' child safety: he keeps messaging my daughter ')).toBe(true);
        expect(pickedChildSafety('Other: child safety')).toBe(false);
        expect(pickedChildSafety('Child safety gates for sale')).toBe(false);
        expect(pickedChildSafety(42)).toBe(false);
    });

    it('child safety written in under any other reason; the fixed choices; other', () => {
        expect(reportKind('Child safety: anything')).toBe('child safety');
        expect(reportKind('Other: child sexual abuse')).toBe('child safety');
        expect(reportKind('Offensive content: he is grooming a child, sexual abuse of a minor')).toBe('child safety');
        expect(reportKind('Spam or scam: fake child safety gates for sale')).toBe('child safety');
        expect(reportKind('Offensive content: shouted at the market')).toBe('offensive content');
        expect(reportKind('Misleading post: wrong price')).toBe('misleading post');
        expect(reportKind('Spam or scam')).toBe('spam or scam');
        expect(reportKind('He was rude')).toBe('other');
        expect(reportKind(42)).toBe('other');
    });
});
