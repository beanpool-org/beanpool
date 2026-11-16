---
slug: key-changed
title: Wenn ein Schlüssel im Chat wechselt
summary: Was die graue Zeile über einen geänderten Schlüssel bedeutet, wie du einen Schlüsselcode mit der Person abgleichst und was „Als verifiziert markieren“ bewirkt.
related: messages, your-12-words, people
source-hash: d4dfaf863af532c6
---

## Was es bedeutet

Jede Nachricht zwischen zwei Personen wird so verschlüsselt, dass nur das Telefon der anderen Person sie öffnen kann. Sie wird für deren **Schlüssel** verschlüsselt, nicht für deren Namen. Deine Community listet auf, welcher Schlüssel zu der Person gehört, und dein Telefon merkt sich, für welchen Schlüssel es deinen Chat verschlüsselt hat.

Wenn deine Community einen neuen Schlüssel für die Person nennt, hängt das, was dein Telefon tut, von einer Sache ab: ob du die Person auf diesem Telefon als verifiziert markiert hast.

## Jemand, den du nicht als verifiziert markiert hast

Der Chat geht mit dem neuen Schlüssel weiter. Dein Telefon schreibt eine graue Zeile in den Chat, zum Beispiel: **Der Schlüssel von Ben hat sich geändert. Meist heißt das, dass die Person auf einem neuen Telefon wieder in ihr Konto gekommen ist. Tippe, um den Schlüsselcode zu sehen.**

Nichts wird pausiert, der Chat bekommt unter **Chat** keinen Hinweis, und deine früheren Nachrichten bleiben lesbar. Die Zeile soll dich informieren, nicht warnen. Tippe darauf, um den Schlüsselcode zu sehen.

## Warum sich ein Schlüssel ändern kann

- **Die Person ist auf einem neuen Telefon wieder in ihr Konto gekommen.** Das ist der übliche Grund. Ein Admin hat ihr Konto auf das neue Telefon übertragen, daher hat sie einen neuen Schlüssel.
- **Etwas stimmt nicht.** Der Server einer Community listet auf, wer an jedem Chat beteiligt ist. Ein Server, der deine Nachrichten mitlesen wollte, könnte den Schlüssel einer fremden Person hinter den Namen deines Freundes setzen. Der Name sieht richtig aus, der Schlüssel aber nicht.

Dein Telefon kann diese Fälle nicht von allein unterscheiden. Du kannst es – mit dem Schlüsselcode.

## Den Schlüsselcode einer Person prüfen

- Tippe im Chat oben auf **⋯** und dann auf **Schlüsselcode**. Ein Tippen auf die graue Zeile öffnet ihn ebenfalls.
- Du siehst den Schlüsselcode der Person: 20 Ziffern in fünf Vierergruppen.
- Bitte die Person, dir ihren Code unter **Mein Schlüsselcode** vorzulesen. In der Telefon-App steht er unter **Einstellungen**, bei **Kontoschutz**. In der Web-App steht er unter **Einstellungen**, bei **Konto & Identität**.
- Prüfe ihn **persönlich oder in einem Telefon- oder Videoanruf**, bei dem du sicher bist, dass es die Person ist. Prüfe ihn nicht über eine Nachricht in BeanPool: Wenn der Schlüssel falsch ist, gilt das auch für jeden, der antwortet.
- Stimmt jede Ziffer überein, ist dieser Chat wirklich mit der Person. Dann kannst du auf **Als verifiziert markieren** tippen.

Der Code ist nicht geheim. Du kannst ihn bedenkenlos vorlesen.

## Als verifiziert markieren

**Als verifiziert markieren** sorgt dafür, dass dein Telefon dich fragt, bevor es für diese Person an einen neuen Schlüssel sendet. Der Schlüsselcode-Bildschirm zeigt dann **Verifiziert ✓**, und ebenso der obere Rand des Chats, neben **🔒 Ende-zu-Ende-verschlüsselt** unter dem Namen der Person.

Die Markierung wird nur auf diesem Telefon gespeichert, für diesen Chat in dieser Community. Die Web-App kennt sie nicht, und das Zurücksetzen des Chat-Speichers der Community (siehe unten) entfernt sie.

Um sie zurückzunehmen, öffne erneut **Schlüsselcode**, tippe auf **Verifizierung entfernen** und bestätige mit **Verifizierung entfernen**.

## Wenn sich der Schlüssel einer Person ändert, die du als verifiziert markiert hast

Dein Telefon hält an und fragt dich, statt an den neuen Schlüssel zu senden. Oben im Chat siehst du **Der Schlüssel hinter „Ben“ hat sich geändert.** Das Banner beginnt mit **Du hast Ben als verifiziert markiert, daher fragt dieses Telefon nach, bevor es an einen neuen Schlüssel sendet.** und zeigt den neuen Schlüsselcode.

Das Eingabefeld ist ausgegraut, und darüber steht **Der Schlüssel hinter Ben hat sich geändert, daher ist das Senden pausiert.** Eine Nachricht vom neuen Schlüssel zeigt **Mit dem neuen Schlüssel gesendet. Wird angezeigt, nachdem du fortfährst.**, bis du dich entscheidest. Der Chat trägt unter **Chat** den Hinweis **Schlüssel geändert**.

Prüfe den neuen Code mit der Person, wie oben beschrieben. Stimmt jede Ziffer überein, setze das Häkchen bei **Ich habe es mit Ben abgeglichen: Der Schlüsselcode in ihren Einstellungen stimmt mit diesem überein.** und tippe dann auf **Mit dem neuen Schlüssel fortfahren**. Von da an gehen deine Nachrichten an den neuen Schlüssel, Ben bleibt **Verifiziert ✓**, das Banner und der Hinweis verschwinden, und deine früheren Nachrichten bleiben lesbar.

Stimmt der Code nicht überein oder kannst du ihn nicht prüfen, tippe auf **Nicht jetzt**. Es wird nichts gesendet und nichts geändert. Der Chat bleibt pausiert, bis du fortfährst: Deine Community führt genau einen Chat für euch beide, sodass ein neuer Chat mit derselben Person denselben Chat öffnet.

Stimmt der Code nicht überein, fahre nicht fort. Informiere die Person und die Admins deiner Community: Möglicherweise versucht jemand, deine Nachrichten mitzulesen.

Auf dem Schlüsselcode-Bildschirm beendet auch **Verifizierung entfernen** die Pause: Der Chat geht mit dem neuen Schlüssel weiter, ohne die Prüfung.

## Wenn die Community ein Datum angibt

Wenn deine Community zeigen kann, dass das Konto einen neuen Schlüssel erhalten hat, sagt das Banner das, zum Beispiel: **Diese Community meldet, dass das Konto am 3. Okt. 2026 einen neuen Schlüssel erhalten hat.** Das hilft dir zu verstehen, was passiert ist, ersetzt aber nicht das Prüfen des Codes: Ein Server könnte das ebenfalls behaupten.

## Wenn es keinen Schlüssel zum Fortfahren gibt

Manchmal nennt die Community in einem Chat zwischen zwei Personen keinen einzelnen Schlüssel für die Person: Sie listet mehrere oder gar keinen auf. Dann gibt es niemanden, für den deine Nachrichten verschlüsselt werden könnten, ob du die Person als verifiziert markiert hast oder nicht. Das Banner weist darauf hin und bietet nur **Nicht jetzt** an, es wird nichts gesendet, und der Chat trägt unter **Chat** den Hinweis **Schlüssel geändert**. Der Schlüsselcode-Bildschirm zeigt **Diese Community führt keinen eindeutigen Schlüssel für Ben in diesem Chat auf, daher wird noch nicht gesendet.**

Sprich persönlich oder telefonisch mit der Person. Dein Telefon prüft den Chat von selbst erneut, sobald sich die Liste der Community ändert, und ein neuer Chat mit derselben Person ist derselbe Chat.

Konnte dein Telefon auch die früheren Nachrichten keinem einzelnen Schlüssel zuordnen, steht über dem Eingabefeld **Dieses Telefon kann diesen Chat keinem Schlüssel zuordnen, daher ist das Senden deaktiviert. Was du hier liest, stammt möglicherweise nicht von der Person.**, und der Schlüsselcode-Bildschirm hat keinen Code zum Anzeigen.

## Nachdem du dein Telefon wiederhergestellt oder neu eingerichtet hast

Dein Telefon prüft jeden Chat anhand der früheren Nachrichten, die es gespeichert hat. Stammten diese Nachrichten von einem älteren Schlüssel als dem, den deine Community jetzt nennt, geht der Chat mit dem genannten Schlüssel weiter, die früheren Nachrichten bleiben lesbar, und die graue Zeile erscheint einmal.

Kann dein Telefon einige davon keinem Schlüssel zuordnen, geht der Chat trotzdem mit dem Schlüssel weiter, den deine Community nennt, ohne Zeile. Eine Nachricht, die es nicht öffnen konnte, zeigt **Diese Nachricht konnte nicht verifiziert werden und wird daher nicht angezeigt.** Das bleibt so.

## Chat-Speicher

Dein Telefon führt für jede Community einen kleinen Speicher: mit welchem Schlüssel jeder deiner Chats geführt wird, wen du als verifiziert markiert hast und welche Chats privat sind. Er liegt auf dem Telefon. Er bleibt auf dem Telefon, wenn du dich abmeldest, sodass Ab- und erneutes Anmelden ihn nicht löscht. Das Telefon setzt ihn nie von sich aus zurück.

Du kannst ihn für eine Community zurücksetzen: Öffne **Einstellungen**, tippe unter **Konto & Identität** auf **Chat-Speicher**, tippe neben der Community auf **Zurücksetzen**, lies die Warnung und tippe erneut auf **Zurücksetzen**. Die App verweist dich nur hierher, wenn sie meldet, dass sie diesen Speicher nicht lesen konnte und ein erneuter Versuch nicht geholfen hat.

Nach einem Zurücksetzen prüft dein Telefon jeden Chat in dieser Community noch einmal von Anfang an, anhand der Nachrichten, die es gespeichert hat, wie nach einer Wiederherstellung.

Die Warnung sagt dir vor dem Bestätigen, was sich ändern kann. Ein Chat, der wegen eines geänderten Schlüssels pausiert war, kann sich mit dem neuen Schlüssel öffnen. Ein privater Chat, der aus Chat verschwunden war, kann als Gruppenchat zurückkehren, den die Community lesen kann. Personen, die du in dieser Community als verifiziert markiert hast, sind wieder nicht verifiziert. Prüfe vor dem Senden den Schlüsselcode oder wer im Chat ist.

Dies gilt für die Telefon-App. Die Web-App hat keinen Chat-Speicher.

## In der Web-App

Die Web-App merkt sich keine Schlüssel. Bei jedem Senden verschlüsselt sie deine Nachricht für den einen Schlüssel, den deine Community für die Person nennt, und nennt sie mehrere oder keinen, wird deine Nachricht nicht gesendet. Daher zeigt sie keine graue Zeile und kein Banner, und sie hat kein **Als verifiziert markieren**: Eine Person, die du auf deinem Telefon als verifiziert markiert hast, löst in der Web-App keine Pause aus.

Schlüsselcodes kannst du dort trotzdem lesen. **Mein Schlüsselcode** steht unter **Einstellungen**, bei **Konto & Identität**. In einem Chat zwischen zwei Personen hat das Menü **⋮** den Eintrag **Schlüsselcode**: Er zeigt den Code der Person und sagt, dass der Browser sich keine Schlüsselcodes merkt.

## Was dein Telefon prüfen kann und was nicht

Bei einer Person, die du nicht als verifiziert markiert hast, entscheidet die Liste deiner Community bei jeder Änderung über den Schlüssel, und dein Telefon informiert dich mit der grauen Zeile. Auf einem Telefon, das den Chat schon gespeichert hatte, hinterlässt ein geänderter Schlüssel immer die Zeile. Ein gerade wiederhergestelltes Telefon kann getäuscht werden: Ein Server, der die älteren Nachrichten zurückhält, hinterlässt keine Zeile.

Die Zeile kann ein neues Telefon nicht von einem ausgetauschten Schlüssel unterscheiden. Das kann nur der Schlüsselcode, und nur **Als verifiziert markieren** bringt dein Telefon dazu, beim nächsten Mal anzuhalten. Wenn dir ein Chat wichtig ist, prüfe den Code persönlich oder bei einem Anruf, bei dem du sicher bist, dass es die Person ist, und markiere sie als verifiziert.
