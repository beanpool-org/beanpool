---
slug: recovery
title: Recuperare il tuo account
summary: Ripristina il tuo account su un nuovo telefono e proteggilo con un metodo di accesso collegato.
related: your-12-words, leaving-or-deleting, communities, faq, key-changed
help: Come recuperare l'account su un nuovo telefono: le 12 parole o un account di accesso collegato.
source-hash: c12dcedd3fb28fb7
---

## Su un nuovo telefono

La chiave del tuo account non è presente nei backup del telefono. Un nuovo telefono richiede le tue 12 parole o un account di accesso collegato in precedenza, anche per un iPhone ripristinato da un backup del precedente.

- Installa BeanPool e aprilo.
- Tocca **Fai già parte di BeanPool? Ripristina l'account**.
- Scegli **Recupera con 12 parole** o **Recupera con social**.

## Con le tue 12 parole

- Scrivi le 12 parole in ordine, oppure tocca **Incolla**.
- Sotto **Quale comunità?**, tocca **Comunità globale**, o una delle comunità precedentemente presenti su questo telefono. Per qualsiasi altra, tocca **un altro indirizzo** e digita il nome o l'indirizzo della tua comunità.
- Tocca **Recupera l'identità**. Il tuo nome e la foto verranno recuperati dalla tua comunità.

## Con un account di accesso

Funziona solo se ne avevi collegato uno in precedenza (vedi sotto) e solo mentre il server della tua comunità è in esecuzione.

- Scrivi il tuo nome nella comunità. L'app potrebbe suggerire "Sei tu?".
- Digita il nome o l'indirizzo della tua comunità.
- Tocca **Recupera con** e l'account che hai collegato: Google o Facebook, oppure Apple su un iPhone.
- Con Google su un iPhone, si apre una pagina web di Google. Accedi lì e scegli l'account collegato. Su Android, Google mostra il proprio elenco di account. Se non riesce a mostrarlo su quel telefono, si apre invece una pagina web di Google.

Se l'account di accesso è stato collegato da un telefono che conteneva le tue 12 parole, con una versione aggiornata dell'app, verranno ripristinate anche le tue 12 parole. Altrimenti il telefono non avrà le 12 parole: non possono essere ricostruite a partire da un accesso. Se le hai scritte su carta, puoi aggiungerle (vedi "Le tue 12 parole"). Fino ad allora un account di accesso collegato rappresenta l'unico modo per rientrare su quel telefono, quindi mantienine uno collegato e, se puoi, collegane un secondo (vedi sotto).

## Proteggere il tuo account adesso

- Apri **Impostazioni** e tocca **Protezione dell'account**.
- Sotto **Fornitori di recupero dell'accesso (1 su N)**, tocca **Proteggi con** e scegli un account.
- Supera il controllo della schermata di blocco del telefono. L'account collegato può ripristinare il tuo account, quindi l'app chiede prima conferma.
- Con Google su un iPhone, si apre una pagina web di Google. Accedi lì e scegli il tuo account per tornare in BeanPool.

Funziona anche su un telefono che non possiede le 12 parole.

Se ti sei unito alla comunità globale con le 12 parole, usa invece **Aggiungi un accesso**, in alto in **Protezione dell'account**. È anche questo un modo per rientrare ed elimina inoltre i limiti previsti per un nuovo account a 12 parole. Vedi "Le tue 12 parole".

Se questo telefono possiede le tue 12 parole, anche l'account collegato le conserva, quindi il ripristino con esso le restituirà. Un account collegato con una versione precedente dell'app conserva solo la tua chiave: tocca **Collega di nuovo** accanto ad esso e supera il controllo della schermata di blocco per includere le parole. Su un telefono senza le 12 parole non c'è nulla da includere, quindi **Collega di nuovo** non viene mostrato.

Questo non è un metodo per effettuare l'accesso abituale. Il tuo account è sempre la tua chiave personale. L'account collegato serve solo ad aiutarti a recuperarlo in quella comunità.

Per rimuoverlo, tocca **Disconnetti**.

## Se avevi collegato GitHub

BeanPool non supporta più GitHub. L'identificativo di un account GitHub è pubblico, pertanto una copia protetta con esso non era legata a qualcosa in tuo possesso esclusivo. Quando il server della tua comunità viene aggiornato, elimina ogni copia collegata a GitHub. Il tuo account in sé non viene toccato e le tue 12 parole continuano a funzionare.

- Se GitHub era l'unico account collegato e le tue 12 parole si trovano su questo telefono ma non sono scritte su carta, trascrivile subito (**Impostazioni**, poi **Visualizza frase di recupero**), oppure collega Google, Facebook o (su iPhone) Apple, come indicato sopra. Finché non esegui una di queste operazioni, questo telefono è l'unico modo per accedere al tuo account.
- Se le tue 12 parole sono trascritte su carta, non devi fare nulla. Se desideri anche un account di accesso, collega Google, Facebook o (su iPhone) Apple, come descritto sopra.
- Se GitHub era l'unico account collegato, questo telefono non possiede le 12 parole e non ne hai una copia scritta, collega subito Google, Facebook o (su iPhone) Apple. Finché non lo fai, questo telefono è l'unico modo per accedere al tuo account.

## Chi può aprire la copia

Un account di accesso collegato funziona perché il server della tua comunità conserva una copia protetta del tuo account appositamente per esso. Chi gestisce quel server può aprire questa copia, poiché il server verifica il tuo accesso. Nella comunità globale, chi la gestisce è BeanPool. Una copia rubata del database del server non può aprirla, una volta che il server è stato aggiornato per questo scopo. Chiunque prenda il controllo del tuo account di accesso può entrare anch'esso: vedi "Se qualcun altro ci prova".

Se preferisci che nessuno tranne te possa accedere, usa solo le tue 12 parole: conservale trascritte su carta e tocca **Disconnetti** accanto a ciascun account di accesso. La disconnessione elimina la copia. Un server di riserva, il secondo server che alcune comunità tengono pronto a subentrare, elimina la propria copia alla sincronizzazione successiva con il principale (circa una volta al minuto). La disconnessione non elimina le copie già presenti nei backup del server, né la copia che il server conserva, a titolo di registrazione, ogni volta che un accesso ripristina il tuo account. Anche chi gestisce il server può aprire quelle copie.

## Se qualcun altro ci prova

Se qualcuno avvia il recupero del tuo account, le Impostazioni mostrano **Qualcuno sta recuperando il tuo account** mentre la procedura è in corso. Se non sei tu, tocca **Ferma ora**: il server della tua comunità non fornirà più alcun dato a quel ripristino. Se riescono ad accedere con il tuo account di accesso collegato, riceverai un avviso che il tuo account è stato appena ripristinato su un altro dispositivo, e potrebbero essere già dentro quando lo vedrai. Mantieni al sicuro quell'account di accesso, con una password complessa dedicata.

## Se il telefono ha già un account

Il ripristino di un account diverso sostituisce quello presente su questo telefono, sia che tu lo ripristini con le 12 parole sia con un account di accesso. L'app chiede prima conferma in **Sostituire l'account di questo telefono?** (con un account di accesso, una volta effettuato l'accesso). Nulla cambia finché non scrivi **WIPE**, tocchi **Sostituisci account** e superi il controllo della schermata di blocco del telefono. Tocca **Mantieni**, poi il nome dell'account, **torna indietro** per lasciare tutto com'era.

Assicurati di possedere le 12 parole per l'account che stai sostituendo. Se questo telefono le possiede, quella schermata le mostra toccando **Mostra le 12 parole di** (nome dell'account) e superando il controllo della schermata di blocco. Se questo telefono non ha le 12 parole per quell'account (le Impostazioni lo segnalano), senza un account di accesso collegato non potrai più recuperarlo.

## Telefono e 12 parole persi

Senza le tue 12 parole e senza un account di accesso collegato, un amministratore della tua comunità può trasferire il tuo account su un nuovo telefono, con i tuoi Bean, il tuo nome e la tua cronologia. Incontralo di persona: verificherà prima la tua identità.

- L'amministratore genera un codice di rinnovo della chiave sul proprio schermo. Se il tuo vecchio telefono ha ancora l'app, riceverà la notifica che un amministratore ha iniziato a trasferire il tuo account.
- Sul tuo nuovo telefono, apri BeanPool, tocca **Fai già parte di BeanPool? Ripristina l'account**, poi **Un amministratore mi ha dato un codice per rinnovare la chiave**. Inquadra il QR sullo schermo dell'amministratore, oppure digita il codice (inizia con RK-) e il nome della tua comunità. In un browser, il link del codice QR apre la stessa schermata; oppure apri la web app della tua comunità, tocca **Sono già membro →**, poi **Un amministratore mi ha dato un codice per rinnovare la chiave** e scrivi il codice.
- Il telefono mostra un numero di due cifre e, sotto di esso, l'indirizzo della comunità interrogata. Mostra entrambi all'amministratore: inserirà il numero sul proprio schermo. Il numero garantisce che venga associato il tuo telefono e non quello di qualcun altro che ha visto il codice. **Non ora** interrompe la procedura del numero: il telefono mantiene la posizione e lo stesso codice mostrerà nuovamente lo stesso numero.
- Se il nuovo telefono non aveva un account BeanPool, mostrerà le 12 parole della tua **nuova** chiave. Trascrivile su carta: le tue vecchie parole non funzioneranno più e il vecchio telefono smetterà definitivamente di funzionare. Un telefono che conteneva già un account (per un'altra comunità) mantiene le 12 parole di quell'account, che ora ripristineranno anche questo account.
- Se avevi collegato un account di accesso, il telefono ti chiederà di collegarlo di nuovo in Protezione dell'account: quello precedente proteggeva la vecchia chiave, quindi è stato rimosso.
- Le persone con cui chatti vedranno che la tua chiave è cambiata. Di' loro che eri tu e leggi il tuo **Il mio codice chiave**, in **Impostazioni** sotto **Protezione dell'account** sul telefono. Vedi "Se una chat segnala che la chiave associata a un nome è cambiata".

Il codice dura 24 ore. Se l'amministratore dice che il tuo telefono non è quello verificato o se il codice scade, chiedine uno nuovo.
