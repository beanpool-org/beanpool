/**
 * "Print or save your recovery kit", by the 12 words: asks first (the save warning, Cancel / Continue), then prints the
 * kit (lib/recovery-kit.ts). Optional, and never a success message: the print dialog is the answer.
 */
import { useState } from 'react';
import { KIT_WEB_FAILED_LINE, KIT_WEB_LABEL, KIT_WEB_WARNING, printRecoveryKit } from '../lib/recovery-kit';

const target = {
    width: '100%', minHeight: 44, padding: '0.6rem 0.75rem', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3,
} as const;

export function RecoveryKitButton({ words, print }: { words: readonly string[] | null | undefined; print?: (w: Window) => void }) {
    const [asking, setAsking] = useState(false);
    const [failed, setFailed] = useState(false);
    if (!words || words.length !== 12) return null;

    async function onContinue() {
        setAsking(false);
        setFailed((await printRecoveryKit(words!, print)) === 'failed');
    }

    return (
        <div data-testid="recovery-kit" style={{ marginBottom: '0.75rem' }}>
            {!asking ? (
                <button type="button" onClick={() => { setFailed(false); setAsking(true); }}
                    style={{ ...target, border: '1px solid #2563eb', background: 'transparent', color: '#2563eb' }}>
                    <span aria-hidden="true">🖨️ </span>{KIT_WEB_LABEL}
                </button>
            ) : (
                <div role="group" aria-label={KIT_WEB_LABEL}>
                    <p style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>{KIT_WEB_WARNING}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" onClick={() => setAsking(false)}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: '1px solid var(--text-muted, #888)', background: 'transparent', color: 'inherit' }}>
                            Cancel
                        </button>
                        <button type="button" onClick={onContinue}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: 'none', background: '#2563eb', color: '#fff' }}>
                            Continue
                        </button>
                    </div>
                </div>
            )}
            {failed && <p role="alert" style={{ color: '#ef4444', fontSize: '0.8rem', lineHeight: 1.5, margin: '0.5rem 0 0' }}>{KIT_WEB_FAILED_LINE}</p>}
        </div>
    );
}
