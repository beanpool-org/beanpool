---
slug: check-your-12-words
title: Suas 12 palavras e chaves (donos)
summary: Para proprietários de comunidades. Como checar suas 12 palavras, assumir ou restaurar o servidor pelo celular e verificação automática pelo aparelho.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## A quem se destina

Apenas aos **proprietários** da comunidade. Se você não for proprietário, não verá nada disso.

## Por que os proprietários são solicitados

O servidor da sua comunidade mantém uma cópia bloqueada de suas chaves para transferir a comunidade para outro servidor caso o atual seja perdido, e os backups também são bloqueados. Eles ficam bloqueados para as contas dos proprietários: qualquer um dos proprietários pode abri-los usando seu próprio celular (consulte Assumir o controle ou restaurar com o celular, abaixo). Se você perder seu celular, suas 12 palavras recuperam sua conta e, com ela, a chave para o bloqueio do servidor e seus backups. Isso é ainda mais importante no dia em que o servidor em si deixar de existir.

Por isso, o aplicativo pede a cada proprietário, de tempos em tempos, que confirme se ainda possui as 12 palavras corretas. Você pode escolher **Depois**. Nada é bloqueado e você pode continuar fazendo tudo o que um proprietário faz.

## Quando o aplicativo solicita

- Uma vez, logo após você se tornar proprietário.
- Novamente 12 meses após a última verificação.

Ele exibe um cartão no topo do Mercado (no aplicativo web, no topo de todas as telas, exceto no Mapa): **Verificar agora** ou **Depois**. **Depois** dispensa o cartão até o próximo período previsto. Você pode verificar a qualquer momento em **Configurações**: sob **Chaves da comunidade**, toque em **Verifique suas 12 palavras** (no aplicativo web, **Verificar agora**).

## Como verificar

- Pegue seu papel com as 12 palavras (que são palavras em inglês).
- Digite-as na ordem, separadas por espaços. Letras maiúsculas e espaços extras não fazem diferença.
- Toque em **Verificar minhas palavras**.

Se estiverem corretas, o aplicativo informa: **Estas são as palavras corretas.** Caso contrário: **Estas não são as palavras desta conta.** Ele não indica qual palavra está incorreta, portanto confira o papel e digite todas novamente.

Em um celular sem cópia das suas 12 palavras (um aparelho restaurado por meio de conta de login), palavras corretas também exibem **Salvar neste celular**. Toque nessa opção e **Ver frase de recuperação** passará a mostrá-las a partir de então. É a mesma verificação e o mesmo salvamento de **Adicionar suas 12 palavras a este celular** (consulte "Suas 12 palavras").

Não consegue encontrá-las? Se este celular ainda as tiver salvas, abra **Configurações** e toque em **Ver frase de recuperação** para visualizá-las. Anote-as novamente no papel e faça a verificação. Em um celular sem cópia salva, o aplicativo avisa sobre isso: quando você as encontrar, verifique-as aqui e depois salve-as.

## O que é enviado e o que não é

- A verificação ocorre no seu próprio celular (ou no seu navegador, no aplicativo web). Suas palavras nunca são enviadas para lugar nenhum. O campo é limpo assim que a verificação responde e quando você sai da tela. Elas só são salvas se você tocar em **Salvar neste celular**, e apenas neste aparelho.
- Quando as palavras estão corretas, seu celular informa ao servidor da comunidade apenas que você fez a verificação, e quando, assinado pela sua conta.
- Proprietários e administradores veem, nas Configurações do servidor, a data em que cada proprietário verificou as 12 palavras, ou "ainda não". Trata-se da sua própria declaração: o servidor não pode ver nem conferir suas palavras.

## Assumir o controle ou restaurar com o celular

Se o servidor da sua comunidade for perdido, quem estiver operando o servidor de prontidão (ou um novo servidor restaurando um backup) pode pedir a um proprietário que abra as chaves bloqueadas. Qualquer um dos proprietários é suficiente. Você precisa da versão mais recente do aplicativo BeanPool. O aplicativo web também funciona caso ainda abra, mas ele fica no endereço próprio da comunidade, que pode estar fora do ar junto com o servidor: o aplicativo para celular é o mais confiável para isso.

- Nas Configurações do servidor, eles escolhem **Assumir como servidor principal** e depois **Entendi: usar o celular de um proprietário**, ou **Abrir com o celular de um proprietário** ao restaurar um backup. Um código surge na tela deles.
- No aplicativo: abra **Configurações**, sob **Chaves da comunidade**, toque em **Assumir ou restaurar com este celular** e aponte a câmera para o código. Se a página do servidor estiver aberta no seu próprio celular, tocar no link faz o mesmo. No aplicativo web, copie o link da tela deles e cole sob **Assumir o controle ou restaurar com este navegador** em **Configurações**.
- O aplicativo mostra qual é a comunidade, qual é o servidor e o que acontecerá. Se o servidor principal ainda responder, o aviso aparece em vermelho: a tomada de controle serve apenas para um servidor que realmente tenha sido perdido.
- Toque em **Desbloquear para assumir o controle** (ou **Desbloquear o backup**). Seu celular pede a autenticação do próprio aparelho primeiro: impressão digital, reconhecimento facial ou PIN. O aplicativo web não tem essa etapa, por isso o aplicativo para celular é o local mais seguro para a chave de um proprietário.
- Seu celular abre a parte correspondente do bloqueio e entrega a chave àquele servidor, codificada para que somente aquele servidor possa ler. Seu celular nunca vê as chaves do servidor nem o backup.
- Na tomada de controle, a pessoa no servidor confirma na tela dela. A comunidade é notificada da mudança e de que você abriu as chaves.

O aplicativo recusa e explica o motivo caso o bloqueio pertença a outra comunidade, caso não esteja bloqueado para você, caso o código do servidor tenha expirado (ele dura 10 minutos e funciona uma única vez) ou se as chaves não foram bloqueadas pelo servidor da sua própria comunidade.

## O celular confere o bloqueio automaticamente

Toda vez que o bloqueio da sua comunidade é alterado (um proprietário é adicionado ou removido, um novo código de recuperação é gerado), seu aplicativo verifica, silenciosamente, se ainda consegue abrir a parte dele. Ele abre, descarta a chave imediatamente e avisa o servidor se funcionou. Nada é solicitado a você.

Proprietários e administradores veem isso nas Configurações do servidor, ao lado da data das suas 12 palavras: **o celular abriu o bloqueio atual**, com a data, ou que abriu pela última vez um bloqueio anterior. Se informar que seu celular **NÃO pôde abrir** o bloqueio, confira suas 12 palavras e peça a outro proprietário para consultar as Configurações do servidor.
