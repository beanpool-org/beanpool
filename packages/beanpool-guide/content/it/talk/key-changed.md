---
slug: key-changed
title: Quando cambia una chiave o un nome
summary: Cosa significa la riga grigia su una chiave cambiata, come verificare un codice chiave con la persona e a cosa serve Segna come verificato.
related: messages, your-12-words, people
source-hash: d4dfaf863af532c6
---

## Cosa significa

Ogni messaggio tra due persone è protetto in modo che solo il telefono dell'altra persona possa aprirlo. È protetto con la sua **chiave**, non con il suo nome. La tua comunità indica quale chiave appartiene alla persona, e il tuo telefono ricorda con quale chiave ha protetto la vostra chat.

Quando la tua comunità indica una nuova chiave per la persona, ciò che fa il tuo telefono dipende da una sola cosa: se l'hai segnata come verificata su questo telefono.

## Una persona che non hai segnato come verificata

La chat prosegue con la nuova chiave. Il tuo telefono scrive una riga grigia nella chat, per esempio: **La chiave di Ben è cambiata. Di solito vuol dire che ha recuperato il proprio account su un nuovo telefono. Tocca per vedere il suo codice chiave.**

Niente viene sospeso, la chat non riceve nessuna etichetta in **Chat**, e i tuoi messaggi precedenti restano leggibili. La riga serve a informarti, non a metterti in allarme. Toccala per vedere il suo codice chiave.

## Perché una chiave può cambiare

- **Ha recuperato il proprio account su un nuovo telefono.** Questo è il motivo consueto. Un amministratore ha spostato il suo account sul nuovo telefono, quindi ha una nuova chiave.
- **C'è un'anomalia.** Il server di una comunità elenca i partecipanti a ciascuna chat. Un server che volesse leggere i tuoi messaggi potrebbe associare la chiave di un terzo al nome del tuo amico. Il nome appare corretto, ma la chiave non lo è.

Il tuo telefono non è in grado di distinguere da solo questi due casi. Tu puoi farlo, grazie al codice chiave.

## Verificare il codice chiave di una persona

- Nella chat, tocca **⋯** in alto, poi **Codice chiave**. Si apre anche toccando la riga grigia.
- Vedi il suo codice chiave: 20 cifre suddivise in cinque gruppi da quattro.
- Chiedi alla persona di leggerti **Il mio codice chiave**. Nell'app per telefono si trova in **Impostazioni**, sotto **Protezione dell'account**. Nella web app si trova in **Impostazioni**, sotto **ACCOUNT E IDENTITÀ**.
- Effettua la verifica **di persona o tramite telefonata o videochiamata**, dove hai la certezza che si tratti di lei. Non effettuare la verifica tramite un messaggio su BeanPool: se la chiave è errata, lo è anche chiunque risponda.
- Se ogni cifra corrisponde, questa chat è davvero con lei. Puoi allora toccare **Segna come verificato**.

Il codice non è segreto. Puoi leggerlo a voce alta in tutta sicurezza.

## Segna come verificato

**Segna come verificato** fa sì che il tuo telefono ti chieda conferma prima di inviare a una nuova chiave di questa persona. La schermata del codice chiave mostra poi **Verificato ✓**, e così anche la parte alta della chat, accanto a **🔒 Crittografia end-to-end** sotto il suo nome.

Il segno è conservato solo su questo telefono, per questa chat in questa comunità. La web app non lo ha, e reimpostare la memoria chat della comunità (vedi sotto) lo rimuove.

Per annullarlo, apri di nuovo **Codice chiave**, tocca **Rimuovi verifica** e conferma con **Rimuovi verifica**.

## Se cambia la chiave di una persona che hai segnato come verificata

Il tuo telefono si ferma e ti chiede cosa fare, anziché inviare alla nuova chiave. In cima alla chat vedi **La chiave di "Ben" è cambiata.** Il banner inizia con **Hai segnato Ben come persona verificata, quindi questo telefono chiede prima di inviare a una nuova chiave.** e mostra il nuovo codice chiave.

La casella del messaggio è disattivata in grigio, e sopra c'è scritto **La chiave di Ben è cambiata, quindi l'invio è sospeso.** Un messaggio dalla nuova chiave riporta **Inviato con la nuova chiave. Verrà mostrato dopo aver continuato.** finché non decidi. La chat mostra l'etichetta **chiave cambiata** in **Chat**.

Verifica il nuovo codice con la persona, come sopra. Se ogni cifra corrisponde, spunta **Ho verificato con Ben: il codice chiave nelle sue Impostazioni corrisponde a questo.**, poi tocca **Continua con la nuova chiave**. Da quel momento i tuoi messaggi vanno alla nuova chiave, Ben resta **Verificato ✓**, il banner e l'etichetta scompaiono, e i tuoi messaggi precedenti restano leggibili.

Se il codice non corrisponde, o non puoi verificarlo, tocca **Non ora**. Non viene inviato nulla e nulla cambia. La chat resta sospesa finché non continui: la tua comunità conserva un'unica chat per voi due, quindi avviare una nuova chat con la stessa persona apre questa stessa chat.

Se il codice non corrisponde, non continuare. Avvisa la persona e gli amministratori della tua comunità: qualcuno potrebbe tentare di leggere i tuoi messaggi.

Nella schermata del codice chiave, anche **Rimuovi verifica** mette fine alla sospensione: la chat prosegue con la nuova chiave, senza la verifica.

## Se la comunità fornisce una data

Quando la tua comunità può dimostrare che l'account ha rinnovato la chiave, il banner lo segnala, ad esempio: **Questa comunità segnala che l'account ha rinnovato la chiave il 3 ott 2026.** Questo ti aiuta a capire cosa è accaduto, ma non sostituisce la verifica del codice: anche un server potrebbe affermarlo.

## Se non c'è una chiave con cui proseguire

A volte la comunità non indica una singola chiave per la persona in una chat a due: ne indica diverse, oppure nessuna. In tal caso non c'è nessuno per cui proteggere i tuoi messaggi, che tu l'abbia segnata come verificata o no. Il banner lo segnala e offre soltanto **Non ora**, non viene inviato nulla, e la chat mostra l'etichetta **chiave cambiata** in **Chat**. La schermata del codice chiave dice **Questa comunità non elenca una chiave univoca per Ben in questa chat, quindi l'invio resta in attesa.**

Parla con la persona di persona o per telefono. Il tuo telefono ricontrolla la chat da solo quando l'elenco della comunità cambia, e una nuova chat con la stessa persona è questa stessa chat.

Se il tuo telefono non è riuscito ad associare nemmeno i messaggi precedenti a una sola chiave, sopra la casella del messaggio c'è scritto **Questo telefono non riesce ad associare questa chat a una sola chiave, quindi l'invio è disattivato. Ciò che leggi qui potrebbe non provenire dall'altra persona.**, e la schermata del codice chiave non ha nessun codice da mostrare.

## Dopo aver ripristinato o riconfigurato il telefono

Il tuo telefono controlla ciascuna chat confrontandola con i messaggi precedenti che conserva. Se quei messaggi provenivano da una chiave più vecchia di quella che la tua comunità indica ora, la chat prosegue con la chiave indicata, i messaggi precedenti restano leggibili e la riga grigia compare una volta.

Se il tuo telefono non riesce ad associare alcuni di essi a nessuna chiave, la chat prosegue comunque con la chiave indicata dalla tua comunità, senza alcuna riga. Un messaggio che non è riuscito ad aprire riporta **Impossibile verificare questo messaggio, quindi non viene mostrato.** Resta così.

## Memoria chat

Il tuo telefono conserva una piccola memoria per ciascuna comunità: con quale chiave si svolge ciascuna delle tue chat, chi hai segnato come verificato e quali chat sono private. È conservata sul telefono. Rimane sul telefono anche se ti disconnetti, quindi uscire e rientrare non la cancella. Il telefono non la reimposta mai di propria iniziativa.

Puoi reimpostarla per una singola comunità: apri **Impostazioni**, tocca **Memoria chat** sotto **ACCOUNT E IDENTITÀ**, tocca **Reimposta** accanto alla comunità, leggi l'avviso e tocca nuovamente **Reimposta**. L'app ti indirizza qui solo quando segnala di non essere riuscita a leggere quella memoria e riprovare non ha risolto il problema.

Dopo una reimpostazione, il telefono controlla di nuovo ogni chat di quella comunità dall'inizio, a partire dai messaggi conservati, come fa dopo un ripristino.

L'avviso dice cosa può cambiare prima che tu confermi. Una chat sospesa per cambio di chiave potrebbe aprirsi con la nuova chiave. Una chat privata scomparsa da Chat potrebbe tornare come chat di gruppo leggibile dalla comunità. Le persone che hai segnato come verificate in questa comunità tornano a non essere verificate. Controlla il codice chiave, o chi partecipa alla chat, prima di inviare messaggi.

Questo avviene nell'app per telefono. La web app non ha alcuna memoria chat.

## Nella web app

La web app non memorizza le chiavi. Ogni volta che invii, protegge il tuo messaggio con l'unica chiave che la tua comunità indica per la persona, e se ne indica diverse o nessuna, il tuo messaggio non viene inviato. Per questo non mostra nessuna riga grigia né alcun banner, e non ha **Segna come verificato**: una persona che hai segnato come verificata sul telefono non ha nessuna sospensione nella web app.

Puoi comunque leggere lì i codici chiave. **Il mio codice chiave** si trova in **Impostazioni**, sotto **ACCOUNT E IDENTITÀ**. In una chat a due, il menu **⋮** contiene **Codice chiave**: mostra il codice della persona e dice che il browser non memorizza i codici chiave.

## Cosa può verificare il telefono e cosa no

Per una persona che non hai segnato come verificata, l'elenco della tua comunità decide la chiave ogni volta che cambia, e il tuo telefono te lo dice con la riga grigia. Su un telefono che conteneva già la chat, una chiave cambiata lascia sempre la riga. Un telefono appena ripristinato può essere ingannato: un server che trattiene i messaggi più vecchi non lascia alcuna riga.

La riga non sa distinguere un nuovo telefono da una chiave scambiata. Solo il codice chiave può farlo, e solo **Segna come verificato** fa fermare il tuo telefono la volta successiva. Se una chat è importante per te, verifica il codice di persona, o con una chiamata in cui hai la certezza che si tratti di lei, e poi segna la persona come verificata.
