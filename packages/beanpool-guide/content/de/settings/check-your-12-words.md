---
slug: check-your-12-words
title: Deine 12 Wörter und der Server
summary: Für Eigentümer einer Community: 12 Wörter prüfen, den Server mit dem Handy übernehmen oder wiederherstellen, und automatische Handy-Checks.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## Für wen dies gedacht ist

Ausschließlich für die **Eigentümer** einer Community. Wenn du kein Eigentümer bist, siehst du davon nichts.

## Warum Eigentümer darum gebeten werden

Der Server deiner Community bewahrt eine gesperrte Kopie seiner Schlüssel auf, um die Community auf einen anderen Server umziehen zu können, falls der eigene verloren geht, und auch seine Datensicherungen sind gesperrt. Sie sind an die Konten der Eigentümer gekoppelt: Jeder einzelne Eigentümer kann sie mit seinem Smartphone öffnen (siehe unten „Mit deinem Smartphone übernehmen oder wiederherstellen“). Wenn du dein Smartphone verlierst, bringen deine 12 Wörter dein Konto zurück und damit auch deinen Schlüssel zum Schloss des Servers und dessen Datensicherungen. Das zählt besonders an dem Tag, an dem der Server selbst verloren gegangen ist.

Deshalb bittet die App jeden Eigentümer von Zeit zu Zeit zu prüfen, ob er noch die richtigen 12 Wörter besitzt. Die 12 Wörter sind englische Wörter. Du kannst auf **Später** tippen. Es wird niemals etwas blockiert, und du kannst weiterhin alles tun, was ein Eigentümer tut.

## Wann die App nachfragt

- Einmal kurz nachdem du Eigentümer wirst.
- Erneut 12 Monate nach deiner letzten Überprüfung.

Sie zeigt eine Karte oben im Markt an (in der Web-App oben auf jedem Bildschirm außer der Karte): **Jetzt überprüfen** oder **Später**. **Später** blendet die Karte aus, bis die Prüfung das nächste Mal fällig ist. Du kannst die Prüfung jederzeit über die **Einstellungen** durchführen: Tippe unter **Community-Schlüssel** auf **Überprüfe deine 12 Wörter** (in der Web-App auf **Jetzt überprüfen**).

## Wie du prüfst

- Hole dein Papier mit den 12 Wörtern (es sind englische Wörter).
- Tippe sie der Reihe nach ein, mit Leerzeichen dazwischen. Groß-/Kleinschreibung und zusätzliche Leerzeichen spielen keine Rolle.
- Tippe auf **Meine Wörter prüfen**.

Wenn sie stimmen, meldet die App: **Dies sind die richtigen Wörter.** Wenn nicht: **Dies sind nicht die Wörter für dieses Konto.** Sie sagt nicht, welches Wort falsch ist; prüfe also das Papier und tippe alle Wörter noch einmal ein.

Auf einem Smartphone ohne gespeicherte Kopie deiner 12 Wörter (ein Smartphone, das über ein Anmeldekonto wiederhergestellt wurde) blenden die richtigen Wörter zusätzlich **Auf diesem Telefon speichern** ein. Tippe darauf, und **12 Wörter anzeigen** zeigt sie von da an an. Dies ist dieselbe Überprüfung und dasselbe Speichern wie bei **Füge deine 12 Wörter diesem Telefon hinzu** (siehe „Deine 12 Wörter“).

Kannst du sie nicht finden? Wenn dieses Smartphone sie noch hat, zeigt **Einstellungen** und dann **12 Wörter anzeigen** sie an. Schreibe sie erneut auf und führe dann die Überprüfung durch. Auf einem Smartphone ohne gespeicherte Kopie weist die App darauf hin: Wenn du sie findest, überprüfe sie hier und speichere sie anschließend.

## Was gesendet wird und was nicht

- Die Überprüfung findet auf deinem Smartphone statt (oder in deinem Browser, in der Web-App). Deine Wörter werden niemals irgendwohin gesendet. Das Eingabefeld wird geleert, sobald das Ergebnis vorliegt und wenn du den Bildschirm verlässt. Sie werden nur gespeichert, wenn du auf **Auf diesem Telefon speichern** tippst, und dann ausschließlich auf diesem Smartphone.
- Stimmen die Wörter, teilt dein Smartphone dem Server deiner Community lediglich mit, dass du die Überprüfung durchgeführt hast und wann, signiert mit deinem Konto.
- Eigentümer und Admins sehen in den Server-Einstellungen das Datum der Überprüfung jedes Eigentümers oder „noch nicht“. Es ist deine eigene Angabe: Der Server kann deine Wörter weder sehen noch überprüfen.

## Mit deinem Smartphone übernehmen oder wiederherstellen

Geht der Server deiner Community verloren, kann derjenige, der den Standby-Server betreibt (oder einen neuen Server, der eine Sicherung wiederherstellt), einen Eigentümer bitten, die gesperrten Schlüssel zu öffnen. Ein einziger Eigentümer reicht aus. Du benötigst die neueste Version der BeanPool-App. Die Web-App funktioniert ebenfalls, sofern sie sich noch öffnen lässt, allerdings liegt sie unter der eigenen Adresse deiner Community, die zusammen mit dem Server ausgefallen sein könnte: Die Smartphone-App ist diejenige, auf die Verlass ist.

- In den Einstellungen des Servers wählen sie **Als Hauptserver übernehmen** und dann **Ich verstehe: Smartphone eines Eigentümers nutzen**, oder beim Wiederherstellen einer Datensicherung **Mit dem Smartphone eines Eigentümers öffnen**. Ein Code erscheint auf ihrem Bildschirm.
- In der App: Öffne die **Einstellungen**, tippe unter **Community-Schlüssel** auf **Mit diesem Telefon übernehmen oder wiederherstellen** und richte die Kamera auf den Code. Wenn die Seite des Servers auf deinem eigenen Smartphone geöffnet ist, bewirkt das Antippen des Links dasselbe. In der Web-App kopiere den Link von deren Bildschirm und füge ihn unter **Mit diesem Browser übernehmen oder wiederherstellen** in den **Einstellungen** ein.
- Die App zeigt an, um welche Community und welchen Server es sich handelt und was passieren wird. Antwortet dein Hauptserver noch, wird dies in Rot angezeigt: Eine Übernahme ist nur für einen Server gedacht, der wirklich verloren ist.
- Tippe auf **Für die Übernahme entsperren** (oder **Sicherung entsperren**). Dein Smartphone verlangt zuerst seine eigene Entsperrung: Fingerabdruck, Gesichtserkennung oder PIN. Die Web-App hat keinen solchen Schritt, weshalb die Smartphone-App der sicherere Ort für den Schlüssel eines Eigentümers ist.
- Dein Smartphone öffnet seinen Teil des Schlosses und übergibt den Schlüssel an diesen Server, so verschlüsselt, dass nur dieser Server ihn lesen kann. Dein Smartphone bekommt die Schlüssel des Servers oder die Datensicherung niemals zu sehen.
- Bei einer Übernahme bestätigt die Person am Server den Vorgang anschließend auf ihrem Bildschirm. Die Community wird darüber informiert, dass sie umgezogen ist und dass du die Schlüssel geöffnet hast.

Die App verweigert den Vorgang und nennt den Grund, wenn das Schloss zu einer anderen Community gehört, wenn es nicht für dich gesperrt ist, wenn der Code des Servers abgelaufen ist (er ist 10 Minuten lang gültig und funktioniert einmal) oder wenn die Schlüssel nicht vom eigenen Server deiner Community gesperrt wurden.

## Dein Smartphone überprüft das Schloss selbstständig

Jedes Mal, wenn sich das Schloss deiner Community ändert (ein Eigentümer wird hinzugefügt oder entfernt, ein neuer Wiederherstellungscode wird erstellt), überprüft deine App im Hintergrund, ob sie ihren Teil noch öffnen könnte. Sie öffnet ihn, verwirft den Schlüssel sofort wieder und meldet dem Server, ob es funktioniert hat. Von dir wird dabei nichts verlangt.

Eigentümer und Admins sehen dies in den Server-Einstellungen neben dem Datum deiner 12 Wörter: **Ihr Telefon hat das aktuelle Schloss geöffnet** mit Datum, oder dass es zuletzt ein älteres geöffnet hat. Wenn dort steht, dass dein Telefon das Schloss **NICHT öffnen konnte**, überprüfe deine 12 Wörter und bitte einen anderen Eigentümer, in die Server-Einstellungen zu schauen.
