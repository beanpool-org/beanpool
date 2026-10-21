---
slug: what-the-admins-can-see
title: Cosa possono vedere gli admin
summary: In una comunità i cui admin tengono una lista nomi: cosa contiene su di te, chi può leggerla, cosa conserva il server e cosa significa essere confermati.
related: privacy, joining, leaving-or-deleting, admins-ai-assistants
source-hash: 88d60b236e7653ab
---

## La lista nomi

Gli amministratori di alcune comunità tengono una **lista nomi**: chi sono i membri, con il loro vero nome, nello stesso modo in cui un comitato LETS tiene un registro dei soci. Non tutte le comunità ne tengono una. Chiedi ai tuoi amministratori se la tua lo fa.

Una voce contiene il tuo nome e, a volte, una breve nota scritta da un amministratore, come il modo in cui la comunità ti conosce. Nient'altro: nessun indirizzo, nessuna data di nascita, nessun numero di documento.

## Chi può leggerla

**Solo i proprietari e gli amministratori della tua comunità, sui propri telefoni.** Il tuo nome viene sigillato sul telefono di un amministratore prima di essere inviato al server della tua comunità. Il server conserva testo cifrato: un backup, una copia, BeanPool o chiunque sottragga il database non possiede nulla di leggibile.

Chiunque gestisca il server non può leggerlo. I telefoni degli amministratori forniscono le chiavi dell'elenco solo agli amministratori i cui telefoni sono stati verificati da un altro amministratore, tramite chiamata o di persona, e ricevono nuove chiavi solo da loro. Questo poggia sulla responsabilità degli amministratori: un amministratore che verifica il telefono della persona sbagliata, un telefono di un amministratore a cui qualcuno accede, o un telefono smarrito prima che gli amministratori ne revochino la chiave, possono consentire a terzi di leggere i nomi. Lo stesso può accadere se il telefono di un amministratore non viene informato dai gestori del server che un amministratore è stato rimosso: finché non lo apprende, ciò che scrive può essere letto con le chiavi in possesso dell'amministratore rimosso. Un amministratore il cui telefono mostra ancora l'amministratore rimosso ne elimina manualmente la chiave, e quel telefono genera una nuova chiave senza di esso o non scrive nulla.

**Gli altri membri non vedono i nomi.** Vedono il tuo nome BeanPool, come sempre.

Un amministratore può creare una copia PDF della lista sul proprio telefono, per sicurezza. Una volta creata, spetta a lui custodirla al sicuro, come una lista cartacea. Ogni volta che la lista viene aperta o copiata, gli altri amministratori possono vedere chi lo ha fatto e quando.

## Essere confermati

Un amministratore può **confermarti**: attesta che il tuo account corrisponde alla persona indicata nella voce. Solo chi ti conosce dovrebbe farlo, e in alcune comunità devono concordare due amministratori.

- Una conferma non riporta alcun nome. Il server registra quale account, quale voce e quale amministratore, mai chi sei.
- Non è uno stemma di fiducia. Ti dà anche subito una linea di credito, la soglia nota, a meno che il proprietario della tua comunità non l'abbia disattivata: vedi "Linea di credito".
- Se un amministratore ti ha invitato per nome, unirti con il suo invito ti ha confermato a fronte della tua voce, da parte di quell'amministratore. "Confermato" significa solo che un amministratore attesta che questo account è la persona indicata in quella voce.
- Se sostituisci un telefono smarrito e il tuo account passa a una nuova chiave, la tua conferma si trasferisce con esso.
- Se lasci o elimini il tuo account, la conferma termina. La tua voce rimane nell'elenco degli amministratori finché un amministratore non la cancella: chiedi loro di farlo.
- Se sei confermato e lasci, vieni rimosso o elimini il tuo account mentre sei a debito di fagioli, i Beni comuni coprono il debito come sempre. L'elenco degli amministratori conserva anche una nota sulla tua voce che indica quanto dovevi, perché e quando, per 3 anni, e gli amministratori la vedono accanto al tuo nome sui propri telefoni. Nessuno può essere confermato a fronte di quella voce finché il debito non viene rimborsato, compensato con lavoro o condonato.

## Cosa la lista nomi non mostra agli amministratori

La lista contiene nomi e note, e quale account appartiene a chi. A parte la nota sopra indicata su un debito lasciato insoluto, non mostra a nessuno il tuo saldo o i tuoi scambi (un amministratore può vedere il tuo saldo nei casi sotto descritti, e alcuni dei tuoi scambi: vedi in fondo a questa pagina). Vedi "La tua privacy" per ciò che membri e amministratori possono vedere altrimenti.

## A cosa acconsenti in una comunità conosciuta

Una comunità che conferma i propri membri, una **comunità conosciuta**, funziona come ha sempre fatto un sistema LETS: gli amministratori controllano i debiti che crescono troppo o rimangono insoluti troppo a lungo. Quando ti unisci a una di esse, la schermata di adesione indica con esattezza le soglie numeriche della tua comunità, ad esempio:

"In questa comunità, gli amministratori possono vedere il tuo saldo se supera il 50% della tua linea di credito o se rimani in debito per 60 giorni senza alcuna vendita. È così che ha sempre funzionato un sistema LETS. Ogni volta che un amministratore apre l'elenco dei membri che superano tali soglie, e ogni volta che un amministratore consulta il tuo saldo durante la tua rimozione, l'operazione viene registrata. In una votazione per la tua rimozione, tutti coloro che hanno diritto di voto vedono il tuo saldo e l'eventuale debito, esclusivamente in quella votazione, e tali consultazioni non vengono registrate. Puoi revocare questo consenso in qualsiasi momento nelle Impostazioni. Qualunque sia la tua scelta, ogni amministratore può vedere alcuni dei tuoi scambi: uno scambio non ancora concluso o risolto da un amministratore (con chi, l'annuncio, il prezzo e la chat individuale con l'altra persona, che non possono leggere se è privata), affinché uno scambio bloccato possa essere risolto; uno scambio i cui Bean sono rimasti bloccati quando un membro è stato rimosso su un server precedente (lo stato dello scambio, l'annuncio, il prezzo, le date, i Bean rimasti bloccati, quanti pagamenti vi sono transitati, l'importo e la nota dell'ultimo); un avviso di frode che ti nomina se tu e un altro membro acquistate l'uno dall'altro a vicenda, in modo approssimativamente paritario, oltre una soglia, con il totale dei Bean e l'equilibrio dei flussi nelle due direzioni; uno che ti nomina, con il totale dei Bean e quanti dei membri da te invitati hanno scambiato solo con te, se i membri da te invitati ti inviano Bean oltre una soglia entro un determinato numero di giorni, o se sei uno di quei membri; uno che ti nomina, indicando quanta parte degli scambi del gruppo avviene tra i membri stessi ma senza mostrare i Bean, se fai parte di un gruppo di membri, per almeno la metà nuovi, che scambiano prevalentemente tra loro; e un avviso che ti nomina se nessun Bean è entrato o uscito dal tuo account per un determinato numero di giorni. Ogni consultazione di uno di questi scambi viene registrata, con chi ha guardato, quando e quali scambi; la consultazione degli avvisi che ti nominano viene registrata la prima volta che ciascun amministratore li apre, e di nuovo alla prima consultazione di quell'amministratore dopo 24 ore, senza che le aperture intermedie aggiungano righe. Il proprietario e gli amministratori possono visualizzare quel registro. Le statistiche dei membri visibili agli amministratori mostrano quanti post hai pubblicato e quanti messaggi hai inviato, e per gli scambi solo i totali dell'intera comunità, non i tuoi. Ogni membro, inclusi gli amministratori, vede il tuo profilo di affidabilità: quanti dei tuoi scambi sono stati completati e quanti annullati, e la percentuale di completamento, quanti pagamenti in Bean hai inviato o ricevuto dai membri oltre agli scambi completati, con quanti membri diversi hai effettuato o ricevuto pagamenti o scambiato, quanti pagamenti e scambi hai effettuato con il membro che consulta e i tuoi Punti affidabilità. Questa consultazione non viene registrata, poiché ogni membro può vederla. Nient'altro dei tuoi scambi. Chiunque gestisca il server di questa comunità detiene l'intero database, inclusi il tuo saldo e i tuoi scambi, nonché i relativi backup, istantanee e copie di riserva."

Accettare questo testo costituisce il tuo consenso. A quel punto, e solo finché un amministratore ti ha confermato:

- Se il tuo saldo supera una delle due soglie, il tuo account compare sui telefoni degli amministratori con il tuo saldo, in modo che un amministratore che ti conosce possa parlartene. Quell'elenco non mostra nient'altro su di te e nessuno dei tuoi scambi.
- Ogni volta che un amministratore apre quell'elenco, gli altri amministratori e il proprietario possono vedere chi lo ha aperto e quando.
- Se non hai acconsentito, o nessuno ti ha confermato, o la tua comunità non conferma i membri, quell'elenco non ti mostrerà mai.

Se ti sei unito prima che la tua comunità lo introducesse, l'app ti propone la scelta. Rispondere di no, o non rispondere, non cambia nient'altro: sei comunque un membro. Se la comunità modifica le proprie soglie in seguito, l'app te lo chiederà nuovamente.

Puoi revocare il consenso in qualsiasi momento: apri **Impostazioni**, dove l'app mostra cosa hai accettato e quando, e tocca **Revoca**. Da quel momento sei fuori dall'elenco. La tua comunità conserva una registrazione del tuo consenso e della tua revoca, e potrai acconsentire nuovamente in seguito.

## Quando un amministratore vede comunque il tuo saldo

Che tu abbia acconsentito o meno, in qualsiasi comunità:

- **Quando un amministratore rimuove il tuo account.** L'amministratore che avvia la rimozione vede il tuo saldo e quanti scambi hai aperti, in modo da poter saldare quanto possiedi o devi. Gli altri amministratori e il proprietario possono vedere chi ha guardato, il saldo di chi e quando.
- **Quando la tua comunità vota per la tua rimozione.** Chiunque possa votare vede il tuo saldo e l'eventuale debito, esclusivamente in quella votazione. Un amministratore o un proprietario che non può votare non li vede in quel contesto. Queste consultazioni non vengono registrate.
- **Chiunque gestisca il server della tua comunità** detiene l'intero database, inclusi il tuo saldo e i tuoi scambi, nonché i backup, le istantanee e le copie di riserva.

## Cosa può vedere qualsiasi amministratore dei tuoi scambi

Che tu abbia acconsentito o meno, in qualsiasi comunità, ogni amministratore può vedere:

- **Uno scambio non ancora completato o risolto da un amministratore.** Entrambi i membri, l'annuncio, il prezzo e i messaggi nella chat individuale tra i due membri. Un amministratore non può leggere una chat privata, vede solo chi ha scritto e quando. Questo serve affinché un amministratore possa risolvere uno scambio che si è bloccato.
- **Uno scambio i cui Bean sono rimasti bloccati quando un membro è stato rimosso su un server precedente.** Lo stato dello scambio, l'annuncio, il prezzo, le date, i Bean rimasti bloccati, quanti pagamenti vi sono transitati, l'importo e la nota dell'ultimo, affinché un proprietario possa stralciare i Bean bloccati.
- **Avvisi di frode che nominano i membri,** con i Bean. Uno nomina due membri che acquistano l'uno dall'altro a vicenda, in misura approssimativamente paritaria, oltre una soglia. Mostra i Bean totali e l'equilibrio degli scambi in ciascuna direzione. Un altro nomina un membro e i membri da lui invitati, quando questi gli inviano Bean oltre una soglia entro un determinato numero di giorni. Mostra i Bean complessivi e quanti dei membri invitati hanno scambiato esclusivamente con lui.
- **Un avviso di frode che nomina un gruppo di membri,** per almeno la metà nuovi, che scambiano prevalentemente tra loro. Mostra quanta parte degli scambi del gruppo avviene tra i membri stessi, ma senza mostrare i Bean.
- **Un avviso che nomina i membri che non hanno avuto movimenti di Bean in entrata o in uscita** per un determinato numero di giorni.

**Ogni consultazione di uno di questi scambi viene registrata:** chi ha guardato, quando e quali scambi. **La consultazione degli avvisi che nominano un membro viene registrata** la prima volta che ciascun amministratore li apre, e di nuovo alla prima apertura dopo 24 ore da parte di quell'amministratore; le consultazioni intermedie non aggiungono righe. Il proprietario e gli amministratori possono visualizzare quel registro in Salute della comunità, come elenco dedicato accanto a quello di chi ha consultato un saldo. Una consultazione effettuata da un token di automazione (uno script configurato da un proprietario) lo dichiara apertamente: la riga indica "by token" e il nome del token, accanto al proprietario che lo ha creato.

Le statistiche dei membri visibili agli amministratori mostrano quanti post ciascun membro ha pubblicato e quanti messaggi ha inviato, e per gli scambi solo i totali dell'intera comunità: quanti scambi sono stati completati o annullati e a quanto ammontavano quelli conclusi, mai quelli di un singolo membro.

Ogni membro, inclusi gli amministratori, vede il **profilo di affidabilità** di ciascun membro: quanti dei suoi scambi sono stati completati e quanti annullati, e la percentuale di completamento, quanti pagamenti in Bean ha inviato o ricevuto dai membri oltre agli scambi completati, con quanti membri diversi ha effettuato o ricevuto pagamenti o scambiato, quanti pagamenti e scambi ha effettuato con il membro che consulta e i suoi Punti affidabilità. Questa consultazione non viene registrata, poiché ogni membro può vederla.

Nient'altro dei tuoi scambi.

## L'assistente IA di un amministratore

Un proprietario o un amministratore può collegare al server il proprio assistente IA per farsi aiutare. L'assistente vede meno di loro: mai i tuoi messaggi, saldo, scambi, chiavi, foto o la lista nomi, e mai chi ha segnalato qualcuno. Vedi "Quando un admin usa un assistente IA".

## Chiedere informazioni sulla propria voce

Puoi chiedere ai tuoi amministratori cosa contiene la tua voce, per correggerla o per cancellarla quando non fai più parte della comunità. Sono loro a custodire la lista, non BeanPool.
