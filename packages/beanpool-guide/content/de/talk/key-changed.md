---
slug: key-changed
title: Wenn ein Schlüssel im Chat wechselt
summary: Warum ein Chat den Versand stoppt, wie du den Schlüsselcode prüfst und wann du fortfahren kannst.
related: messages, your-12-words, people
source-hash: c6be30fdc4888113
---

## Was es bedeutet

Jede Nachricht zwischen zwei Personen wird so verschlüsselt, dass nur das Telefon der anderen Person sie öffnen kann. Sie wird für deren **Schlüssel** verschlüsselt, nicht für deren Namen. Dein Telefon merkt sich, für welchen Schlüssel es deinen Chat verschlüsselt hat.

Wenn deine Community nun einen anderen Schlüssel für die Person nennt, hält dein Telefon inne und informiert dich, statt unbemerkt an den neuen Schlüssel zu senden. Oben im Chat siehst du **Der Schlüssel hinter „Ben“ hat sich geändert.** Das Eingabefeld ist ausgegraut und meldet, dass das Senden pausiert ist.

Deine früheren Nachrichten mit der Person sind in der Regel weiterhin lesbar wie zuvor. Auf einem Telefon, das du gerade wiederhergestellt oder neu eingerichtet hast, steht bei Nachrichten vom neuen Schlüssel: **Mit dem neuen Schlüssel gesendet. Wird angezeigt, nachdem du fortfährst.**, bis du eine Entscheidung triffst.

Dies gilt für die Telefon-App. Die Web-App speichert Schlüssel derzeit noch nicht.

## Warum das passieren kann

- **Die Person hat ein neues Telefon und einen neuen Schlüssel.** Das ist der häufigste Grund. Der alte Schlüssel ist weg, also hat sie einen neuen.
- **Etwas stimmt nicht.** Der Server einer Community listet auf, wer an jedem Chat beteiligt ist. Ein Server, der deine Nachrichten mitlesen wollte, könnte den Schlüssel einer fremden Person hinter den Namen deines Freundes setzen. Der Name sieht richtig aus, aber der Schlüssel ist es nicht.

Dein Telefon kann diese Fälle nicht von alleine unterscheiden. Du kannst es – anhand des Schlüsselcodes.

## Den Schlüsselcode mit der Person abgleichen

- Das Banner zeigt einen Code an: 20 Ziffern in fünf Vierergruppen.
- Bitte die Person, die **Einstellungen** zu öffnen, dann **Kontoschutz**, und dir **Mein Schlüsselcode** vorzulesen.
- **Mein Schlüsselcode** gibt es nur in der Telefon-App. Nutzt die Person ausschließlich die Web-App, kann sie ihn dir noch nicht vorlesen: Tippe auf **Nicht jetzt**, bis sie die Telefon-App öffnen kann.
- Gleiche den Code **persönlich oder in einem Telefon- oder Videoanruf** ab, bei dem du sicher bist, dass es die Person ist. Gleiche ihn nicht über eine Nachricht in BeanPool ab: Wenn der Schlüssel falsch ist, gilt das auch für jeden, der antwortet.
- Stimmt jede Ziffer überein, setze das Häkchen bei **Ich habe mit Ben gesprochen: Der Schlüsselcode in ihren Einstellungen stimmt mit diesem überein** und tippe auf **Mit neuem Schlüssel fortfahren**.

Von da an gehen deine Nachrichten an den neuen Schlüssel. Das Banner und der Hinweis **Schlüssel geändert** am Chat im **Chat** verschwinden, und deine früheren Nachrichten bleiben lesbar.

Der Code ist nicht geheim. Du kannst ihn bedenkenlos vorlesen.

## Wenn der Code nicht übereinstimmt oder du ihn nicht prüfen kannst

Tippe auf **Nicht jetzt**. Es wird nichts gesendet und nichts geändert. Du kannst später zum Chat zurückkehren.

Ein pausierter Chat bleibt möglicherweise pausiert, bis du fortfährst. Es gibt keinen anderen Weg, darin weiterzuschreiben: Deine Community führt genau einen Chat für euch beide, sodass das Starten eines neuen Chats mit derselben Person denselben Chat öffnet.

Stimmt der Code nicht überein, fahre nicht fort. Informiere die Person und die Admins deiner Community: Möglicherweise versucht jemand, deine Nachrichten mitzulesen.

## Wenn das Banner keinen Schlüssel zum Fortfahren anbietet

Manchmal nennt die Community in einem Chat zwischen zwei Personen keinen einzelnen Schlüssel für die Person: Sie listet mehrere oder gar keinen auf. Dann gibt es keinen Schlüssel zum Fortfahren, das Banner weist darauf hin und bietet nur **Nicht jetzt** an. Es wird nichts gesendet. Sprich persönlich oder telefonisch mit der Person. Dein Telefon überprüft den Chat von selbst erneut, sobald sich die Liste der Community ändert, und ein neuer Chat mit derselben Person ist derselbe Chat.

## Wenn das Banner meldet, dass dein Telefon den Chat von Anfang an überprüft

Nachdem du dein Telefon aus deinen 12 Wörtern wiederhergestellt oder die App aktualisiert hast, prüft dein Telefon jeden Chat anhand seiner eigenen früheren Nachrichten. Kamen diese von einem anderen Schlüssel als dem, den deine Community jetzt für die Person angibt, beginnt das Banner mit: **Dieses Telefon überprüft diesen Chat von Anfang an, wie nach einer Wiederherstellung oder einem App-Update.** Gleiche den Code wie oben beschrieben mit der Person ab. Nachdem du den Chat-Speicher der Community zurückgesetzt hast, beginnt es stattdessen mit: **Der Chat-Speicher dieser Community wurde zurückgesetzt, daher überprüft dieses Telefon den Chat von Beginn an.**

## Chat-Speicher

Dein Telefon führt für jede Community einen kleinen Speicher: mit welchem Schlüssel jeder deiner Chats geführt wird und welche Chats privat sind. Er wird auf dem Telefon gespeichert, und der Server der Community kann einen Chat nicht von sich aus auf einen anderen Schlüssel übertragen: Das kannst nur du über das Banner. Er bleibt auf dem Telefon erhalten, wenn du dich abmeldest, sodass das Ab- und erneute Anmelden ihn nicht löscht. Das Telefon setzt ihn niemals von sich aus zurück.

Du kannst ihn für eine Community zurücksetzen: Öffne die **Einstellungen**, tippe unter **Konto & Identität** auf **Chat-Speicher**, tippe neben der Community auf **Zurücksetzen**, lies die Warnung und tippe erneut auf **Zurücksetzen**. Die App verweist dich nur hierher, wenn sie meldet, dass sie diesen Speicher nicht lesen konnte und ein erneuter Versuch nicht geholfen hat.

Nach einem Zurücksetzen prüft dein Telefon jeden Chat in dieser Community anhand der gespeicherten Nachrichten noch einmal von Anfang an. Ein Chat, dessen Nachrichten von einem anderen Schlüssel stammten als dem, den die Community jetzt angibt, zeigt das Banner erneut, beginnend mit: **Der Chat-Speicher dieser Community wurde zurückgesetzt, daher überprüft dieses Telefon den Chat von Beginn an.** Gleiche den Code wie oben beschrieben mit der Person ab.

Zwei Dinge können sich nach einem Zurücksetzen ändern, und die Warnung weist vor deiner Bestätigung darauf hin: Ein Chat, der wegen eines geänderten Schlüssels pausiert war, kann sich mit dem neuen Schlüssel öffnen, und ein privater Chat, der aus dem Chat verschwunden war, kann als Gruppenchat zurückkehren, den die Community mitlesen kann. Prüfe vor dem Absenden den Schlüsselcode oder wer im Chat ist.

Ein Zurücksetzen hilft nicht bei einem Chat, den dein Telefon keinem einzelnen Schlüssel zuordnen kann: Er wird erneut geprüft und stoppt wieder. Gleiche stattdessen den Code wie oben beschrieben mit der Person ab.

Dies gilt für die Telefon-App. Die Web-App besitzt keinen Chat-Speicher.

## Wenn das Banner meldet, dass dein Telefon den Chat keinem Schlüssel zuordnen kann

Manchmal waren die früheren Nachrichten in einem Chat mit Schlüsseln verschlüsselt, die dein Telefon nicht einer einzelnen Person zuordnen kann. Über dem Eingabefeld steht dann: **Dieses Telefon kann diesen Chat keinem Schlüssel zuordnen, daher ist das Senden deaktiviert.** und das Banner zeigt den Code des Schlüssels, den deine Community jetzt für die Person listet.

Einige Nachrichten werden möglicherweise weiterhin angezeigt. Sie stammen vielleicht nicht von der Person, deren Name über dem Chat steht: Die eigenen früheren Nachrichten dieser Person können diejenigen sein, bei denen steht: **Diese Nachricht konnte nicht verifiziert werden und wird daher nicht angezeigt.** Diese bleiben auch so, nachdem du fortfährst.

Gleiche den Code wie oben beschrieben persönlich oder bei einem Anruf mit der Person ab. Stimmt er überein, setze das Häkchen und tippe auf **Mit neuem Schlüssel fortfahren**: Von da an gehen deine Nachrichten an diesen Schlüssel. Stimmt er nicht überein oder kannst du ihn nicht prüfen, tippe auf **Nicht jetzt**. Ein neuer Chat mit derselben Person ist derselbe Chat; es gibt also nichts anderes zu versuchen. Nennt die Community keinen einzelnen Schlüssel für die Person, bietet das Banner nur **Nicht jetzt** an, und dein Telefon prüft den Chat von selbst erneut, sobald sich die Liste der Community ändert.

## Was dein Telefon prüfen kann und was nicht

Dein Telefon überprüft einen Chat anhand der Nachrichten, die es bereits gespeichert hat. Ein wiederhergestelltes Telefon oder ein bestehendes Telefon beim Update wird nur von einem Server gesteuert, der den ältesten Teil des Chats in den gesendeten Daten zurückhält oder umgibt. Ein Telefon, das diesen ältesten Teil bereits gespeichert hatte, lässt sich durch nichts täuschen, was der Server nach dem Update sendet.

Ein gerade wiederhergestelltes oder frisch aktualisiertes Telefon kann daher über den Schlüssel eines Chats getäuscht werden. Ein Banner kann das nicht ausschließen. **Bestätige einen geänderten Schlüssel persönlich** oder bei einem Anruf, bei dem du sicher bist, dass es die Person ist.

## Wenn die Community ein Datum angibt

Wenn deine Community nachweisen kann, dass das Konto einen neuen Schlüssel erhalten hat, weist das Banner darauf hin, zum Beispiel: **Diese Community meldet, dass das Konto am 3. Okt. 2026 einen neuen Schlüssel erhalten hat.** Das hilft dir zu verstehen, was passiert ist, ersetzt aber nicht den Abgleich des Codes: Ein Server könnte dies ebenfalls behaupten.
