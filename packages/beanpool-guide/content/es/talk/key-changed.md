---
slug: key-changed
title: Si la clave de un contacto cambió
summary: Por qué un chat deja de enviar, cómo verificar el código de clave con la persona y cuándo continuar.
related: messages, your-12-words, people
source-hash: c6be30fdc4888113
---

## Qué significa

Cada mensaje entre dos personas se bloquea para que solo el teléfono de la otra persona pueda abrirlo. Está protegido con su **clave**, no con su nombre. Tu teléfono recuerda a qué clave ha estado asociando tu chat.

Si tu comunidad ahora asigna una clave diferente para esa persona, tu teléfono se detiene y te lo advierte, en lugar de enviar silenciosamente a la clave nueva. En la parte superior del chat verás **La clave detrás de «Ben» cambió.** El cuadro de mensajes aparece atenuado y dice que el envío está en pausa.

Tus mensajes anteriores con esa persona normalmente se siguen leyendo como antes. En un teléfono que acabas de restaurar o configurar de nuevo, los mensajes de la nueva clave dicen **Enviado desde la nueva clave. Se muestra después de continuar.** hasta que tomes una decisión.

Esto ocurre en la app del teléfono. La aplicación web todavía no recuerda claves.

## Por qué puede suceder

- **Consiguieron un teléfono nuevo y renovaron su clave.** Este es el motivo habitual. Su clave anterior ya no existe, por lo que tienen una nueva.
- **Algo no está bien.** El servidor de una comunidad enumera quién está en cada chat. Un servidor que quisiera leer tus mensajes podría poner la clave de otra persona detrás del nombre de tu amigo. El nombre parece correcto, pero la clave no lo es.

Tu teléfono no puede distinguir estas situaciones por sí solo. Tú sí puedes, mediante el código de clave.

## Comprobar el código de clave con la persona

- El aviso muestra un código: 20 dígitos en cinco grupos de cuatro.
- Pídele a la persona que abra **Ajustes**, luego **Protección de la cuenta**, y te lea **Mi código de clave**.
- **Mi código de clave** solo está en la app del teléfono. Si la persona solo usa la aplicación web, todavía no puede leértelo: toca **Ahora no** hasta que pueda abrir la app del teléfono.
- Comprueba el código **en persona, o en una llamada telefónica o de video** donde sepas con certeza que es esa persona. No lo compruebes mediante un mensaje en BeanPool: si la clave es incorrecta, quien responda también lo será.
- Si cada dígito coincide, marca **Lo comprobé con Ben: el código de clave en su Configuración coincide con este**, luego toca **Continuar con la nueva clave**.

A partir de entonces, tus mensajes irán a la nueva clave. El banner y la etiqueta de **clave modificada** en el chat en **Charlas** desaparecerán, y tus mensajes anteriores seguirán siendo legibles.

El código no es secreto. Es seguro leerlo en voz alta.

## Si el código no coincide o no puedes comprobarlo

Toca **Ahora no**. No se envía nada y nada cambia. Puedes volver al chat más tarde.

Un chat en pausa puede permanecer en pausa hasta que continúes. No hay otra forma de seguir conversando en él: tu comunidad conserva un único chat para ustedes dos, por lo que iniciar un chat nuevo con la misma persona abre este mismo chat.

Si el código no coincide, no continúes. Avísale a la persona y a los administradores de tu comunidad: alguien podría estar intentando leer tus mensajes.

## Si el aviso no ofrece ninguna clave para continuar

A veces la comunidad no enumera una sola clave para la persona en un chat entre dos personas: enumera varias, o ninguna. En ese caso no hay ninguna clave con la que continuar, por lo que el aviso lo indica y solo ofrece **Ahora no**. No se envía nada. Habla con la persona cara a cara o por llamada. Tu teléfono vuelve a comprobar el chat por sí solo cuando la lista de la comunidad cambie, y un chat nuevo con la misma persona es este mismo chat.

## Si el aviso dice que tu teléfono está comprobando el chat desde el principio

Después de restaurar tu teléfono a partir de tus 12 palabras, o de actualizar la app, tu teléfono comprueba cada chat comparándolo con sus propios mensajes anteriores. Si estos provinieron de una clave diferente a la que tu comunidad proporciona ahora para esa persona, el aviso comienza con **Este teléfono está comprobando este chat desde el principio, tal como hace al restaurarlo o actualizar la app.** Comprueba el código con la persona como se explicó arriba. Después de restablecer la memoria de chats de la comunidad, comienza con **Se restableció la memoria de chats de esta comunidad, por lo que este teléfono está comprobando este chat desde el principio.** en su lugar.

## Memoria de chats

Tu teléfono conserva una pequeña memoria para cada comunidad: con qué clave se comunica cada uno de tus chats y qué chats son privados. Se conserva en el teléfono, y el servidor de la comunidad no puede transferir un chat a otra clave por sí solo: solo tú puedes hacerlo, desde el aviso. Permanece en el teléfono al cerrar sesión, por lo que cerrar sesión y volver a entrar no la borra. El teléfono nunca la restablece por su cuenta.

Puedes restablecerla para una comunidad: abre **Ajustes**, toca **Memoria de chats** bajo **CUENTA E IDENTIDAD**, toca **Restablecer** junto a la comunidad, lee la advertencia y toca **Restablecer** nuevamente. La app te dirige aquí únicamente cuando indica que no pudo leer esa memoria y que volver a intentarlo no sirvió de nada.

Tras un restablecimiento, tu teléfono comprueba cada chat de esa comunidad nuevamente desde el principio, a partir de los mensajes que conserva. Un chat cuyos mensajes provinieron de una clave distinta a la que la comunidad proporciona ahora vuelve a mostrar el aviso, comenzando con **Se restableció la memoria de chats de esta comunidad, por lo que este teléfono está comprobando este chat desde el principio.** Comprueba el código con la persona como se indicó arriba.

Dos cosas pueden cambiar tras un restablecimiento, y la advertencia lo aclara antes de que confirmes: un chat que estaba pausado porque su clave cambió puede abrirse con la nueva clave, y un chat privado que había desaparecido de Charlas puede regresar como un chat grupal que la comunidad puede leer. Comprueba el código de clave, o quién está en el chat, antes de enviar nada.

Un restablecimiento no soluciona el caso de un chat que tu teléfono no puede asociar a una sola clave: se comprueba de nuevo y se detiene otra vez. Comprueba el código con la persona en su lugar (arriba).

Esto ocurre en la app del teléfono. La aplicación web no tiene memoria de chats.

## Si el aviso dice que tu teléfono no puede asociar el chat a una clave

A veces, los mensajes anteriores de un chat quedaron bloqueados con claves que tu teléfono no puede asociar a una sola persona. Encima del cuadro de mensajes dice **Este teléfono no puede asociar este chat a una clave, por lo que el envío está desactivado.** y el aviso muestra el código de la clave que tu comunidad ahora indica para la persona.

Es posible que algunos mensajes sigan mostrándose. Podrían no ser de la persona cuyo nombre figura en el chat: sus propios mensajes anteriores pueden ser los que digan **Este mensaje no se pudo verificar, por lo que no se muestra.** Esos permanecen así, incluso después de continuar.

Comprueba el código con la persona como se indicó arriba, en persona o por llamada. Si coincide, marca la casilla y toca **Continuar con la nueva clave**: a partir de entonces tus mensajes irán a esa clave. Si no coincide o no puedes comprobarlo, toca **Ahora no**. Un chat nuevo con la misma persona es este mismo chat, por lo que no hay nada más que intentar. Si la comunidad no indica una sola clave para esa persona, el aviso solo ofrece **Ahora no**, y tu teléfono comprueba el chat nuevamente por sí solo cuando la lista de la comunidad cambie.

## Qué puede comprobar tu teléfono y qué no

Tu teléfono comprueba un chat comparándolo con los mensajes que ya conserva. Un teléfono restaurado, o un teléfono existente al momento de la actualización, solo se deja guiar por un servidor que retiene o rodea la parte más antigua del chat en lo que envía. Un teléfono que ya tenía esa parte más antigua no se deja guiar por nada de lo que el servidor envíe después de la actualización.

Por lo tanto, un teléfono que acabas de restaurar o actualizar puede ser engañado sobre la clave de un chat. Un aviso no puede descartar eso. **Confirma una clave modificada en persona**, o en una llamada donde sepas que es ella.

## Si la comunidad da una fecha

Cuando tu comunidad puede demostrar que a la cuenta se le cambió la clave, el aviso lo indica, por ejemplo: **Esta comunidad indica que la cuenta cambió de clave el 3 oct 2026.** Eso te ayuda a entender lo que sucedió, pero no reemplaza la comprobación del código: un servidor también podría decirlo.
