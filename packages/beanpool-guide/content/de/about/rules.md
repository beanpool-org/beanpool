---
slug: rules
title: Regeln und Entscheidungen
summary: Abstimmungen, Beteiligung, geheime Wahl, Stimmberechtigung, Suspendierung, Ausschluss, Verwalter sowie Koordinatoren und Hauptkoordinatoren.
related: decisions, proposing-a-decision, polls, keepers, groups, people
source-hash: be2e7321aab53ca8
---

## Zwei Wege, die Community zu befragen

- Eine **Umfrage** ist eine Frage im Feed, wie etwa „Markt am Sonntag?“. Sie zeigt, was die Leute denken. Sie ändert von selbst niemals etwas.
- Eine **Entscheidung** ist verbindlich. Wird sie angenommen, führt der Server deiner Community sie selbstständig aus. Niemand muss eine Schaltfläche drücken und niemand kann sie stillschweigend ignorieren.

In der globalen Community gibt es Umfragen, aber keine Entscheidungen: Jeder kann ihr mit 12 Wörtern oder einer Anmeldung beitreten, sodass eine einzelne Person mit mehreren Konten eine Abstimmung kippen könnte. Alles Folgende über Entscheidungen bezieht sich auf lokale Communitys.

## Was eine Entscheidung bewirken kann

Bezüglich eines Mitglieds:

- Ein Mitglied suspendieren oder eine Suspendierung aufheben.
- Den Kredit eines Mitglieds einfrieren oder wieder freigeben.
- Einem Mitglied das Recht geben, für Neulinge zu bürgen, oder es ihm entziehen.
- Einen Hauptverwalter aus einem Betrieb oder einen Leiter aus einem Projekt entfernen.
- Ein Mitglied aus der Community ausschließen oder wieder aufnehmen.

Bezüglich des Gemeinguts:

- Bohnen aus dem Gemeingut an ein Projekt oder einen Betrieb vergeben.
- Einem Mitglied einen Härtefall-Zuschuss aus dem Gemeingut gewähren.
- Schulden eines Projekts oder Betriebs aus dem Gemeingut begleichen.
- Eine Schuld erlassen, die ein ausgetretenes Mitglied dem Gemeingut schuldete. Es fließen keine Bohnen. Der Eintrag bleibt als erlassen markiert bestehen. Wo eine Community eine Namensliste führt, wird dies von dort aus gestartet.

Ein Zuschuss darf nicht höher sein als das, was das Gemeingut derzeit besitzt, zuzüglich dessen, was in den letzten 30 Tagen hineingeflossen ist. Ein höherer Betrag wird beim Starten abgelehnt.

## Wer eine Entscheidung initiieren kann

Jedes aktive Mitglied, dessen Kredit nicht eingefroren ist und das im Markt gehandelt hat oder dem von einem Admin ein Vertrauensabzeichen verliehen wurde. Eine Bürgschaft allein reicht nicht aus. Admins können dies ebenfalls. Du kannst jeweils nur eine offene Entscheidung haben. Du musst den Grund in mindestens 10 Zeichen begründen.

## Wer abstimmen kann

Jedes aktive Mitglied, dessen Kredit nicht eingefroren ist und das beigetreten ist, **bevor** die Entscheidung eröffnet wurde. Personen, die während einer Abstimmung beitreten, können nicht daran teilnehmen. Betriebskonten können nicht abstimmen.

## Wie Stimmen zählen

- Entscheidungen über ein Mitglied: **Ein Mitglied, eine Stimme**. Ja oder Nein.
- Entscheidungen über Bohnen des Gemeinguts: Stimmen werden nach Handelsaktivität gewichtet. Du kannst mehr als eine Stimme abgeben, aber es wird teurer: 1 Stimme kostet 1 Stimm-Credit, 2 Stimmen kosten 4, 3 Stimmen kosten 9. Deine Stimm-Credits stammen aus deinen abgeschlossenen Handelsgeschäften, gezählt bis zu 500 Bohnen pro Handelspartner. Du erhältst deine vollen Stimm-Credits bei jeder Entscheidung erneut. Sie verbrauchen sich nie.
- Wenn du noch nie einen Handel abgeschlossen hast, kannst du noch nicht über Bohnen des Gemeinguts abstimmen.
- Du kannst deine Stimme bis zum Ende der Abstimmung jederzeit ändern.

## Geheime Wahlen

Die App zeigt niemandem, wie du gestimmt hast, auch nicht den Admins. Jeder sieht die Gesamtzahlen, und du siehst deine eigene Stimme. Deine Stimme wird auf dem Server deiner Community zusammen mit deinem Konto gespeichert, damit sie gezählt und überprüft werden kann. Die Eigentümer und Admins, die den Server betreiben, können eine Kopie seiner Dateien anfertigen und deine Stimme dort theoretisch einsehen.

Umfragen sind ebenfalls anonym, es sei denn, die Person, die sie startet, macht sie zu einer **offenen Abstimmung**: Dann können Mitglieder sehen, wer was gewählt hat. Die Umfrage gibt an, worum es sich handelt.

## Wie lange eine Abstimmung läuft

Jede Entscheidung läuft genau 7 Tage lang. Die Abstimmung beginnt sofort. Nach Ablauf der 7 Tage zählt der Server deiner Community die Stimmen und setzt das Ergebnis um.

## Beteiligung (Quorum)

Eine Abstimmung zählt nur, wenn genügend Personen teilnehmen.

- Genügend Personen bedeutet 30 % der abstimmungsberechtigten Mitglieder, die in den letzten 30 Tagen aktiv waren. Es sind niemals weniger als 3 Personen.
- Für den Ausschluss eines Mitglieds sind es 25 %.
- „Aktiv“ bedeutet, dass deine App in diesen 30 Tagen etwas an den Server deiner Community gesendet hat: Einen Beitrag, einen Handel, eine Stimme, eine Nachricht. Auf dem Smartphone zählt meist auch das bloße Öffnen der App, da sie sich bei jedem Start für Benachrichtigungen anmeldet.
- Die Beteiligung zählt Köpfe, nicht das Stimmgewicht ihrer Stimmen.

Wenn zu wenige Personen abstimmen, geschieht nichts. Die Entscheidung schließt als „ungelöst“.

## Wie viel Ja erforderlich ist

- Die meisten Entscheidungen: 60 % Ja.
- Ausschluss eines Mitglieds: 66 % Ja.
- Rückgängigmachen einer Maßnahme (Aufheben einer Suspendierung, Freigabe von Kredit, Wiederaufnahme eines Mitglieds): Mehr als die Hälfte.
- Ein Stimmengleichstand gilt immer als Ablehnung.

## Wenn eine Entscheidung angenommen wird

- Der Server deiner Community prüft, ob sie noch sinnvoll ist: Das Mitglied existiert noch, das Gemeingut hat genügend Bohnen. Dann handelt er.
- Fehlen dem Gemeingut Bohnen für einen Zuschuss, wartet der Zuschuss, bis genügend vorhanden sind. Nach 90 Tagen verfällt er.
- Es kann immer nur ein Zuschuss gleichzeitig warten. Wenn ein zweiter Zuschuss angenommen wird, während das Gemeingut noch zu wenig hat, wartet dieser nicht: Er wird endgültig geschlossen, und die Community muss erneut abstimmen.
- Wenn die Person oder der Betrieb bereits nicht mehr existiert, schließt die Entscheidung, ohne etwas zu tun.

## Ein Mitglied ausschließen

- Wird ein Ausschluss angenommen, wird das Mitglied sofort suspendiert und sein Kredit eingefroren.
- Nach weiteren 7 Tagen wird es endgültig entfernt. In diesen 7 Tagen hebt eine Entscheidung zur Wiederaufnahme den Ausschluss auf.
- Ein Mitglied, das sein eigenes Konto löscht, kann nicht wieder aufgenommen werden, selbst nach einem Ausschluss. Es kann mit einer neuen Einladung erneut beitreten.
- Wenn ein Mitglied ausgeschlossen wird, werden seine Beiträge entfernt. Wenn es Bohnen schuldete, begleicht das Gemeingut die Schuld. Wenn es Bohnen besaß, gehen diese Bohnen an das Gemeingut.
- Die Community kann für den Ausschluss oder die Suspendierung jedes Mitglieds stimmen, mit Ausnahme eines Eigentümers oder Admins des Servers deiner Community. Sie betreiben den Server selbst, daher kann eine Abstimmung ihnen das nicht entziehen; die App weist darauf hin, wenn du es versuchst. Ein Eigentümer kann einem Admin zuerst die Rolle entziehen, danach ist dieser ein Mitglied wie jedes andere.

## Notfall-Suspendierung

Ein Admin kann ein Mitglied sofort suspendieren, beispielsweise um Schaden abzuwenden. Er muss einen Grund angeben, den die Mitglieder lesen können.

- Im selben Moment öffnet sich eine 7-tägige Entscheidung: „Diese Suspendierung beibehalten?“.
- Sie benötigt die übliche Beteiligung und 60 % Ja.
- Wird sie nicht angenommen oder stimmen zu wenige Personen ab, wird die Suspendierung von selbst aufgehoben.
- Ein Admin kann sich nicht selbst suspendieren und kann den einzigen Eigentümer des Servers nicht suspendieren. Nur ein Eigentümer kann einen anderen Eigentümer suspendieren.

In der globalen Community gibt es keine Abstimmung. Die Suspendierung dauert 7 Tage und wird dann von selbst aufgehoben, es sei denn, ein Admin hebt sie früher auf. Um jemanden länger fernzuhalten, suspendieren die Admins die Person erneut oder entfernen ihr Konto.

## Was Admins tun und nicht tun können

Der Server deiner Community hat Eigentümer und Admins. Sie kümmern sich darum.

- Ein Admin kann eine offene Entscheidung stoppen, muss jedoch eine schriftliche Begründung angeben. Mitglieder können diese bei der Entscheidung lesen.
- Wenn ein Ausschluss angenommen wurde und sich in der 7-tägigen Wartezeit befindet, kann ein Admin ihn stoppen oder sofort vollziehen lassen.
- Admins können Mitgliedern das Recht geben, für Neulinge zu bürgen.
- Admins können einem Mitglied ein Vertrauensabzeichen verleihen. Dies gibt dem Mitglied auch das Vertrauen, das dieses Abzeichen erfordert, und vertieft so seinen Kreditrahmen.
- Admins schlichten feststeckende Deals, aber niemals einen, an dem sie selbst beteiligt sind.

## Umfragen

- Jedes aktive Mitglied, dessen Kredit nicht eingefroren ist, kann eine Umfrage mit 2 bis 4 Antworten starten. Sie läuft 3, 7 oder 14 Tage lang.
- Du kannst jeweils eine offene Umfrage haben. Deine Community kann 5 offene Umfragen gleichzeitig haben.
- Eine in einer Gruppe veröffentlichte Umfrage kann nur von Mitgliedern und Koordinatoren dieser Gruppe beantwortet werden. Beobachter können sie lesen, aber nicht abstimmen.
- Das Beantworten einer Umfrage erfordert ebenfalls einen nicht eingefrorenen Kredit. Du kannst deine Antwort ändern, bis die Umfrage schließt. Die Person, die sie gestartet hat, kann sie vorzeitig beenden.
- Eine Umfrage ist anonym: Jeder sieht nur die Gesamtergebnisse. Die Person, die sie startet, kann stattdessen eine **offene Abstimmung** daraus machen, sodass Mitglieder sehen, wer was gewählt hat. Diese Wahl wird beim Erstellen der Umfrage getroffen und kann nach der Veröffentlichung nicht mehr geändert werden.
- In der globalen Community gibt eine geschlossene anonyme Umfrage auch an, wie viele ihrer Stimmen von neuen oder 12-Wörter-Konten stammten, falls welche dabei waren. Jede Stimme zählt dennoch gleichermaßen.

## Betriebe und Verwalter

Ein Betrieb wird von seinen Verwaltern geführt. Einer von ihnen ist der Hauptverwalter.

- **Beitreten:** Du fragst an, Verwalter zu werden, und gibst an, wie viel deines erworbenen Vertrauens du zusagst (es kann 0 sein). Du kannst über alle deine Betriebe hinweg nicht mehr Vertrauen zusagen, als du durch Handel erworben hast. Der Hauptverwalter bestätigt oder lehnt ab.
- **Zusagen in einer Community, die ihre Mitglieder bestätigt:** Ein bestätigtes Mitglied kann auch einen Teil seines bekannten Kreditrahmens zusagen, bis zur Hälfte davon. Dieser Teil wird von seinem eigenen Rahmen abgezogen.
- **Einspruchsfrist:** Wenn ein Betrieb bereits mehr als einen Verwalter hat, wartet die Genehmigung der Leitung 3 Tage lang. Jeder andere Verwalter kann in dieser Zeit Einspruch einlegen, und ein einzelner Einspruch bricht den Vorgang ab.
- **Einen Verwalter entfernen:** Die Leitung kann einen einfachen Verwalter entfernen. Es gilt dieselbe 3-Tage-Frist, und jeder andere Verwalter kann Einspruch einlegen.
- **Community-Admins:** Ein Admin deiner Community, der nicht Verwalter des Betriebs ist, kann einen Verwalter genehmigen oder einen einfachen Verwalter entfernen — sofort und ohne 3-Tage-Frist. Auf diese Weise kann einem feststeckenden Betrieb geholfen werden.
- **Zurücktreten:** Jeder Verwalter kann zurücktreten. Wenn der Betrieb Schulden hat und deine Zusage benötigt wird, um sie zu decken, musst du warten, bis die Schulden geringer sind oder andere Verwalter mehr zusagen. Der einzige Verwalter kann nicht zurücktreten; er fügt zuerst einen weiteren Verwalter hinzu oder wickelt den Betrieb ab.
- **Deine Zusage** sichert den Kreditrahmen des Betriebs ab. Eine Zusage von erworbenem Vertrauen wird niemals von deinem eigenen Kontostand oder deinem eigenen Kreditrahmen abgezogen.
- **Eine inaktive Leitung:** Wenn der Hauptverwalter 30 Tage lang nichts in der App getan hat, können die anderen Verwalter aus ihrer Mitte eine neue Leitung wählen. Die Abstimmung läuft bis zu 14 Tage mit Ja und Nein. Sie wird angenommen, wenn mehr als die Hälfte der anderen Verwalter Ja sagt. Wenn die Leitung zurückkehrt und etwas in der App tut, wird die Abstimmung abgebrochen. Solange das Konto der Leitung suspendiert ist, zählt nichts von dem, was sie tut, als Rückkehr. Verwalter-Stimmen können nicht geändert werden.
- **Abstimmungen unter den Verwaltern:** In einem Betrieb mit zwei oder mehr Verwaltern kann jeder Verwalter vorschlagen, Bohnen vom eigenen Konto des Betriebs auszuzahlen (niemals mehr, als er besitzt, niemals an sich selbst und an einen Verwalter nur aus dem, was er erwirtschaftet hat, mit der Handelsgebühr von 1,5 %), einen Verwalter zu entfernen oder — in einem Betrieb, jedoch nicht in einem Projekt — einen anderen Verwalter zur Leitung zu machen. Die Verwalter zum Zeitpunkt der Eröffnung stimmen ab; mehr als die Hälfte muss abstimmen; 60 % Ja für Auszahlung oder Entfernung, mehr als die Hälfte für die Wahl einer Leitung. Sie läuft 7 Tage oder endet früher, sobald sich das Ergebnis nicht mehr ändern kann, und wird selbstständig vollzogen. Nur die Verwalter sehen sie. Während sie offen ist, zeigt sie an, wie viele abgestimmt haben; Ja und Nein werden nach Abschluss sichtbar. Niemand sieht, wer wie gestimmt hat, doch in einer sehr kleinen Gruppe können das Ergebnis und wer abgestimmt hat Rückschlüsse zulassen. Diese Abstimmungen berühren niemals das Gemeingut oder das Ansehen von jemandem in der Community: Das sind Community-Entscheidungen. Eine Abstimmung kann nicht die Leitung entfernen (stimme stattdessen für eine neue Leitung), nicht den einzigen Verwalter und keinen Verwalter, dessen Zusage Schulden deckt. Ein Verwalter kann nicht seine eigene Entfernung vorschlagen; er tritt stattdessen zurück.
- **Wenn die Leitung geht oder entfernt wird,** wird der am längsten dienende Verwalter sofort zur Leitung, und die anderen Verwalter können ihn unverzüglich ersetzen. Ist kein Verwalter mehr übrig, wird der Betrieb pausiert.
- **Abwicklung:** Der Hauptverwalter oder der einzige Verwalter kann mit der Schließung eines Betriebs beginnen. Ebenso ein Community-Admin. Es gilt dann eine 7-tägige Wartezeit, und jeder Verwalter oder ein Community-Admin kann sie abbrechen. Ein verschuldeter Betrieb kann nicht geschlossen werden, bis die Schulden beglichen sind oder die Community sie erlässt. Nichts schließt eine Abwicklung von selbst ab: Nach den 7 Tagen muss der Hauptverwalter, der einzige Verwalter oder ein Community-Admin die Schließung abschließen, und dies kann nicht geschehen, solange noch ein Handel offen ist. Wenn er schließt, gehen alle verbleibenden Bohnen an das Gemeingut.

## Gruppen und Koordinatoren

Eine Gruppe wird von ihren Koordinatoren geleitet, und einer von ihnen ist der **Hauptkoordinator**. Wer eine Gruppe erstellt, ist ihr erster Hauptkoordinator.

- Manche Gruppen stehen jedem offen. Manche erfordern die Genehmigung eines Koordinators. Manche sind nur auf Einladung zugänglich.
- **Jeder Koordinator** kann Mitglieder bestätigen und einladen, ein Mitglied oder einen Beobachter entfernen, die Rolle eines Mitglieds oder Beobachters ändern, jemanden zum Koordinator machen, Beiträge und Nachrichten entfernen sowie die Gruppe und die Beitrittsregeln bearbeiten.
- **Nur der Hauptkoordinator** kann einen Koordinator entfernen oder jemandem die Koordinator-Rolle entziehen. Eine gruppeninterne Abstimmung kann dies ebenfalls tun.
- **Niemand kann den Hauptkoordinator entfernen oder ihm die Leitung entziehen.** Weder ein anderer Koordinator noch ein Community-Admin — Admins haben innerhalb einer Gruppe nichts zu sagen. Abgesehen davon, dass die Leitung die Rolle übergibt, kann nur eine eigene Abstimmung der Gruppe eine neue Leitung wählen.
- **Ein suspendierter Koordinator:** Solange das Konto eines Koordinators suspendiert ist, kann er keine Befugnisse als Koordinator ausüben, und seine eigenen Befugnisse als Leitung ruhen ebenfalls. Er bleibt Koordinator und die Leitung bleibt die Leitung; alles funktioniert wieder, sobald die Suspendierung endet. Andere Koordinatoren machen wie gewohnt weiter, und Mitglieder können weiter chatten und Beiträge verfassen. Ein suspendiertes Mitglied kann bis zum Ende der Suspendierung auch keine Gruppe gründen oder einer beitreten.
- **Die Leitung übergeben:** Die Leitung kann jemand anderen zur Leitung machen. Es kann ein anderer Koordinator sein oder ein Mitglied, das gleichzeitig Koordinator wird. Einmal vollzogen, kann die bisherige Leitung dies nicht zurücknehmen.
- **Als Leitung austreten:** Übergib die Leitung zuerst. Wenn niemand sonst in der Gruppe ist, kann die Leitung einfach austreten.
- Der letzte Koordinator kann nicht zurücktreten und kann nicht entfernt werden, solange die Gruppe noch andere Mitglieder hat. Wenn niemand sonst in der Gruppe ist, kann er einfach austreten.
- **Eine eigene Abstimmung der Gruppe.** Die Mitglieder und Koordinatoren einer Gruppe können über eigene Angelegenheiten der Gruppe abstimmen: Einen neuen Hauptkoordinator wählen, jemanden zum Koordinator ernennen, einen Koordinator zum Mitglied herabstufen, jemanden aus der Gruppe entfernen, die Beitrittsregeln ändern oder die Gruppe schließen. Jedes Mitglied und jeder Koordinator kann einen solchen Vorschlag einbringen; Beobachter schauen zu, stimmen aber nicht ab. Jeder, der bei Eröffnung Mitglied oder Koordinator war, kann abstimmen. Mehr als die Hälfte von ihnen muss abstimmen. Das Entfernen von jemandem und das Schließen der Gruppe erfordern 60 % Ja; der Rest benötigt mehr als die Hälfte. Sie läuft 7 Tage oder endet früher, sobald sich das Ergebnis nicht mehr ändern kann, und wird dann von der App selbstständig vollzogen. Stimmen sind geheim und können nicht geändert werden. Eine Abstimmung der Gruppe verschiebt niemals Bohnen und ändert niemals das Ansehen von jemandem in der Community, und Admins können sie nicht stoppen. Eine geschlossene Gruppe nimmt keine neuen Mitglieder und keine neuen Nachrichten mehr auf, und ihre Beiträge sowie Veranstaltungen werden abgesagt. Ihr Chat bleibt lesbar. Du findest die Abstimmung auf der Seite der Gruppe unter **Entscheidungen**. Um eine Gruppe nach ihrer Meinung zu fragen, ohne etwas zu ändern, erstelle eine Umfrage in der Gruppe.
- **Ein inaktiver Hauptkoordinator:** Wenn der Hauptkoordinator einer Gruppe 30 Tage lang nichts in der App getan hat, kann die Gruppe einen neuen wählen. Ihre **anderen Koordinatoren** stimmen ab — oder ihre **Mitglieder**, wenn keiner der anderen Koordinatoren bis zu dem Tag ernannt wurde, an dem die Leitung zuletzt aktiv war. Nur Personen, die an diesem Tag bereits dabei waren, nehmen teil: Mitglieder, die der Gruppe bis dahin beigetreten waren, oder Koordinatoren, die bis dahin ernannt wurden. Jeder, der danach beigetreten ist oder zum Koordinator ernannt wurde, kann weder vorschlagen noch vorgeschlagen werden noch abstimmen und wird nicht mitgezählt. Wenn du die Gruppe verlässt und ihr wieder beitrittst, zählst du ab deinem erneuten Beitritt. Wenn niemand mehr übrig ist, der damals dabei war, kann keine Abstimmung eröffnet werden, und der Bildschirm der Gruppe weist darauf hin. Jeder der Teilnehmenden kann jemanden aus ihrer Mitte vorschlagen, sich selbst eingeschlossen. Die Abstimmung läuft bis zu 14 Tage, geheim, mit Ja oder Nein. Sie wird angenommen, wenn mehr als die Hälfte der Antwortenden Ja sagt. Wenn die Leitung zurückkehrt und etwas in der App tut, wird die Abstimmung abgebrochen. Solange das Konto der Leitung suspendiert ist, zählt nichts von dem, was sie tut, als Rückkehr. Die gewählte Person wird Koordinator und Leitung der Gruppe. Die inaktive Leitung bleibt Koordinator, wenn die Koordinatoren abgestimmt haben, und wird zu einem einfachen Mitglied, wenn die Mitglieder abgestimmt haben. Du findest die Abstimmung auf dem Bildschirm der Gruppe über der Teilnehmerliste.
- **Ein abtrünniger Hauptkoordinator** kann durch eine Community-Entscheidung entfernt werden. Dies folgt in einem späteren Update.

## Bürgen

Nur Admins sowie Mitglieder, die von einem Admin oder durch eine Community-Entscheidung ausgewählt wurden, können für Neulinge bürgen. Eine Bürgschaft gibt dem Neuling einen kleinen Kreditrahmen für den Einstieg: 25, 50 oder 100 Bohnen. Vertrauensabzeichen verleihen dieses Recht niemals.
