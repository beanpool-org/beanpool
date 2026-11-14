/**
 * The words of writing Local knowledge, one table for both apps (slice K4; DESIGN-local-knowledge-fable.md §3.3 and §3.4, as
 * amended §3.1, §3.3, §3.4): Learn's button and its "waiting" line, the form, what it says after sending, and My suggestions.
 * English is the key, the design's own sentences; each app shows them through t() (tn() for `waiting`) where it draws them, so
 * the phone and the web say the same thing in the same order. The checking screens' words (To check) come with K4's second part.
 *
 * Pure and universal: words only.
 */
import { word, wordn } from './words.js';

export const KNOWLEDGE_WRITE_WORDS = Object.freeze({
    /** Learn's button, fixed at the bottom: a member's, and an owner's or admin's (theirs publishes at once). */
    suggest: word('＋ Suggest knowledge'),
    add: word('＋ Add local knowledge'),
    /** The same door in Learn's empty search, plain. */
    suggestPlain: word('Suggest knowledge'),
    /** Learn's line for a member with something waiting, to My suggestions. */
    waiting: wordn('{n} of yours is waiting for an admin ›', '{n} of yours are waiting for an admin ›'),
    formBox: word('Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.'),
    titleLabel: word('TITLE *'),
    titleHint: word('e.g. How recycling works at the tip'),
    bodyLabel: word('WHAT TO KNOW *'),
    bodyHint: word('Put the answer first. Then the details.'),
    /** The count under "What to know": "120 / 3,000". */
    counter: word('{n} / {max}'),
    topicLabel: word('TOPIC *'),
    placeLabel: word('WHERE (OPTIONAL)'),
    placeHint: word('e.g. The tip on Manse Road'),
    sourcesLabel: word('WHERE CAN PEOPLE CHECK THIS? (OPTIONAL)'),
    addLink: word('Add a link'),
    linkLabelHint: word('What is this page? (optional)'),
    removeLink: word('Remove this link'),
    photoLabel: word('PHOTO (OPTIONAL)'),
    addPhoto: word('📷 Add a photo'),
    photoLine: word('Your own photo. Without one, a picture for the topic is shown.'),
    removePhoto: word('Remove photo'),
    send: word('Send to the admins'),
    publish: word('Publish'),
    sendLine: word('An owner or admin checks it before anyone sees it.'),
    publishLine: word('It goes into Learn, and the Pulse announces it.'),
    sentTitle: word('Sent'),
    sentLine: word('An owner or admin will check it. You’ll hear back here.'),
    publishedTitle: word('Published'),
    publishedLine: word('It’s in Learn.'),
    openLearn: word('Open Learn'),
    done: word('Done'),
    /** The form's own refusals before it sends (the node says the same words for the same faults). */
    noTitle: word('Give it a title.'),
    noBody: word('Write what people should know.'),
    noTopic: word('Pick a topic.'),
    badLink: word('A link must start with https:// or http://'),
    couldNotSend: word('Couldn’t send it. Check your connection and try again.'),
    mineTitle: word('My suggestions'),
    unreachable: word('Couldn’t reach your community. Try again in a moment.'),
    kindNew: word('New', 'My suggestions: a suggested new page of Local knowledge, not a fix'),
    kindFix: word('Fix', 'My suggestions: a suggested fix to a page of Local knowledge'),
    /** A row's second line: "New · Waiting since 3 Nov". */
    kindStatus: word('{kind} · {status}'),
    waitingSince: word('Waiting since {date}'),
    takeBack: word('Take it back'),
    takeBackAsk: word('Take this back? The admins won’t see it.'),
    keep: word('Keep it'),
    added: word('Added'),
    notAdded: word('Not added: {reason}'),
});
