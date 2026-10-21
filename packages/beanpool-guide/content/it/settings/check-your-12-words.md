---
slug: check-your-12-words
title: Le 12 parole e le chiavi del server (proprietari)
summary: Per i proprietari della comunità. Verificare le 12 parole, prendere il controllo o ripristinare il server dal telefono e la verifica automatica del telefono.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## A chi è rivolto

Solo ai **proprietari** di una comunità. Se non sei un proprietario, non vedrai nulla di tutto questo.

## Perché viene chiesto ai proprietari

Il server della tua comunità conserva una copia bloccata delle sue chiavi, per trasferire la comunità su un altro server se il proprio viene perso, e anche i suoi backup sono bloccati. Sono bloccati sugli account dei proprietari: un qualsiasi proprietario può aprirli con il proprio telefono (vedi Prendere il controllo o ripristinare con il telefono, sotto). Se perdi il telefono, le tue 12 parole ripristinano il tuo account, e con esso la tua chiave per la serratura del server e per i suoi backup. Questo conta soprattutto il giorno in cui il server stesso non c'è più.

Quindi l'app chiede a ciascun proprietario, ogni tanto, di verificare di avere ancora le 12 parole corrette. Puoi scegliere **Più tardi**. Nulla viene mai bloccato, e puoi continuare a fare tutto ciò che fa un proprietario.

## Quando lo chiede l'app

- Una volta, poco dopo essere diventato proprietario.
- Di nuovo 12 mesi dopo l'ultima verifica.

Mostra una scheda nella parte superiore del Mercato (nella web app, in cima a ogni schermata tranne la Mappa): **Verifica ora** o **Più tardi**. **Più tardi** mette via la scheda fino alla prossima scadenza. Puoi effettuare la verifica in qualsiasi momento da **Impostazioni**: sotto **CHIAVI DELLA COMUNITÀ**, tocca **Verifica le tue 12 parole** (nella web app, **Verifica ora**).

## Come verificare

- Prendi il tuo foglio con le 12 parole.
- Scrivile in ordine, separate da spazi. Le maiuscole e gli spazi extra non contano.
- Tocca **Verifica le mie parole**.

Se sono corrette, l'app dice **Queste sono le parole corrette.** Se no: **Queste non sono le parole per questo account.** Non dice quale parola sia errata, quindi controlla il foglio e riscrivile tutte.

Su un telefono senza una copia delle tue 12 parole (uno ripristinato con un account di accesso), le parole corrette mostrano anche **Salvale su questo telefono**. Toccalo e **Visualizza frase di recupero** le mostrerà da quel momento in poi. È la stessa verifica e lo stesso salvataggio di **Aggiungi le tue 12 parole a questo telefono** (vedi "Le tue 12 parole").

Non riesci a trovarle? Se questo telefono le possiede ancora, **Impostazioni**, poi **Visualizza frase di recupero**, le mostra. Riscrivile di nuovo su carta, poi fai la verifica. Su un telefono senza una copia, l'app lo segnala: quando le trovi, verificale qui, poi salvale.

## Cosa viene inviato e cosa no

- La verifica avviene sul tuo telefono (o nel tuo browser, nella web app). Le tue parole non vengono mai inviate da nessuna parte. Il campo viene svuotato non appena la verifica risponde, e quando lasci la schermata. Vengono salvate solo se tocchi **Salvale su questo telefono**, e in tal caso solo su questo telefono.
- Quando le parole sono corrette, il tuo telefono comunica al server della tua comunità solo che hai effettuato la verifica e quando, con la firma del tuo account.
- I proprietari e gli amministratori vedono, nelle Impostazioni del server, la data di "12 parole verificate" di ciascun proprietario, oppure "non ancora". È una tua dichiarazione: il server non può vedere né verificare le tue parole.

## Prendere il controllo o ripristinare con il telefono

Se il server della tua comunità va perso, chiunque gestisca il server di riserva (o un nuovo server che ripristina un backup) può chiedere a un proprietario di aprire le chiavi bloccate. Un qualsiasi proprietario è sufficiente. È necessaria la versione più recente dell'app BeanPool. Anche la web app funziona se si apre ancora, ma risiede all'indirizzo della tua comunità, che potrebbe non essere raggiungibile insieme al server: l'app per telefono è quella su cui fare affidamento.

- Nelle Impostazioni del server, scelgono **Take over as the main server**, poi **I understand: use an owner's phone**, o **Open with an owner's phone** durante il ripristino di un backup. Sul loro schermo appare un codice.
- Nell'app: **Impostazioni**, sotto **CHIAVI DELLA COMUNITÀ**, tocca **Prendi il controllo o ripristina con questo telefono**, e inquadra il codice con la fotocamera. Se la pagina del server è aperta sul tuo stesso telefono, toccare il suo link produce lo stesso effetto. Nella web app, copia il link dal loro schermo e incollalo sotto **Prendi il controllo o ripristina con questo browser** in **Impostazioni**.
- L'app mostra quale comunità, quale server e cosa accadrà. Se il tuo server principale risponde ancora, lo segnala in rosso: un passaggio di controllo serve solo per un server che è davvero perso.
- Tocca **Sblocca per prendere il controllo** (o **Sblocca il backup**). Il telefono richiede prima il proprio sblocco: impronta digitale, volto o PIN. La web app non ha questo passaggio, ed è per questo che l'app per telefono è il luogo più sicuro per la chiave di un proprietario.
- Il tuo telefono apre la propria parte della serratura e consegna la chiave a quel server, bloccata in modo che solo quel server possa leggerla. Il tuo telefono non vede mai le chiavi del server né il backup.
- In un passaggio di controllo, la persona al server conferma quindi sul proprio schermo. La comunità viene informata del trasferimento e del fatto che hai aperto le chiavi.

L'app rifiuta, e spiega il motivo, se il blocco appartiene a un'altra comunità, se non è bloccato per te, se il codice del server è scaduto (dura 10 minuti e funziona una sola volta), o se le chiavi non sono state bloccate dal server della tua comunità.

## Il telefono verifica la serratura da solo

Ogni volta che il blocco della tua comunità cambia (un proprietario viene aggiunto o rimosso, viene creato un nuovo codice di recupero), la tua app verifica, silenziosamente, se potrebbe ancora aprire la sua parte. La apre, getta via la chiave immediatamente e riferisce al server se ha funzionato. Non ti viene chiesto nulla.

I proprietari e gli amministratori lo vedono nelle Impostazioni del server, accanto alla data delle tue 12 parole: **their phone opened the current lock**, con la data, o che ha aperto l'ultima volta una versione precedente. Se dice che il tuo telefono **could NOT open** la serratura, verifica le tue 12 parole e chiedi a un altro proprietario di controllare le Impostazioni del server.
