import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useWords } from '../LanguageProvider';
import { findLineWords } from '../find-community-lines';
import type { WaitingLine } from '../../utils/waiting-to-join';

/** The welcome screen's styles these are drawn with (app/welcome.tsx makeStyles), so the waiting mode matches the screen. */
export interface WaitingToJoinStyles {
    homeDoors: object;
    card: object;
    memberBtn: object;
    memberBtnText: object;
    secondaryBtn: object;
    secondaryBtnText: object;
    doorLine: object;
}

/**
 * Welcome's waiting mode (DESIGN-account-without-global-fable.md §2.4 and §4, slice S3): a phone whose account is a member
 * nowhere yet (utils/waiting-to-join.ts), most often after asking a community from a phone with no account. Drawn from
 * the top, under the title, where the two doors are on a phone with no account.
 *
 * One line per community asked ({@link WaitingLine}): "Waiting for ‹name›: usually a few days.", a yes with its one-tap
 * Join, a request no longer open with Got it, or what got in the way. Then Check again (while anything was asked), Ask
 * another community (Find a community, by address or code), and Join with an invite, which joins with this same key.
 * With nothing asked (a wipe that kept the key, say) one line says the account is here and in no community yet, and the
 * same ways in follow. Restore stays below, as on the first screen.
 *
 * Every line wraps at 320 dp with text at 1.3×; the buttons' words wrap too (never shrunk), and every button is 48 dp or more.
 */
export function WaitingToJoin({ lines, checking, joining, onCheckAgain, onJoin, onGotIt, onAskAnother, onJoinWithInvite, styles, accent }: {
    lines: readonly WaitingLine[];
    checking: boolean;
    /** The community whose yes is being joined, if any: every other button waits. */
    joining: string | null;
    onCheckAgain(): void;
    onJoin(line: Extract<WaitingLine, { kind: 'invited' }>): void;
    onGotIt(line: WaitingLine): void;
    onAskAnother(): void;
    onJoinWithInvite(): void;
    styles: WaitingToJoinStyles;
    accent: string;
}) {
    const { t } = useWords();
    const busy = !!joining;
    return (
        <View style={styles.homeDoors} testID="welcome-waiting">
            <View style={[styles.card, { padding: 16, marginBottom: 16 }]}>
                {lines.length === 0 ? (
                    <Text style={[styles.doorLine, { marginBottom: 0 }]} testID="welcome-waiting-none">
                        {t('Your account is on this phone. No community has let it in yet.')}
                    </Text>
                ) : lines.map((line, i) => (
                    <View key={line.url} style={i > 0 ? { marginTop: 14 } : undefined} testID={`welcome-waiting-${line.kind}`}>
                        {(line.kind === 'closed' || line.kind === 'trouble') && (
                            <Text style={[styles.doorLine, { fontWeight: '700', marginBottom: 2 }]}>{line.name}</Text>
                        )}
                        <Text style={[styles.doorLine, { marginBottom: 0 }]} accessibilityLiveRegion="polite">
                            {line.kind === 'waiting' || line.kind === 'invited' ? line.text : findLineWords(line.note)}
                        </Text>
                        {line.kind === 'invited' && (
                            <Pressable
                                style={[styles.memberBtn, { marginTop: 10, marginBottom: 0 }, busy && { opacity: 0.6 }]}
                                onPress={() => onJoin(line)}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Join {name}', { name: line.name })}
                                accessibilityState={{ busy: joining === line.url, disabled: busy }}
                                testID="welcome-waiting-join"
                            >
                                <Text style={styles.memberBtnText}>{joining === line.url ? t('Joining…') : t('Join {name}', { name: line.name })}</Text>
                            </Pressable>
                        )}
                        {line.kind === 'closed' && (
                            <Pressable
                                style={[styles.secondaryBtn, { marginTop: 10, minHeight: 48 }]}
                                onPress={() => onGotIt(line)}
                                disabled={busy}
                                accessibilityRole="button"
                                testID="welcome-waiting-got-it"
                            >
                                <Text style={styles.secondaryBtnText}>{t('Got it')}</Text>
                            </Pressable>
                        )}
                    </View>
                ))}
            </View>

            {lines.length > 0 && (
                <Pressable
                    style={[styles.memberBtn, (checking || busy) && { opacity: 0.6 }]}
                    onPress={onCheckAgain}
                    disabled={checking || busy}
                    accessibilityRole="button"
                    accessibilityState={{ busy: checking, disabled: checking || busy }}
                    testID="welcome-waiting-check"
                >
                    {checking ? <ActivityIndicator color={accent} /> : <Text style={styles.memberBtnText}>{t('Check again')}</Text>}
                </Pressable>
            )}
            <Pressable style={[styles.secondaryBtn, { marginBottom: 12, minHeight: 48 }]} onPress={onAskAnother} disabled={busy} accessibilityRole="button" testID="welcome-waiting-ask">
                <Text style={styles.secondaryBtnText}>{lines.length > 0 ? t('Ask another community') : t('Ask a community to let you in')}</Text>
            </Pressable>
            <Pressable style={[styles.secondaryBtn, { minHeight: 48 }]} onPress={onJoinWithInvite} disabled={busy} accessibilityRole="button" testID="welcome-waiting-invite">
                <Text style={styles.secondaryBtnText}>{t('🎟️ Join with an invite')}</Text>
            </Pressable>
        </View>
    );
}
