---
slug: key-changed
title: Quando cambia una chiave o un nome
summary: Perché una chat smette di inviare, come verificare il codice con l'altra persona e quando proseguire.
related: messages, your-12-words, people
source-hash: c6be30fdc4888113
---

## Cosa significa

Ogni messaggio tra due persone è protetto in modo che solo il telefono dell'altra persona possa aprirlo. È protetto con la sua **chiave**, non con il suo nome. Il tuo telefono ricorda a quale chiave ha associato la protezione della vostra chat.

Se ora la tua comunità indica una chiave diversa per quella persona, il telefono si ferma e ti avvisa, anziché inviare silenziosamente alla nuova chiave. In cima alla chat vedi **La chiave di "Ben" è cambiata.** La casella del messaggio è disattivata in grigio e indica che l'invio è sospeso.

I tuoi messaggi precedenti con quella persona si leggono solitamente come prima. Su un telefono appena ripristinato o riconfigurato, i messaggi provenienti dalla nuova chiave riportano **Inviato con la nuova chiave. Verrà mostrato dopo aver continuato.** finché non decidi cosa fare.

Questo avviene nell'app per telefono. La web app non memorizza ancora le chiavi.

## Perché può accadere

- **Ha cambiato telefono e rinnovato la chiave.** Questo è il motivo consueto. La vecchia chiave non c'è più, quindi ne ha una nuova.
- **C'è un'anomalia.** Il server di una comunità elenca i partecipanti a ciascuna chat. Un server che volesse leggere i tuoi messaggi potrebbe associare la chiave di un terzo al nome del tuo amico. Il nome appare corretto, ma la chiave non lo è.

Il tuo telefono non è in grado di distinguere autonomamente questi due casi. Tu puoi farlo, grazie al codice chiave.

## Verificare il codice chiave con la persona

- Il banner mostra un codice: 20 cifre suddivise in cinque gruppi da quattro.
- Chiedi alla persona di aprire **Impostazioni**, poi **Protezione dell'account**, e di leggerti **Il mio codice chiave**.
- **Il mio codice chiave** si trova solo nell'app per telefono. Se la persona usa solo la web app, non può ancora leggertelo: tocca **Non ora** finché non potrà aprire l'app per telefono.
- Effettua la verifica **di persona o tramite telefonata o videochiamata**, dove hai la certezza che si tratti di lei. Non effettuare la verifica tramite un messaggio su BeanPool: se la chiave è errata, lo è anche chiunque risponda.
- Se ogni cifra corrisponde, spunta **Ho verificato con Ben: il codice chiave nelle sue Impostazioni corrisponde a questo**, poi tocca **Continua con la nuova chiave**.

Da quel momento i tuoi messaggi andranno alla nuova chiave. Il banner e l'etichetta **chiave cambiata** sulla chat in **Parla** scompariranno, e i tuoi messaggi precedenti rimarranno leggibili.

Il codice non è segreto. Puoi leggerlo a voce alta in tutta sicurezza.

## Se il codice non corrisponde o non puoi verificare

Tocca **Non ora**. Non viene inviato nulla e nulla cambia. Puoi tornare alla chat più tardi.

Una chat sospesa può rimanere tale finché non scegli di continuare. Non esiste altro modo per continuare a comunicare al suo interno: la tua comunità conserva un'unica chat per voi due, quindi avviare una nuova chat con la stessa persona apre questa medesima chat.

Se il codice non corrisponde, non continuare. Avvisa la persona e gli amministratori della tua comunità: qualcuno potrebbe tentare di leggere i tuoi messaggi.

## Se il banner non propone alcuna chiave con cui continuare

A volte la comunità non indica una singola chiave per la persona in una chat a due: ne indica diverse, oppure nessuna. In tal caso non c'è una chiave con cui proseguire, quindi il banner lo segnala e offre soltanto **Non ora**. Non viene inviato nulla. Parla con la persona di persona o per telefono. Il tuo telefono ricontrolla la chat da solo quando l'elenco della comunità cambia, e una nuova chat con la stessa persona è questa medesima chat.

## Se il banner indica che il telefono sta ricontrollando la chat dall'inizio

Dopo aver ripristinato il telefono dalle 12 parole, o dopo aver aggiornato l'app, il telefono controlla ciascuna chat confrontandola con i suoi messaggi precedenti. Se questi provenivano da una chiave diversa rispetto a quella che la comunità indica ora per la persona, il banner esordisce con: **Questo telefono sta ricontrollando questa chat dall'inizio, come avviene dopo il ripristino o l'aggiornamento dell'app.** Verifica il codice con la persona come sopra indicato. Dopo aver reimpostato la memoria chat della comunità, inizia invece con: **La memoria chat di questa comunità è stata reimpostata, quindi il telefono sta ricontrollando questa chat dall'inizio.**

## Memoria chat

Il tuo telefono conserva una piccola memoria per ciascuna comunità: con quale chiave si svolge ciascuna delle tue chat e quali chat sono private. È conservata sul telefono e il server della comunità non può spostare autonomamente una chat su un'altra chiave: solo tu puoi farlo, tramite il banner. Rimane sul telefono anche se ti disconnetti, quindi uscire e rientrare non la cancella. Il telefono non la reimposta mai di propria iniziativa.

Puoi reimpostarla per una singola comunità: apri **Impostazioni**, tocca **Memoria chat** sotto **ACCOUNT E IDENTITÀ**, tocca **Reimposta** accanto alla comunità, leggi l'avviso e tocca nuovamente **Reimposta**. L'app ti indirizza qui solo quando segnala di non essere riuscita a leggere quella memoria e riprovare non ha risolto il problema.

Dopo una reimpostazione, il telefono controlla di nuovo ogni chat di quella comunità dall'inizio, a partire dai messaggi conservati. Una chat i cui messaggi provenivano da una chiave diversa rispetto a quella attualmente indicata dalla comunità mostrerà nuovamente il banner, a partire da: **La memoria chat di questa comunità è stata reimpostata, quindi il telefono sta ricontrollando questa chat dall'inizio.** Verifica il codice con la persona come sopra.

Due elementi possono cambiare dopo una reimpostazione, e l'avviso te lo ricorda prima di confermare: una chat sospesa per cambio di chiave potrebbe aprirsi con la nuova chiave, e una chat privata scomparsa da Parla potrebbe tornare come chat di gruppo leggibile dalla comunità. Controlla il codice chiave, o chi partecipa alla chat, prima di inviare messaggi.

Una reimpostazione non aiuta se il telefono non riesce ad associare la chat a un'unica chiave: viene controllata di nuovo e si ferma di nuovo. Verifica invece il codice con la persona (come descritto sopra).

Questo avviene nell'app per telefono. La web app non ha alcuna memoria chat.

## Se il banner indica che il telefono non riesce ad associare la chat a una sola chiave

A volte i messaggi precedenti in una chat erano protetti con chiavi che il tuo telefono non riesce ad associare a una sola persona. Sopra la casella di testo viene indicato: **Questo telefono non riesce ad associare questa chat a una sola chiave, quindi l'invio è disattivato.** e il banner mostra il codice della chiave che la tua comunità indica ora per quella persona.

Alcuni messaggi potrebbero comunque essere visibili. Potrebbero non provenire dalla persona il cui nome figura sulla chat: i suoi stessi messaggi precedenti possono essere quelli che indicano **Impossibile verificare questo messaggio, quindi non viene mostrato.** Tali messaggi rimangono in quello stato, anche dopo aver proseguito.

Verifica il codice con la persona come descritto sopra, di persona o tramite chiamata. Se corrisponde, spunta la casella e tocca **Continua con la nuova chiave**: da quel momento i tuoi messaggi andranno a quella chiave. Se non corrisponde, o non puoi verificarlo, tocca **Non ora**. Una nuova chat con la stessa persona corrisponde a questa stessa chat, quindi non c'è nient'altro da tentare. Se la comunità non elenca alcuna chiave singola per la persona, il banner propone solo **Non ora**, e il telefono ricontrollerà la chat da solo quando l'elenco della comunità cambierà.

## Cosa può verificare il telefono e cosa no

Il telefono controlla una chat rispetto ai messaggi che già conserva. Un telefono ripristinato, o un telefono esistente al momento dell'aggiornamento, viene guidato solo da un server che trattiene o manipola la parte più vecchia della chat in ciò che invia. Un telefono che conteneva già quella parte più vecchia non viene influenzato da nulla che il server invii dopo l'aggiornamento.

Di conseguenza, un telefono appena ripristinato o appena aggiornato può essere indotto in errore sulla chiave di una chat. Il banner non può escluderlo del tutto. **Conferma una chiave modificata di persona**, o tramite una chiamata in cui hai la certezza che si tratti di lei.

## Se la comunità fornisce una data

Quando la tua comunità può dimostrare che l'account ha rinnovato la chiave, il banner lo segnala, ad esempio: **Questa comunità segnala che l'account ha rinnovato la chiave il 3 ott 2026.** Questo ti aiuta a comprendere cosa è accaduto, ma non sostituisce la verifica del codice: anche un server potrebbe affermarlo.
