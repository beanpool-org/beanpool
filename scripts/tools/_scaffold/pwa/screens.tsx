/**
 * The tool's web screens, the same as the phone's. The host's covered page draws the frame around each and, while the
 * document is empty, the two doors; a screen draws the rest with the host's primitives (../ui) and reaches the app only
 * through `host`. Every sentence through t() from @beanpool/core; what the member wrote is shown as written.
 */
import { t, type ScaffoldScreenProps } from '@beanpool/core';
import { ToolEmpty, ToolRow, ToolSection } from '../ui';

/** The tool's first screen: what it keeps, one row each (its manifest's own sentences, so it adds none). */
export function Main({ host }: ScaffoldScreenProps) {
    const doc = host.doc.get();
    if (doc.items.length === 0) return <ToolEmpty title={t('New tool')} line={t('One line on what this tool keeps for you.')} />;
    return (
        <ToolSection title={t('Kept here: {count}', { count: doc.items.length })}>
            {doc.items.map((item) => <ToolRow key={item.id} title={item.name} state={item.addedAt.slice(0, 10)} />)}
        </ToolSection>
    );
}

export const SCREENS = { main: Main };
