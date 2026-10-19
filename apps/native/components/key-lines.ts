/**
 * The sentences the key, sign-in and recovery screens show that their lower layers write in English, shown in the
 * member's language (words S3, sweep B10).
 *
 * Code that handles keys, signatures, the 12 words or a backup never reaches the words layer (core
 * recovery-path-files.test.ts): utils/group-history-unlock.ts (the old 12 words, a new phone's keys), utils/owner-words.ts
 * (an owner's 12 words), utils/takeover-unlock.ts (a standby's locked keys), utils/settings-signin.ts (signs a computer
 * in), utils/rekey-redeem.ts (a re-key's new key), utils/node-claim.ts (signs a claim), utils/node-admin.ts (the phone's
 * lock before a signed admin request), utils/names-list.ts, names-debts.ts and names-invite.ts (the names list's keys and
 * signed requests), utils/delete-here.ts (signs the delete). The screens translate their sentences here: by the exact
 * English (the key IS the English), by the English with a name, an address or a number in it (FILLED: the sentence is
 * read back only when the reading is the one way to read it), or built again from the same values, word for word in
 * English. Nothing here imports those files' words: utils/__tests__/key-lines.test.ts holds every sentence to the
 * constant or builder it stands for, so a sentence changed there fails a test rather than quietly showing English.
 *
 * Anything else (a community's or a node's own words, a member's) is shown exactly as given, and so is a line this file
 * can't read back. The 12 words, codes and keys are never looked up: a code or a name is only put into a sentence.
 */
import { formatDate, t, tn, word, type WordKey } from '@beanpool/core';
import type { KeptCommunity } from '../utils/delete-here';
import type { OldWordsResult } from '../utils/group-history-unlock';
import type { ClaimOutcome } from '../utils/node-claim';
import type { AgentAsking, PairingLookup } from '../utils/settings-signin';
import { listNameWords, settingsLineWords } from './settings/settings-lines';

/** Whole sentences, by their English. */
const FIXED: Readonly<Record<string, WordKey>> = {
    // utils/group-history-unlock.ts: the old 12 words and a new phone's code.
    'I have my old phone or old 12 words': word('I have my old phone or old 12 words'),
    "These aren't the words of the key this account moved from.": word("These aren't the words of the key this account moved from."),
    "Your old words don't match the key this community says you moved from. Tell an owner.": word("Your old words don't match the key this community says you moved from. Tell an owner."),
    'Done. Your earlier messages are unlocked on this phone.': word('Done. Your earlier messages are unlocked on this phone.'),
    'Nothing was handed over: the community lists no earlier keys of yours that this phone lacks.': word('Nothing was handed over: the community lists no earlier keys of yours that this phone lacks.'),
    'Ask a member to confirm this phone': word('Ask a member to confirm this phone'),
    'Meet a member of your groups in person. They scan this code with "Confirm a member\'s new phone".': word('Meet a member of your groups in person. They scan this code with "Confirm a member\'s new phone".'),
    "Confirm a member's new phone": word("Confirm a member's new phone"),
    "This isn't a BeanPool new-phone code.": word("This isn't a BeanPool new-phone code."),
    // utils/owner-words.ts OWNER_WORDS_COPY: the "Check your 12 words" screen.
    'Check your 12 words': word('Check your 12 words'),
    "You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this phone, your 12 words are what get you back in — so check you still have the right ones.": word("You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this phone, your 12 words are what get you back in — so check you still have the right ones."),
    'Your words stay on this phone. They are never sent or saved.': word('Your words stay on this phone. They are never sent or saved.'),
    'These are the right words.': word('These are the right words.'),
    'These are the right words. Your community can see you checked them today.': word('These are the right words. Your community can see you checked them today.'),
    "These are the right words. We couldn't tell your community's server just now; check again later to record it.": word("These are the right words. We couldn't tell your community's server just now; check again later to record it."),
    "These aren't the words for this account.": word("These aren't the words for this account."),
    "Can't find them? If this phone still has them, Settings → View Recovery Phrase shows them.": word("Can't find them? If this phone still has them, Settings → View Recovery Phrase shows them."),
    "Can't find them? This phone has no copy of them to show you. When you find them, check them here, then save them on this phone.": word("Can't find them? This phone has no copy of them to show you. When you find them, check them here, then save them on this phone."),
    'This phone has no copy of your 12 words. Save them here and Settings → View Recovery Phrase shows them.': word('This phone has no copy of your 12 words. Save them here and Settings → View Recovery Phrase shows them.'),
    'Save them on this phone': word('Save them on this phone'),
    'Saving…': word('Saving…'),
    'Saved. Settings → View Recovery Phrase shows your 12 words on this phone now.': word('Saved. Settings → View Recovery Phrase shows your 12 words on this phone now.'),
    "They couldn't be saved on this phone. Nothing has changed. Settings → View Recovery Phrase lets you add them.": word("They couldn't be saved on this phone. Nothing has changed. Settings → View Recovery Phrase lets you add them."),
    // utils/node-admin.ts NO_DEVICE_LOCK_MESSAGE: no screen lock, so no signed admin request.
    "Managing or moderating a community opens its settings signed in as you, so BeanPool asks for your phone's own unlock first — fingerprint, face or PIN. This phone has no screen lock set, so anyone holding it could do the same. Set a screen lock in your phone’s settings, then try again.": word("Managing or moderating a community opens its settings signed in as you, so BeanPool asks for your phone's own unlock first — fingerprint, face or PIN. This phone has no screen lock set, so anyone holding it could do the same. Set a screen lock in your phone’s settings, then try again."),
    // utils/takeover-unlock.ts: a code it can't read, and why the phone won't open the keys.
    'Not a safe address': word('Not a safe address'),
    "Can't read that code": word("Can't read that code"),
    'It looks like a take-over code but part of it is missing. Start again on the server and scan the new code.': word('It looks like a take-over code but part of it is missing. Start again on the server and scan the new code.'),
    'Not a take-over code': word('Not a take-over code'),
    "That isn't a BeanPool code for taking over or restoring. On the server's Settings, choose “Take over with an owner's phone” or restore a backup with a phone.": word("That isn't a BeanPool code for taking over or restoring. On the server's Settings, choose “Take over with an owner's phone” or restore a backup with a phone."),
    'These keys belong to another community, not the one this app is in. Nothing was opened.': word('These keys belong to another community, not the one this app is in. Nothing was opened.'),
    'That code is for a different kind of unlock than the server sent. Start again on the server.': word('That code is for a different kind of unlock than the server sent. Start again on the server.'),
    'That code has run out or was already used. Start again on the server and scan the new code.': word('That code has run out or was already used. Start again on the server and scan the new code.'),
    "The server's answer could not be read. Start again on the server.": word("The server's answer could not be read. Start again on the server."),
    "This phone's key did not open its part of the lock. Try another owner, or the recovery code.": word("This phone's key did not open its part of the lock. Try another owner, or the recovery code."),
    'Too many attempts. Wait a minute and try again.': word('Too many attempts. Wait a minute and try again.'),
    // utils/settings-signin.ts: a code it can't read, the node's answers, the sheet's question and warnings.
    'A different community': word('A different community'),
    'Not connected': word('Not connected'),
    'Connect to your community first.': word('Connect to your community first.'),
    'It looks like a sign-in code but part of it is missing. Get a new code on the computer and scan again.': word('It looks like a sign-in code but part of it is missing. Get a new code on the computer and scan again.'),
    'Not a sign-in code': word('Not a sign-in code'),
    "That isn't a BeanPool Settings sign-in code. On the computer, open your community's Settings and choose “Sign in with your phone”.": word("That isn't a BeanPool Settings sign-in code. On the computer, open your community's Settings and choose “Sign in with your phone”."),
    "The code on the computer doesn't match this QR. Get a new code on the computer and scan again.": word("The code on the computer doesn't match this QR. Get a new code on the computer and scan again."),
    'Could not reach the node.': word('Could not reach the node.'),
    'The node refused the sign-in.': word('The node refused the sign-in.'),
    'Did you just open Settings on a computer?': word('Did you just open Settings on a computer?'),
    'If someone sent you this code, tap No.': word('If someone sent you this code, tap No.'),
    'Did you just add this community to an AI assistant?': word('Did you just add this community to an AI assistant?'),
    "If someone sent you this code, or you don't know where it sends, tap No.": word("If someone sent you this code, or you don't know where it sends, tap No."),
    'Never read them out or send them to anyone: type them yourself, on the computer you just opened.': word('Never read them out or send them to anyone: type them yourself, on the computer you just opened.'),
    // utils/rekey-redeem.ts REKEY_TEXT and its refusals before anything is sent.
    'Your admin said this phone isn’t yours, so nothing changed. Ask them to try again with you there.': word('Your admin said this phone isn’t yours, so nothing changed. Ask them to try again with you there.'),
    'That code isn’t valid any more. Ask the admin for a new one.': word('That code isn’t valid any more. Ask the admin for a new one.'),
    'That code is for another community. Check the community’s name or address and try again.': word('That code is for another community. Check the community’s name or address and try again.'),
    'Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.': word('Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.'),
    'This phone’s account changed while you waited, so nothing was saved. Start again.': word('This phone’s account changed while you waited, so nothing was saved. Start again.'),
    'That isn’t a whole re-key code. It starts RK- and has eight letters and numbers.': word('That isn’t a whole re-key code. It starts RK- and has eight letters and numbers.'),
    'That isn’t a community address the app can use.': word('That isn’t a community address the app can use.'),
    // utils/node-claim.ts: the server's status, and why a claim didn't go through.
    'That is not a community address the app can use.': word('That is not a community address the app can use.'),
    'Could not reach the server.': word('Could not reach the server.'),
    "That address doesn't answer like a BeanPool server.": word("That address doesn't answer like a BeanPool server."),
    "That code isn't right. Read it again on the server: docker compose exec beanpool-node cat /data/claim-code.txt": word("That code isn't right. Read it again on the server: docker compose exec beanpool-node cat /data/claim-code.txt"),
    'The server made a new code; read it again.': word('The server made a new code; read it again.'),
    'This server has no claim code. Restart it to make one, then read the new code.': word('This server has no claim code. Restart it to make one, then read the new code.'),
    'Your phone reached a different server than this address names. Check the address.': word('Your phone reached a different server than this address names. Check the address.'),
    'Too many tries from this network. Wait a little and try again.': word('Too many tries from this network. Wait a little and try again.'),
    "We couldn't confirm the claim yet. It may have worked. Check again in a minute, or from another network (Wi-Fi or mobile data).": word("We couldn't confirm the claim yet. It may have worked. Check again in a minute, or from another network (Wi-Fi or mobile data)."),
    "The claim didn't reach the server. Try again.": word("The claim didn't reach the server. Try again."),
    'The claim could not be made.': word('The claim could not be made.'),
    // utils/delete-here.ts: deleting the account from this phone, from the not-recognised screen.
    "No other community saved on this phone has you as a member. This still erases the key for every community, including any this phone doesn't list.": word("No other community saved on this phone has you as a member. This still erases the key for every community, including any this phone doesn't list."),
    'To take BeanPool off this phone altogether, switch, then use Settings → Account Deletion & Sign Out → Sign Out (Device Only).': word('To take BeanPool off this phone altogether, switch, then use Settings → Account Deletion & Sign Out → Sign Out (Device Only).'),
    // utils/names-list.ts NAMES_COPY: the names list's own lines and buttons (the ones with no name or number in them).
    'Couldn’t reach the server for your names-list record. Nothing was changed. Try again.': word('Couldn’t reach the server for your names-list record. Nothing was changed. Try again.'),
    'The copy of your names-list record on the server didn’t check out: it wasn’t saved by this account, or it was changed. Nothing was read.': word('The copy of your names-list record on the server didn’t check out: it wasn’t saved by this account, or it was changed. Nothing was read.'),
    'Your names-list record is too big to keep a copy on the server. Keep this phone signed in, or save the names as a PDF.': word('Your names-list record is too big to keep a copy on the server. Keep this phone signed in, or save the names as a PDF.'),
    'The server didn’t keep a copy of your names-list record just now, so no keys were sent. The next open tries again.': word('The server didn’t keep a copy of your names-list record just now, so no keys were sent. The next open tries again.'),
    'Another phone signed in as you saved the names list’s record. Use one phone.': word('Another phone signed in as you saved the names list’s record. Use one phone.'),
    'Start afresh on this phone': word('Start afresh on this phone'),
    'Only this community’s owners and admins can read these names, on their own phones.': word('Only this community’s owners and admins can read these names, on their own phones.'),
    'Only this community’s owners and admins can read these names, on their own phones. The server keeps them scrambled: a backup, a copy or a stolen database holds nothing readable. This phone gives the list’s keys only to admins whose phones were checked, on a call or in person, by you or by an admin you trust, and takes a new key only from them. What it can’t protect: a check made with the wrong person, a phone someone else gets into, a lost phone until an admin removes its key, and an admin’s phone that the server keeps from learning of a removal: what that phone writes until it learns, the removed admin’s keys can read. Each admin’s phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, look at this phone’s admins: if it still shows them, tap Remove @X’s old key. Whatever the server says, this phone then makes a key without them or writes nothing.': word('Only this community’s owners and admins can read these names, on their own phones. The server keeps them scrambled: a backup, a copy or a stolen database holds nothing readable. This phone gives the list’s keys only to admins whose phones were checked, on a call or in person, by you or by an admin you trust, and takes a new key only from them. What it can’t protect: a check made with the wrong person, a phone someone else gets into, a lost phone until an admin removes its key, and an admin’s phone that the server keeps from learning of a removal: what that phone writes until it learns, the removed admin’s keys can read. Each admin’s phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, look at this phone’s admins: if it still shows them, tap Remove @X’s old key. Whatever the server says, this phone then makes a key without them or writes nothing.'),
    'More about who can read them': word('More about who can read them'),
    'Less': word('Less'),
    'When you check each other, compare this line too. If it differs, open the list again on both phones. If it still differs, the server is showing your phones different things: add no names until it matches, and tell your admins.': word('When you check each other, compare this line too. If it differs, open the list again on both phones. If it still differs, the server is showing your phones different things: add no names until it matches, and tell your admins.'),
    'The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds, and before it writes again it makes a new key without any admin it had removed.': word('The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds, and before it writes again it makes a new key without any admin it had removed.'),
    'The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds.': word('The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds.'),
    'Nobody this phone trusts holds the list’s keys. Check codes with an admin who does, on a call or in person.': word('Nobody this phone trusts holds the list’s keys. Check codes with an admin who does, on a call or in person.'),
    'The server says this list belongs to a different community from the one this phone opened before. Nothing was read or written.': word('The server says this list belongs to a different community from the one this phone opened before. Nothing was read or written.'),
    'The server is missing part of the list’s key history, so this phone can’t check the newest key. Nothing was read or written. Ask whoever runs the server, or an admin.': word('The server is missing part of the list’s key history, so this phone can’t check the newest key. Nothing was read or written. Ask whoever runs the server, or an admin.'),
    'The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Check codes with an admin who does, on a call or in person.': word('The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Check codes with an admin who does, on a call or in person.'),
    'The server sent more of the list’s history than this phone reads. Ask whoever runs the server.': word('The server sent more of the list’s history than this phone reads. Ask whoever runs the server.'),
    'This phone can’t write to the list right now. Open it again.': word('This phone can’t write to the list right now. Open it again.'),
    'Opening the list again…': word('Opening the list again…'),
    'Open the list again': word('Open the list again'),
    'Members don’t see these names. Showing real names to members isn’t available yet.': word('Members don’t see these names. Showing real names to members isn’t available yet.'),
    'Check each other': word('Check each other'),
    'Check an admin’s code': word('Check an admin’s code'),
    'Put the key history back': word('Put the key history back'),
    'Put the key history back?': word('Put the key history back?'),
    'Start again': word('Start again'),
    'Start the list again?': word('Start the list again?'),
    'Make a new key': word('Make a new key'),
    'Make a new key?': word('Make a new key?'),
    'Follow the server’s history': word('Follow the server’s history'),
    'Follow the server’s history?': word('Follow the server’s history?'),
    'This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to them.': word('This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to them.'),
    'This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to them. An admin this phone had removed stays removed: before it writes, it makes a key without them.': word('This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to them. An admin this phone had removed stays removed: before it writes, it makes a key without them.'),
    'Your phone’s key': word('Your phone’s key'),
    'On a call, read these 20 digits out for the other admin to type in. If you’re together, they can scan the QR code instead.': word('On a call, read these 20 digits out for the other admin to type in. If you’re together, they can scan the QR code instead.'),
    'Show my phone’s key': word('Show my phone’s key'),
    'Hide my phone’s key': word('Hide my phone’s key'),
    'Scan their QR code': word('Scan their QR code'),
    'Stop scanning': word('Stop scanning'),
    'To scan their code, allow the camera. You can type the code instead.': word('To scan their code, allow the camera. You can type the code instead.'),
    'THEIR CODE (20 DIGITS)': word('THEIR CODE (20 DIGITS)'),
    'Compare': word('Compare'),
    'That isn’t a phone key code. Scan the QR code on their names list, or type the 20 digits shown under it.': word('That isn’t a phone key code. Scan the QR code on their names list, or type the 20 digits shown under it.'),
    'Those digits aren’t the key of any admin the server lists. Scan their QR code instead, on a video call or together.': word('Those digits aren’t the key of any admin the server lists. Scan their QR code instead, on a video call or together.'),
    'That is this phone’s own key.': word('That is this phone’s own key.'),
    'This phone couldn’t read or save its names list keys just now, so nothing was checked and nothing was changed. Try again.': word('This phone couldn’t read or save its names list keys just now, so nothing was checked and nothing was changed. Try again.'),
    'Export the list as a PDF?': word('Export the list as a PDF?'),
    'The PDF holds every name you can open here. Once it leaves this phone it’s yours to keep safe, like a paper list. The other admins can see that you exported it, and when.': word('The PDF holds every name you can open here. Once it leaves this phone it’s yours to keep safe, like a paper list. The other admins can see that you exported it, and when.'),
    'A member is confirmed against this entry. Revoke the confirmation first.': word('A member is confirmed against this entry. Revoke the confirmation first.'),
    'Revoke this confirmation?': word('Revoke this confirmation?'),
    'Two admins confirm each member': word('Two admins confirm each member'),
    'A confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. Where nobody else could (an admin confirmed in a community of two admins), one admin is enough.': word('A confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. Where nobody else could (an admin confirmed in a community of two admins), one admin is enough.'),
    // utils/names-debts.ts DEBT_COPY: the titles and buttons (the sentences with an amount in them stay as written).
    'Confirm them to work it off?': word('Confirm them to work it off?'),
    'Confirm to work it off': word('Confirm to work it off'),
    'Count a payment made without the code?': word('Count a payment made without the code?'),
    'Count it': word('Count it'),
    'Ask the community to forgive it?': word('Ask the community to forgive it?'),
    'Start the Decision': word('Start the Decision'),
    'This name has an open debt': word('This name has an open debt'),
    'Add anyway': word('Add anyway'),
    // utils/community-health.ts HEALTH_COPY: the totals' heading and why they're missing.
    'THE WHOLE COMMUNITY': word('THE WHOLE COMMUNITY'),
    'Any member may know these. Nobody’s own balance or trades are in them.': word('Any member may know these. Nobody’s own balance or trades are in them.'),
    'The totals couldn’t be read just now.': word('The totals couldn’t be read just now.'),
    'This community’s server doesn’t give these totals yet: it needs an update.': word('This community’s server doesn’t give these totals yet: it needs an update.'),
};

/** Placeholders read back as a number (and given to t() as one, so the language writes its digits). */
const NUMBER_PLACES = new Set(['n', 'm', 'count', 'seconds', 'hours']);
/** Placeholders read back as one unbroken token: a status, a code, an address. */
const TOKEN_PLACES = new Set(['status', 'code', 'host', 'other_host']);
/** What a lower layer writes when it has no name: read back inside a sentence, it would be English in another language. */
const NO_NAME = new Set(['an admin', 'this person', 'the entry', 'this entry', 'this community', 'your community', 'This sign-in', 'Your sign-in']);

/**
 * Sentences with a name, an address or a number in them, as the lower layer writes them, `{placeholder}` for each
 * (a placeholder used twice must read the same both times). A sentence is read back only when that reading is the
 * only one (a name that holds the sentence's own words could be read two ways: then it is shown as it came).
 */
const FILLED: readonly WordKey[] = [
    // utils/group-history-unlock.ts.
    word("The node didn't hand over your earlier keys for {name}."),
    word("This isn't the phone the community lists for {name}."),
    word("This phone's record of {name}'s old key doesn't match what the community says. Don't continue; tell an owner."),
    word("This phone never knew {name}'s old key. A longer-standing member's phone can confirm them."),
    word("This phone knew that key as {other}, not {name}. Don't continue; tell an owner."),
    // utils/takeover-unlock.ts.
    word("That code points at {host} without https. Open the server's Settings at its https address and try again."),
    word("These keys are not locked to you, so this phone can't open them. Another owner of your community can, or the printed recovery code on {host}."),
    word("These take-over keys were not locked by your community's server, so this phone will not open them for {host}."),
    word('{host} sent keys that do not match its screen, or that have been altered. Nothing was opened. Start again on the server.'),
    word('{host} did not answer ({status}).'),
    word('Could not reach {host}.'),
    // utils/settings-signin.ts.
    word('That code is for {host}, but this app is signed in to {other_host}. You can only sign in to the Settings of the community this app belongs to.'),
    word('The node did not answer ({status}).'),
    word("You are not an owner, admin or moderator of {name}, so you can't open its Settings."),
    // utils/rekey-redeem.ts RekeyHeldError: an earlier re-key this phone still holds.
    word('Your re-key at {where} went through, but this phone holds another account now, and a phone holds only one. Forget that re-key to go on: your account at {where} then needs a new code from an admin there.'),
    word('This phone showed a number for a re-key at {where}, and {where} isn’t answering. Try again later, or forget that re-key.'),
    word('The re-key you started at {where} with {code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself within the hour.'),
    // utils/node-claim.ts.
    word('Someone already owns {name}.'),
    word('The server did not answer ({status}).'),
    word('The server refused the claim ({status}).'),
    // utils/names-list.ts NAMES_COPY: one admin by their @name, or a key by its number.
    word('Check {who}’s code'),
    word('Remove {who}’s old key'),
    word('Remove {who}’s old key?'),
    word('Remove {who}’s old key? The list gets a new key that {who}’s old phone can’t read. If {who} gets a new phone, check its code and this phone will send the keys.'),
    word('Send the keys to {who} again'),
    word('{who} is an admin, and this phone hasn’t checked their phone. Check codes with them, on a call or in person: then this phone sends them the keys.'),
    word('Check {who}’s code. Open the names list on both phones, and check each other’s code: read the 20 digits out on a call and type them in, or scan the QR code if you’re together. Only do this when you know it’s {who} you’re talking to: your phone will trust this key, send it the names, and take new keys it makes.'),
    word('Those digits aren’t {who}’s key as the server lists it. Nothing was trusted. Scan their QR code instead, on a video call or together, and tell your other admins.'),
    word('The key you scanned isn’t the one the server lists for {who}. Your phone trusts the key you scanned and nothing is sent to the server’s key. Either the server has put {who}’s name on another key, or this isn’t {who}’s phone. Tell your other admins.'),
    word('Checked: this phone now trusts {who}’s phone.'),
    word('The server offers an older key history (up to key {n}) than this phone has (key {m}). A server put back to an older copy does that. Nothing was read or written. You can put the key history back from this phone; entries written since the copy are gone and must be typed again from your paper copy.'),
];

/**
 * The same, for a sentence with a count in it: `english` is how the lower layer writes it for that count (with {n}),
 * `words` says it with tn().
 */
const COUNTED: ReadonlyArray<{ english: string; words: (values: Record<string, string | number>) => string }> = [
    // utils/rekey-redeem.ts RekeyHeldError, letsGoIn: more than an hour left (an hour or less is "within the hour", above).
    {
        english: 'The re-key you started at {where} with {code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself in about {n} hours.',
        words: ({ n, ...values }) => tn(Number(n),
            'The re-key you started at {where} with {code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself in about {n} hour.',
            'The re-key you started at {where} with {code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself in about {n} hours.',
            values),
    },
];

interface Filled { key: string; names: string[]; greedy: RegExp; lazy: RegExp }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileFilled(key: string): Filled {
    const names: string[] = [];
    let greedy = '^';
    let lazy = '^';
    let last = 0;
    for (const m of key.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
        const text = escapeRe(key.slice(last, m.index));
        greedy += text;
        lazy += text;
        const seen = names.indexOf(m[1]);
        if (seen >= 0) {
            greedy += `\\${seen + 1}`;
            lazy += `\\${seen + 1}`;
        } else {
            names.push(m[1]);
            const one = NUMBER_PLACES.has(m[1]) ? '(\\d+)' : TOKEN_PLACES.has(m[1]) ? '(\\S+)' : null;
            greedy += one ?? '(.+)';
            lazy += one ?? '(.+?)';
        }
        last = (m.index ?? 0) + m[0].length;
    }
    const rest = escapeRe(key.slice(last));
    return { key, names, greedy: new RegExp(`${greedy}${rest}$`, 's'), lazy: new RegExp(`${lazy}${rest}$`, 's') };
}

let compiled: Filled[] | null = null;
let compiledCounted: Array<Filled & { words: (values: Record<string, string | number>) => string }> | null = null;

/** A FILLED sentence read back: its values, or null when it isn't this sentence or could be read more than one way. */
function readBack(f: Filled, english: string): Record<string, string | number> | null {
    const a = english.match(f.greedy);
    if (!a) return null;
    const b = english.match(f.lazy);
    if (!b || a.some((v, i) => v !== b[i])) return null;
    const values: Record<string, string | number> = {};
    for (const [i, name] of f.names.entries()) {
        const v = a[i + 1];
        if (NO_NAME.has(v)) return null;
        values[name] = NUMBER_PLACES.has(name) ? Number(v) : v;
    }
    return values;
}

/** The whole sentences this file knows by their English (its test holds each to the file that writes it). */
export function knownKeyLines(): string[] {
    return Object.keys(FIXED);
}

/**
 * One of the sentences above in the member's language; then Settings' (settings-lines.ts: the vault's, the delete's, the
 * names list's sign-out lines); anything else (a node's or a community's own words, a member's) exactly as given.
 */
export function keyLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(FIXED, english)) return t(FIXED[english]);
    compiled ??= FILLED.map(compileFilled);
    for (const f of compiled) {
        const values = readBack(f, english);
        if (values) return t(f.key as WordKey, values);
    }
    compiledCounted ??= COUNTED.map((c) => ({ ...compileFilled(c.english), words: c.words }));
    for (const f of compiledCounted) {
        const values = readBack(f, english);
        if (values) return f.words(values);
    }
    return settingsLineWords(english);
}

// ── The old 12 words and a new phone's code: utils/group-history-unlock.ts, built again from the same values ──────────

/** oldWordsProgressText: "Unlocking 1 of 3 groups…". */
export function oldWordsProgressWords(done: number, total: number): string {
    return tn(total, 'Unlocking {done} of {n} group…', 'Unlocking {done} of {n} groups…', { done });
}

/** oldWordsEnd: "Done" only when some group's keys landed; the groups the node withheld are named. */
export function oldWordsEndWords(r: OldWordsResult): { text: string; lines: string[]; ok: boolean } {
    if (r.outcome === 'not_the_key') return { text: t("These aren't the words of the key this account moved from."), lines: [], ok: false };
    if (r.outcome === 'owner') return { text: t("Your old words don't match the key this community says you moved from. Tell an owner."), lines: [], ok: false };
    if (Object.values(r.unlocked).some((n) => n > 0)) {
        return { text: t('Done. Your earlier messages are unlocked on this phone.'), lines: r.withheld.map((g) => t("The node didn't hand over your earlier keys for {name}.", { name: g.name })), ok: true };
    }
    if (r.withheld.length > 0) {
        return { text: t('Nothing was handed over for {names}. Try again later, or tell an owner.', { names: listNameWords(r.withheld.map((g) => g.name)) }), lines: [], ok: false };
    }
    return { text: t('Nothing was handed over: the community lists no earlier keys of yours that this phone lacks.'), lines: [], ok: true };
}

/** newPhoneConfirmText: what confirming does, with the human limit in it. */
export function newPhoneConfirmWords(name: string, groups: readonly string[]): string {
    return tn(groups.length,
        "You're confirming this is {name}'s new phone. Their old key wrote in {n} group you share: {groups}. Only confirm if this phone is in {name}'s hands: whoever holds it can read those groups' earlier messages that you can.",
        "You're confirming this is {name}'s new phone. Their old key wrote in {n} groups you share: {groups}. Only confirm if this phone is in {name}'s hands: whoever holds it can read those groups' earlier messages that you can.",
        { name, groups: listNameWords(groups) });
}

/** newPhoneProgressText: "Unlocking 2 of 5…". */
export function newPhoneProgressWords(done: number, total: number): string {
    return t('Unlocking {done} of {total}…', { done, total });
}

/** newPhoneEnd: "Done" only when every planned key landed; the node's word said as its word; where a slow-down stopped it. */
export function newPhoneEndWords(name: string, r: { total: number; already?: number; listedHeld?: number; planned: number; stopped: boolean }): { text: string; ok: boolean } {
    const landed = r.total + (r.already ?? 0);
    const said = (r.already ?? 0) + (r.listedHeld ?? 0);
    if (r.stopped) {
        return { text: t('Unlocking {done} of {total}… The community asked this phone to slow down: scan again in a minute to carry on.', { done: landed, total: r.planned }), ok: true };
    }
    if (landed < r.planned) return { text: t('Handed {handed} of {planned}. The community refused the rest: try again, or tell an owner.', { handed: r.total, planned: r.planned }), ok: false };
    if (said > 0) {
        if (r.total > 0) return { text: t("Handed {handed}. The community says {name}'s new phone already holds the other {said}. If it can't read those messages, tell an owner.", { name, handed: r.total, said }), ok: true };
        return {
            text: tn(said,
                "Nothing handed: the community says {name}'s new phone already holds the earlier key this phone has. If it can't read those messages, tell an owner.",
                "Nothing handed: the community says {name}'s new phone already holds the {n} earlier keys this phone has. If it can't read those messages, tell an owner.",
                { name }),
            ok: true,
        };
    }
    if (r.planned === 0) return { text: t("Nothing to unlock: this phone found no earlier key of {name}'s to hand over.", { name }), ok: true };
    return { text: t("Done. {name}'s new phone can read those conversations.", { name }), ok: true };
}

/** confirmedByText: the new phone's own note of who confirmed it, with the day it did. */
export function confirmedByWords(name: string, at: number): string {
    return t('Confirmed by {name}, {date}', { name, date: formatDate(new Date(at), 'day-month') });
}

// ── An owner's 12 words: utils/owner-words.ts ─────────────────────────────────────────────────────────────────────

/** OWNER_WORDS_COPY.count: the words typed weren't twelve. */
export function ownerWordsCountWords(n: number): string {
    return tn(n, "That's {n} word. Type all 12, in order.", "That's {n} words. Type all 12, in order.");
}

// ── Taking over or restoring with this phone: utils/takeover-unlock.ts ─────────────────────────────────────────────

/** openedFromLinkWarning: the sheet was opened by a link, not by scanning a server's screen. */
export function openedFromLinkWords(purpose: 'takeover' | 'restore', host: string): string {
    return purpose === 'restore'
        ? t("You opened this from a link, not by scanning a server's screen. Unlock only if you are restoring a backup on {host} yourself, right now. If a message or a web page sent you here, choose “Not now”: whoever runs {host} would get your community's backup.", { host })
        : t("You opened this from a link, not by scanning a server's screen. Unlock only if you started the take-over on {host} yourself, right now. If a message or a web page sent you here, choose “Not now”.", { host });
}

// ── Signing a computer in: utils/settings-signin.ts ──────────────────────────────────────────────────────────────

/** agentLines: what the assistant is, the name never alone. */
export function agentLinesWords(a: AgentAsking): string[] {
    return [
        a.name ? t('Assistant: “{name}” (the name it gave itself)', { name: a.name }) : t('Assistant: no name given'),
        t('Sends what it reads to: {host}', { host: a.sendsTo }),
        t('It reads health, backups, totals, reports and join requests as you, and can only suggest changes for you to approve.'),
    ];
}

/** "1:35", as a count-down. */
const minutesSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** formatTimeLeft: "1:35 left". */
export function timeLeftWords(secondsLeft: number): string {
    return t('{time} left', { time: minutesSeconds(Math.max(0, Math.ceil(secondsLeft))) });
}

/** computerLines: the browser, how long ago it asked, and where from. */
export function computerLinesWords(look: Extract<PairingLookup, { kind: 'ok' }>, openSeconds: number): string[] {
    const lines = [look.browser === 'A browser' ? t('Computer: A browser') : t('Computer: {browser}', { browser: look.browser })];
    if (look.askedSecondsAgo !== null) {
        const s = look.askedSecondsAgo + Math.max(0, Math.floor(openSeconds));
        lines.push(s < 60 ? tn(s, 'Asked {n} second ago', 'Asked {n} seconds ago') : t('Asked {min} min {sec} s ago', { min: Math.floor(s / 60), sec: s % 60 }));
    }
    if (look.fromAddress) {
        lines.push(look.sameNetwork
            ? t('From {address} (same network as this phone)', { address: look.fromAddress })
            : t('From {address}', { address: look.fromAddress }));
    }
    return lines;
}

/** confirmDigitsLine: the digits the computer must type. */
export function confirmDigitsWords(code: string): string {
    return t('On the computer, type {code}', { code });
}

/** digitsDone's label: held until the computer's time is up. */
export function digitsDoneWords(msLeft: number): string {
    return msLeft <= 0 ? t('Done') : t('Done ({time})', { time: `0:${String(Math.ceil(msLeft / 1000)).padStart(2, '0')}` });
}

// ── Claiming a community: utils/node-claim.ts ──────────────────────────────────────────────────────────────────────

/** claimOutcomeMessage: why a claim didn't make this phone the owner ('' for one that did). */
export function claimOutcomeWords(outcome: ClaimOutcome, communityName: string): string {
    switch (outcome.kind) {
        case 'wrong-code':
            return t("That code isn't right. Read it again on the server: docker compose exec beanpool-node cat /data/claim-code.txt");
        case 'code-changed':
            return t('The server made a new code; read it again.');
        case 'already-claimed':
            return t('Someone already owns {name}.', { name: communityName });
        case 'no-code':
            return t('This server has no claim code. Restart it to make one, then read the new code.');
        case 'wrong-server':
            return t('Your phone reached a different server than this address names. Check the address.');
        case 'braked':
            return outcome.retryAfter
                // One English form for both, as node-claim.ts writes it ("Wait 1 seconds"): the other languages get theirs.
                ? tn(outcome.retryAfter, 'Too many tries from this network. Wait {n} seconds and try again.', 'Too many tries from this network. Wait {n} seconds and try again.')
                : t('Too many tries from this network. Wait a little and try again.');
        case 'check-again':
            return t("We couldn't confirm the claim yet. It may have worked. Check again in a minute, or from another network (Wi-Fi or mobile data).");
        case 'error':
            return keyLineWords(outcome.message);
        case 'owner':
            return '';
    }
}

// ── Deleting the account from this phone: utils/delete-here.ts ─────────────────────────────────────────────────────

/** stillKeptLine: another saved community still has this key, so the phone keeps it. Whole sentences, one after another. */
export function stillKeptWords(keeps: readonly KeptCommunity[]): string {
    const members = keeps.filter((c) => c.membership === 'member').map((c) => c.name);
    const unasked = keeps.filter((c) => c.membership === 'unreachable').map((c) => c.name);
    const sentences: string[] = [];
    if (members.length > 0) sentences.push(t('You are still a member of {names}.', { names: listNameWords(members) }));
    if (unasked.length > 0) {
        sentences.push(tn(unasked.length,
            "{names} couldn't be reached, so it counts as a community you are still in.",
            "{names} couldn't be reached, so they count as communities you are still in.",
            { names: listNameWords(unasked) }));
    }
    sentences.push(t('Deleting this account from this phone would lose it there too, so this phone keeps it.'));
    sentences.push(keeps.length === 1 ? t('Switch to it instead.') : t('Switch to one of them instead.'));
    return sentences.reduce((all, next) => t('{sentence} {next}', { sentence: all, next }));
}
