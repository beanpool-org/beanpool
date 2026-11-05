---
slug: what-the-admins-can-see
title: O que administradores veem
summary: Em comunidades onde administradores mantêm lista de nomes: o que ela tem sobre você, quem lê, o que o servidor guarda e o que significa estar confirmado.
related: privacy, joining, leaving-or-deleting, admins-ai-assistants
source-hash: 88d60b236e7653ab
---

## A lista de nomes

Os administradores de algumas comunidades mantêm uma **lista de nomes**: quem são os membros, pelo nome real, da mesma forma que um comitê de LETS mantém uma lista de membros. Nem toda comunidade mantém uma. Pergunte aos seus administradores se a sua mantém.

Um registro contém o seu nome e, às vezes, uma breve anotação que um administrador escreve, como a forma pela qual a comunidade conhece você. Nada mais: nenhum endereço, nenhuma data de nascimento, nenhum número de documento.

## Quem pode ler

**Apenas os proprietários e administradores da sua comunidade, nos próprios celulares deles.** Seu nome é selado no celular de um administrador antes de ser enviado ao servidor da sua comunidade. O servidor guarda texto embaralhado: um backup, uma cópia, o BeanPool ou qualquer pessoa que roube o banco de dados não obtém nada legível.

Quem gerencia o servidor não pode ler a lista. Os celulares dos administradores fornecem as chaves da lista apenas aos administradores cujos celulares outro administrador já verificou, por chamada ou pessoalmente, e só aceitam chaves novas vindas deles. Isso depende dos administradores: um administrador que verificar o celular da pessoa errada, o celular de um administrador no qual alguém consiga entrar ou um celular perdido antes que os administradores removam sua chave podem permitir que outra pessoa leia os nomes. O mesmo pode ocorrer se o responsável pelo servidor impedir que o celular de um administrador saiba que outro administrador foi removido: até que saiba, o que ele escrever poderá ser lido com as chaves que o administrador removido possuía. Um administrador cujo celular ainda exiba o administrador removido remove a chave dele manualmente, e esse celular então cria uma nova chave sem ele ou não escreve nada.

**Outros membros não veem os nomes.** Eles veem seu nome no BeanPool, como sempre.

Um administrador pode gerar uma cópia em PDF da lista no celular dele, para fins de segurança. Uma vez gerada, cabe a ele mantê-la segura, como uma lista em papel. Sempre que a lista é aberta ou copiada, os outros administradores podem ver quem fez isso e quando.

## Ser confirmado

Um administrador pode **confirmar** você: ele declara que a sua conta pertence à pessoa indicada no seu registro. Apenas alguém que conheça você deve fazer isso e, em algumas comunidades, dois administradores precisam concordar.

- Uma confirmação não carrega nenhum nome. O servidor registra qual conta, qual entrada e qual administrador, nunca quem você é.
- Não é um emblema de confiança. Também concede a você uma linha de crédito imediatamente, o piso conhecido, a menos que o proprietário da sua comunidade o tenha desativado: consulte "Sua linha de crédito".
- Se um administrador convidou você pelo nome, entrar com o convite dele confirmou você no seu registro, por aquele administrador. "Confirmado" significa apenas que um administrador atesta que esta conta é a pessoa indicada naquele registro.
- Se você substituir um celular perdido e sua conta passar para uma nova chave, sua confirmação passa junto.
- Se você sair ou excluir sua conta, sua confirmação termina. Seu registro permanece na lista dos administradores até que um administrador o exclua: peça a ele para fazer isso.
- Se você estiver confirmado e sair, for removido ou excluir sua conta devendo feijões, os Bens comuns cobrem a dívida, como sempre. A lista dos administradores também guarda uma anotação no seu registro sobre o que você devia, por que motivo e quando, por 3 anos, e os administradores veem isso ao lado do seu nome nos celulares deles. Ninguém pode ser confirmado em relação àquele registro até que o valor seja pago de volta, compensado com trabalho ou perdoado.

## O que a lista de nomes não mostra aos administradores

A lista contém nomes e anotações, e qual conta pertence a quem. Além da anotação mencionada acima de uma dívida deixada em aberto, ela não mostra a ninguém seu saldo ou suas trocas (um administrador pode ver seu saldo nos casos descritos abaixo e algumas das suas trocas: veja o final desta página). Veja "Sua privacidade" para saber o que membros e administradores podem ver em outras circunstâncias.

## O que você concorda em uma comunidade conhecida

Uma comunidade que confirma seus membros, uma **comunidade conhecida**, funciona como um LETS sempre funcionou: os administradores ficam atentos a dívidas que crescem demais ou permanecem por muito tempo. Quando você entra em uma, a tela de adesão diz exatamente quando, com os números da sua comunidade, por exemplo:

"Nesta comunidade, os administradores podem ver o seu saldo se ele ultrapassar 50% da sua linha de crédito ou se você permanecer no negativo por 60 dias sem realizar nenhuma venda. É assim que um LETS sempre funcionou. Cada vez que um administrador abre a lista de membros que ultrapassaram esses limites, e cada vez que um administrador consulta o seu saldo ao remover você, isso é registrado em logs. Em uma votação sobre a sua remoção, todos os que podem votar nela veem o seu saldo e qualquer dívida, apenas nessa votação, e essas consultas não são registradas em logs. Você pode revogar essa permissão a qualquer momento em Configurações. Seja qual for a sua escolha, qualquer administrador pode ver algumas das suas trocas: uma troca que ainda não foi concluída ou que um administrador liquidou (com quem foi feita, o anúncio, o preço e a conversa individual com a pessoa, que eles não podem ler se for privada), para que uma troca travada possa ser resolvida; uma troca cujos feijões ficaram travados quando um membro foi removido em um servidor mais antigo (o status da troca, o anúncio, o preço, suas datas, os feijões travados, quantos pagamentos passaram por ela e o valor e anotação do último pagamento); um alerta de fraude que cita você se você e um membro comprarem um do outro repetidamente, em valores aproximados, acima de um limite, com o total de feijões e o equilíbrio das trocas em cada sentido; um que cita você, com o total de feijões e quantos dos membros convidados por você negociaram exclusivamente com você, se membros convidados por você lhe enviarem feijões acima de um limite em um número definido de dias, ou se você for um desses membros; um que cita você, com a proporção das trocas do grupo entre si, mas sem feijões, se você estiver em um grupo de membros, no qual pelo menos metade é nova na comunidade, que negociam principalmente entre si; e um alerta que cita você se nenhum feijão tiver entrado ou saído da sua conta por um número definido de dias. Cada consulta a uma dessas trocas é registrada em logs, com quem olhou, quando e em quais trocas; a consulta aos alertas que citam você é registrada na primeira vez que cada administrador os abre e novamente na primeira consulta desse administrador após 24 horas, e as consultas intermediárias não acrescentam nenhuma linha. O proprietário e os administradores podem ver esse registro. As estatísticas de membros que os administradores veem mostram quantas publicações você mantém ativas e quantas mensagens enviou, e em relação a trocas apenas os totais de toda a comunidade, não os seus. Todos os membros, administradores incluídos, veem o seu perfil de confiança: quantas das suas trocas foram concluídas e quantas foram canceladas, e a proporção de concluídas, quantos pagamentos em feijões você enviou para membros ou recebeu deles somados às trocas concluídas, com quantos membros distintos você pagou, recebeu ou negociou, quantos pagamentos e trocas realizou com o membro que está consultando, e seus Pontos de Confiança. Isso não é registrado em logs, porque todos os membros podem ver. Nada mais das suas trocas. Quem gerencia o servidor desta comunidade detém todo o banco de dados dela, incluindo seu saldo e trocas, além de backups, instantâneos e cópias em espera."

Concordar com isso é o seu consentimento. Então, e somente enquanto um administrador tiver confirmado você:

- Se o seu saldo ultrapassar qualquer uma das duas linhas, sua conta aparecerá nos celulares dos administradores com o seu saldo, para que um administrador que conheça você possa conversar a respeito. Essa lista não exibe mais nada sobre você e nenhuma das suas trocas.
- Sempre que um administrador abre essa lista, os outros administradores e o proprietário podem ver quem a abriu e quando.
- Se você não tiver concordado, ou se ninguém tiver confirmado você, ou se a comunidade não confirmar membros, essa lista nunca exibirá você.

Se você entrou antes de a comunidade passar a solicitar isso, seu aplicativo oferece a opção. Dizer não ou não responder não altera mais nada: você continua sendo um membro. Se a comunidade alterar os limites posteriormente, o aplicativo perguntará novamente.

Você pode revogar seu consentimento a qualquer momento: abra **Configurações**, onde o aplicativo mostra com o que você concordou e quando, e toque em **Revogar**. A partir desse momento, você sai da lista. A comunidade mantém um registro de que você concordou e de que revogou, e você pode concordar novamente mais tarde.

## Quando um administrador vê seu saldo de qualquer forma

Quer você tenha concordado ou não, em qualquer comunidade:

- **Quando um administrador remove a sua conta.** O administrador que inicia a remoção vê o seu saldo e quantas trocas você tem abertas, para que o que você possui ou deve possa ser liquidado. Os outros administradores e o proprietário podem ver quem olhou, o saldo de quem foi consultado e quando.
- **Quando a sua comunidade vota sobre a sua remoção.** Todos os autorizados a votar nessa decisão veem o seu saldo e qualquer dívida, apenas nessa votação. Um administrador ou proprietário que não possa votar não os vê ali. Essas visualizações não são registradas em logs.
- **Quem gerencia o servidor da sua comunidade** detém todo o banco de dados, incluindo seu saldo e trocas, além de backups, instantâneos e cópias em espera.

## O que qualquer administrador pode ver das suas trocas

Quer você tenha concordado ou não com algo, em qualquer comunidade, qualquer administrador pode ver:

- **Uma troca que ainda não foi concluída ou que um administrador liquidou.** Ambos os membros, o anúncio, o preço e as mensagens na conversa individual dos dois membros. Um administrador não pode ler uma conversa privada, apenas ver quem escreveu e quando. Isso serve para que um administrador possa resolver uma troca que ficou travada.
- **Uma troca cujos feijões ficaram travados quando um membro foi removido em um servidor mais antigo.** O status da troca, o anúncio, o preço, suas datas, os feijões que ficaram travados, quantos pagamentos passaram por ela e o valor e anotação do último pagamento, para que um proprietário possa dar baixa nos feijões travados.
- **Alertas de fraude que citam membros,** com feijões. Um deles cita dois membros que compram um do outro repetidamente, em valores aproximados, acima de um limite. Ele exibe o total de feijões e o equilíbrio entre as duas partes. Outro cita um membro e os membros convidados por ele, quando esses membros enviam feijões a ele acima de um limite em um número definido de dias. Ele exibe o total de feijões e quantos membros convidados por ele negociaram exclusivamente com ele.
- **Um alerta de fraude que cita um grupo de membros,** no qual pelo menos metade é nova na comunidade, que negociam quase exclusivamente entre si. Ele exibe a proporção das trocas do grupo entre si, mas sem feijões.
- **Um alerta que cita os membros cujas contas não tiveram nenhuma movimentação de feijões, de entrada ou saída,** por um número definido de dias.

**Cada consulta a uma dessas trocas é registrada em logs:** quem olhou, quando e em quais trocas. **A consulta aos alertas que citam um membro é registrada** na primeira vez que cada administrador os abre e novamente no primeiro acesso desse administrador após 24 horas; os acessos intermediários não acrescentam nenhuma linha. O proprietário e os administradores podem ver esse registro em Saúde da comunidade, como uma lista própria ao lado da lista de quem consultou um saldo. Uma consulta realizada por um token de automação (um script configurado por um proprietário) traz essa indicação: a linha diz "por token" e o nome do token, ao lado do proprietário que o criou.

As estatísticas de membros que os administradores veem mostram quantas publicações cada membro mantém ativas e quantas mensagens enviou, e em relação a trocas mostram apenas os totais de toda a comunidade: quantas trocas foram concluídas ou canceladas e a que valor chegaram as concluídas, nunca os números individuais de um membro.

Todos os membros, administradores incluídos, veem o **perfil de confiança** de cada membro: quantas das suas trocas foram concluídas e quantas foram canceladas, e a proporção de concluídas, quantos pagamentos em feijões foram enviados ou recebidos de membros somados às trocas concluídas, com quantos membros distintos pagou, recebeu ou negociou, quantos pagamentos e trocas realizou com o membro que está consultando, e seus Pontos de Confiança. Isso não fica registrado em logs, porque todos os membros podem ver.

Nada mais das suas trocas.

## O assistente de IA de um administrador

Um proprietário ou administrador pode conectar seu próprio assistente de IA ao servidor para ajudá-lo. O assistente vê menos do que eles: nunca suas mensagens, saldo, trocas, chaves, fotos ou a lista de nomes, e nunca quem denunciou alguém. Veja "Quando um administrador usa um assistente de IA".

## Perguntando sobre o seu registro

Você pode perguntar aos seus administradores o que consta no seu registro, pedir correções ou solicitar a exclusão dele quando você não pertencer mais à comunidade. Eles é que guardam a lista, não o BeanPool.
