---
slug: check-your-12-words
title: Tus 12 palabras y claves (propietarios)
summary: Para propietarios de una comunidad. Revisar tus 12 palabras, tomar el control o restaurar el servidor con tu teléfono y la verificación automática de tu teléfono.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## Para quién es

Solo para los **propietarios** de una comunidad. Si no eres propietario, no verás nada de esto.

## Por qué se le pide a los propietarios

El servidor de tu comunidad guarda una copia bloqueada de sus claves, para trasladar la comunidad a otro servidor si el propio se pierde, y sus copias de seguridad también están bloqueadas. Están bloqueadas con las cuentas de los propietarios: cualquier propietario puede abrirlas con su teléfono (consulta Tomar el control o restaurar con tu teléfono, más abajo). Si pierdes tu teléfono, tus 12 palabras (que son palabras en inglés) recuperan tu cuenta, y con ella tu clave para el bloqueo del servidor y sus copias de seguridad. Eso es lo más importante el día en que el servidor mismo haya desaparecido.

Por eso la app le pide a cada propietario, de vez en cuando, que compruebe que todavía tiene las 12 palabras correctas. Puedes responder **Más tarde**. Nunca se bloquea nada, y puedes seguir haciendo todo lo que hace un propietario.

## Cuándo lo solicita la app

- Una vez, poco después de convertirte en propietario.
- De nuevo 12 meses después de tu última comprobación.

Muestra una tarjeta en la parte superior del Mercado (en la app web, en la parte superior de cada pantalla excepto el Mapa): **Comprobar ahora** o **Más tarde**. **Más tarde** descarta la tarjeta hasta la próxima fecha prevista. Puedes comprobarlas en cualquier momento desde **Ajustes**: bajo **Claves de la comunidad**, toca **Comprueba tus 12 palabras** (en la app web, **Comprobar ahora**).

## Cómo comprobarlas

- Busca tu papel con las 12 palabras (recuerda que son palabras en inglés).
- Escríbelas en orden, con espacios entre ellas. Las mayúsculas y los espacios adicionales no importan.
- Toca **Comprobar mis palabras**.

Si son correctas, la app dice **Estas son las palabras correctas.** Si no: **Estas no son las palabras de esta cuenta.** No indica qué palabra es incorrecta, así que revisa el papel y escríbelas todas de nuevo.

En un teléfono sin copia de tus 12 palabras (uno restaurado con una cuenta de inicio de sesión), las palabras correctas también traen **Guardarlas en este teléfono**. Tócalo y **Ver frase de recuperación** las mostrará a partir de entonces. Es la misma comprobación y el mismo guardado que **Añade tus 12 palabras a este teléfono** (consulta "Tus 12 palabras").

¿No las encuentras? Si este teléfono todavía las conserva, **Ajustes**, luego **Ver frase de recuperación**, las muestra. Escríbelas en papel de nuevo y luego compruébalas. En un teléfono sin copia, la app te lo advierte: cuando las encuentres, compruébalas aquí y luego guárdalas.

## Qué se envía y qué no

- La comprobación ocurre en tu teléfono (o en tu navegador, en la app web). Tus palabras nunca se envían a ninguna parte. El cuadro se vacía en cuanto responde la comprobación y cuando sales de la pantalla. Se guardan solo si tocas **Guardarlas en este teléfono**, y únicamente en este teléfono.
- Cuando las palabras son correctas, tu teléfono le dice al servidor de tu comunidad únicamente que las comprobaste, y cuándo, firmado con tu cuenta.
- Los propietarios y administradores ven, en los Ajustes del servidor, la fecha de "12 palabras comprobadas" de cada propietario, o "aún no". Es tu propia confirmación: el servidor no puede ver ni comprobar tus palabras.

## Tomar el control o restaurar con tu teléfono

Si el servidor de tu comunidad se pierde, quien opere su servidor de reserva (o un nuevo servidor que restaure una copia de seguridad) puede pedirle a un propietario que abra las claves bloqueadas. Cualquier propietario es suficiente. Necesitas la versión más reciente de la app de BeanPool. La app web también funciona si aún se abre, pero reside en la propia dirección de tu comunidad, que podría estar caída junto con el servidor: la app del teléfono es con la que hay que contar.

- En los Ajustes del servidor, eligen **Tomar el control como servidor principal**, luego **Entendido: usar el teléfono de un propietario**, o **Abrir con el teléfono de un propietario** al restaurar una copia de seguridad. Aparece un código en su pantalla.
- En la app: **Ajustes**, bajo **Claves de la comunidad**, toca **Tomar el control o restaurar con este teléfono**, y apunta la cámara al código. Si la página del servidor está abierta en tu propio teléfono, tocar su enlace hace lo mismo. En la app web, copia el enlace de su pantalla y pégalo bajo **Tomar el control o restaurar con este navegador** en **Ajustes**.
- La app muestra qué comunidad, qué servidor y qué ocurrirá. Si tu servidor principal todavía responde, lo indica en rojo: una toma de control es únicamente para un servidor que realmente ha desaparecido.
- Toca **Desbloquear para la toma de control** (o **Desbloquear la copia de seguridad**). Tu teléfono solicita primero su propio desbloqueo: huella, rostro o PIN. La app web no tiene ese paso, razón por la cual la app del teléfono es el lugar más seguro para la clave de un propietario.
- Tu teléfono abre su propia parte del bloqueo y le entrega la clave a ese servidor, bloqueada para que solo ese servidor pueda leerla. Tu teléfono nunca ve las claves del servidor ni la copia de seguridad.
- En una toma de control, la persona en el servidor confirma entonces en su pantalla. Se informa a la comunidad de que se trasladó y de que tú abriste las claves.

La app se negará e indicará el motivo si el bloqueo pertenece a otra comunidad, si no está bloqueado para ti, si el código del servidor ha caducado (dura 10 minutos y funciona una sola vez) o si las claves no fueron bloqueadas por el propio servidor de tu comunidad.

## Tu teléfono comprueba el bloqueo por sí mismo

Cada vez que el bloqueo de tu comunidad cambia (se añade o elimina un propietario, se genera un nuevo código de recuperación), tu app comprueba, en segundo plano, si aún podría abrir su parte. La abre, desecha la clave de inmediato y le comunica al servidor si funcionó. No se te pide nada.

Los propietarios y administradores lo ven en los Ajustes del servidor, junto a la fecha de tus 12 palabras: **su teléfono abrió el bloqueo actual**, con la fecha, o que abrió por última vez uno más antiguo. Si dice que tu teléfono **NO pudo abrir** el bloqueo, comprueba tus 12 palabras y pídele a otro propietario que revise los Ajustes del servidor.
