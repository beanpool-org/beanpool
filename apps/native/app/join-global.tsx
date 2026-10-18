/**
 * The global community's door by the name every way to it already uses (the BeanPool sheet's row, Settings → Advanced,
 * People's guest banner, the not-recognised screen, the pairing screen's refusal, the global link): the door screen for
 * any open-door community (app/join-open-door.tsx, slice P5), with no `node`, so it is the global community's. Its params
 * (`then`, `from=link`) mean the same there. A link that gives it a `node` is the door link (utils/open-door.ts
 * doorLinkFromSystemPath), and another community's door that the member's Join didn't open holds its work for their tap.
 */
export { default, ErrorBoundary } from './join-open-door';
