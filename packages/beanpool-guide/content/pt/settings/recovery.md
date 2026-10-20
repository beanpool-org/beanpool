---
slug: recovery
title: Recuperar sua conta
summary: Restaure sua conta em um celular novo e proteja-a vinculando um login.
related: your-12-words, leaving-or-deleting, communities, faq, key-changed
help: Como recuperar sua conta em um celular novo: suas 12 palavras ou um login vinculado.
source-hash: c12dcedd3fb28fb7
---

## Em um celular novo

A chave da sua conta não está nos backups do seu celular. Um novo celular precisa das suas 12 palavras ou de uma conta de login vinculada, mesmo um iPhone restaurado a partir de um backup do seu aparelho antigo.

- Instale o BeanPool e abra-o.
- Toque em **Já é membro? Restaurar conta**.
- Escolha **Recuperar com 12 palavras** ou **Recuperar com rede social**.

## Com suas 12 palavras

- Digite as 12 palavras em ordem (as palavras de recuperação são em inglês) ou toque em **Colar**.
- Em **Qual comunidade?**, toque em **Comunidade global** ou em uma das comunidades pelas quais este celular já passou. Para qualquer outra, toque em **outro endereço** e digite o nome ou o endereço da sua comunidade.
- Toque em **Recuperar identidade**. Seu nome e sua foto retornarão da sua comunidade.

## Com uma conta de login

Isso funciona apenas se você tiver vinculado uma anteriormente (veja abaixo) e somente enquanto o servidor da sua comunidade estiver funcionando.

- Digite seu nome na comunidade. O app pode sugerir "É você?".
- Digite o nome ou o endereço da sua comunidade.
- Toque em **Recuperar com** e na conta vinculada: Google ou Facebook, ou Apple em um iPhone.
- Com o Google em um iPhone, uma página web do Google se abre. Entre nela e escolha a conta que você vinculou. No Android, o Google exibe sua própria lista de contas. Se não puder exibir uma lista nesse celular, uma página web do Google se abre em vez disso.

Se a conta de login tiver sido vinculada a partir de um celular que continha suas 12 palavras, em um aplicativo atualizado, suas 12 palavras retornam também. Caso contrário, o celular não terá 12 palavras: elas não podem ser reconstruídas a partir de um login. Se você as tiver anotadas, poderá adicioná-las (veja "Suas 12 palavras"). Até lá, uma conta de login vinculada é o meio de recuperação desse celular, portanto mantenha uma vinculada e vincule uma segunda se puder (veja abaixo).

## Protegendo sua conta agora

- Abra as **Configurações** e toque em **Proteção da conta**.
- Em **Provedores de recuperação por login (1 de N)**, toque em **Proteger com** e escolha uma conta.
- Passe pela verificação da tela de bloqueio do seu celular. A conta vinculada pode recuperar sua conta, por isso o app pede a verificação primeiro.
- Com o Google em um iPhone, uma página web do Google se abre. Entre nela e escolha sua conta, e você retornará ao BeanPool.

Isso funciona também em um celular sem as 12 palavras.

Se você entrou na comunidade global com 12 palavras, use **Adicionar um login**, perto do topo de **Proteção da conta**, em vez disso. Esse também é um caminho de volta e também elimina os limites de uma nova conta de 12 palavras. Veja "Suas 12 palavras".

Se este celular tiver suas 12 palavras, a conta vinculada as guardará também, para que a restauração com ela as devolva. Uma conta vinculada em uma versão mais antiga do app guarda apenas a sua chave: toque em **Conectar novamente** ao lado dela e passe pela verificação da tela de bloqueio do celular para incluir as palavras. Em um celular sem as 12 palavras, não há nada para incluir, portanto **Conectar novamente** não é exibido.

Esta não é uma forma de iniciar sessão no dia a dia. Sua conta continua sendo sua própria chave. A conta vinculada serve apenas para ajudar você a recuperá-la, nessa comunidade.

Para removê-la, toque em **Desconectar**.

## Se você tinha vinculado o GitHub

O BeanPool não usa mais o GitHub. O identificador de uma conta do GitHub é público, de modo que uma cópia vinculada a ela não estava protegida por algo que somente você possui. Quando o servidor da sua comunidade for atualizado, ele excluirá todas as cópias vinculadas ao GitHub. Sua conta em si não é afetada e suas 12 palavras continuam funcionando.

- Se o GitHub era a única conta vinculada e suas 12 palavras estão neste celular mas não anotadas, anote-as agora (**Configurações** e depois **Ver frase de recuperação**), ou vincule Google, Facebook ou (em um iPhone) Apple, como descrito acima. Até que você faça uma dessas ações, este celular é sua única forma de entrar na sua conta.
- Se suas 12 palavras estiverem anotadas, você não precisa fazer nada. Para ter também uma conta de login, vincule Google, Facebook ou (em um iPhone) Apple, como descrito acima.
- Se o GitHub era a única conta que você vinculou, este celular não possui as 12 palavras e você não as tem anotadas, vincule Google, Facebook ou (em um iPhone) Apple agora. Até que faça isso, este celular é seu único meio de acessar a conta.

## Quem pode abrir a cópia

Uma conta de login vinculada funciona porque o servidor da sua comunidade guarda uma cópia protegida da sua conta para ela. As pessoas que gerenciam esse servidor podem abrir essa cópia, porque o servidor delas verifica seu login. Na comunidade global, isso é feito pelo BeanPool. Uma cópia roubada do banco de dados do servidor não pode abri-la, assim que o servidor tiver sido atualizado para isso. Qualquer pessoa que assumir o controle da sua conta de login também pode entrar: veja "Se outra pessoa tentar".

Se você preferir que ninguém além de você possa entrar, use apenas suas 12 palavras: mantenha-as anotadas e toque em **Desconectar** ao lado de cada conta de login. Desconectar exclui a cópia. Um servidor em espera (standby), o segundo servidor que algumas comunidades mantêm pronto para assumir, exclui a cópia dele também, na próxima vez que copiar do principal (cerca de uma vez por minuto). Desconectar não exclui as cópias já presentes nos backups do servidor nem a cópia que o servidor mantém, como registro, cada vez que um login recupera sua conta. As pessoas que gerenciam o servidor também podem abrir essas cópias.

## Se outra pessoa tentar

Se alguém iniciar a recuperação da sua conta, as Configurações exibem **Alguém está recuperando sua conta** enquanto ela estiver em andamento. Se não for você, toque em **Parar agora**: o servidor da sua comunidade deixará de repassar qualquer dado para essa restauração. Se entrarem usando a sua conta de login vinculada, você receberá um alerta avisando que sua conta acabou de ser restaurada em outro dispositivo, e a pessoa já pode ter entrado quando você vir isso. Mantenha essa conta de login segura, com sua própria senha forte.

## Se o celular já tiver uma conta

Restaurar uma conta diferente substitui a que está neste celular, quer você restaure com suas 12 palavras ou com uma conta de login. O app pergunta primeiro, em **Substituir a conta deste celular?** (com uma conta de login, depois que você entrar). Nada é alterado até que você digite **WIPE**, toque em **Substituir conta** e passe pela verificação da tela de bloqueio do seu celular. Toque em **Manter**, depois no nome da conta, **voltar** para deixar tudo como estava.

Certifique-se de que você tem as 12 palavras da conta que está substituindo. Se este celular as possuir, essa tela as exibirá quando você tocar em **Mostrar 12 palavras** (do nome da conta) e passar pela verificação da tela de bloqueio do celular. Se este celular não tiver as 12 palavras dessa conta (as Configurações informam isso), sem uma conta de login vinculada você não conseguirá recuperá-la.

## Se perdeu o celular e as 12 palavras

Sem suas 12 palavras e sem uma conta de login vinculada, um administrador da sua comunidade pode transferir sua conta para um novo celular, com seus feijões, seu nome e seu histórico. Procure-o pessoalmente: ele verificará sua identidade primeiro.

- O administrador gera um código de troca de chave na tela dele. Se o celular antigo ainda tiver o aplicativo, receberá um aviso de que um administrador começou a transferir sua conta.
- No celular novo, abra o BeanPool, toque em **Já é membro? Restaurar conta** e, em seguida, em **Um administrador me deu um código de troca de chave**. Escaneie o QR na tela do administrador ou digite o código (que começa com RK-) e o nome da sua comunidade. No navegador, o link do QR abre a mesma tela; ou abra o app web da sua comunidade, toque em **Já sou membro →**, depois em **Um administrador me deu um código de troca de chave**, e digite o código.
- Seu celular exibe um número de dois dígitos e, abaixo dele, o endereço da comunidade consultada. Mostre ambos ao administrador: ele digita o número na tela dele. O número garante que é o seu celular que ele está vinculando, e não o de alguém que viu o código. **Agora não** sai dessa tela de número: seu celular mantém o lugar onde estava, e o mesmo código exibe o mesmo número novamente.
- Se o novo celular não tinha conta do BeanPool, ele exibirá as 12 palavras da sua **nova** chave (essas palavras são em inglês). Anote-as: suas palavras antigas não funcionam mais e seu celular antigo para de funcionar em definitivo. Um celular que já tinha uma conta (de outra comunidade) mantém as 12 palavras dessa conta, e elas agora passam a recuperar esta conta também.
- Se você tinha vinculado uma conta de login, seu celular pedirá para vinculá-la novamente em Proteção da conta: a que você tinha protegia a chave antiga, por isso foi removida.
- As pessoas com quem você conversa verão que sua chave mudou. Diga a elas que foi você e leia para elas o seu **Meu código de chave**, em **Configurações** sob **Proteção da conta** no celular. Veja "Se uma conversa disser que a chave por trás de um nome mudou".

O código dura 24 horas. Se o seu administrador disser que seu celular não é o que ele viu ou se o código expirar, peça um novo a ele.
