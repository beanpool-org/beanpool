---
slug: recovery
title: Recuperar tu cuenta
summary: Restaura tu cuenta en un teléfono nuevo y protégela vinculando un inicio de sesión.
related: your-12-words, leaving-or-deleting, communities, faq, key-changed
help: Cómo recuperar tu cuenta en un teléfono nuevo: tus 12 palabras o una cuenta de acceso vinculada.
source-hash: c12dcedd3fb28fb7
---

## En un teléfono nuevo

La clave de tu cuenta no está en los respaldos de tu teléfono. Un teléfono nuevo necesita tus 12 palabras o una cuenta de inicio de sesión que hayas vinculado, incluso un iPhone restaurado a partir de un respaldo del anterior.

- Instala BeanPool y ábrela.
- Toca **¿Ya eres miembro? Restaurar cuenta**.
- Elige **Recuperar con 12 palabras** o **Recuperar con cuenta social**.

## Con tus 12 palabras

- Escribe las 12 palabras en orden, o toca **Pegar**.
- En **¿Cuál comunidad?**, toca **Comunidad global**, o una de las comunidades que ha tenido este teléfono. Para cualquier otra, toca **otra dirección** y escribe el nombre o la dirección de tu comunidad.
- Toca **Recuperar identidad**. Tu nombre y foto se recuperan de tu comunidad.

## Con una cuenta de inicio de sesión

Esto solo funciona si vinculaste una previamente (ver más abajo), y solo mientras el servidor de tu comunidad esté funcionando.

- Escribe tu nombre en la comunidad. La app puede sugerir "¿Eres tú?".
- Escribe el nombre o la dirección de tu comunidad.
- Toca **Recuperar con** y la cuenta que vinculaste: Google o Facebook, o Apple en un iPhone.
- Con Google en un iPhone, se abre una página web de Google. Inicia sesión allí y elige la cuenta que vinculaste. En Android, Google muestra su propia lista de cuentas. Si no puede mostrar una en ese teléfono, se abre una página web de Google en su lugar.

Si la cuenta de inicio de sesión se vinculó desde un teléfono que tenía tus 12 palabras, en una app actualizada, tus 12 palabras regresan también. De lo contrario, el teléfono no tiene 12 palabras: no se pueden reconstruir a partir de un inicio de sesión. Si las tienes anotadas, puedes añadirlas (consulta «Tus 12 palabras»). Hasta entonces, una cuenta de inicio de sesión vinculada es la vía de acceso de ese teléfono para volver, así que mantén una vinculada y vincula una segunda si puedes (ver más abajo).

## Proteger tu cuenta ahora

- Abre **Ajustes** y toca **Protección de la cuenta**.
- En **Proveedores de recuperación por inicio de sesión (1-de-N)**, toca **Proteger con** y elige una cuenta.
- Supera la comprobación de la pantalla de bloqueo de tu teléfono. La cuenta vinculada puede recuperar tu cuenta, por lo que la app lo solicita primero.
- Con Google en un iPhone, se abre una página web de Google. Inicia sesión allí y elige tu cuenta, y volverás a BeanPool.

Esto también funciona en un teléfono que no tiene 12 palabras.

Si te uniste a la comunidad global con 12 palabras, usa en su lugar **Añadir un inicio de sesión**, cerca de la parte superior de **Protección de la cuenta**. Es una vía de acceso también y además elimina los límites de una cuenta nueva de 12 palabras. Consulta «Tus 12 palabras».

Si este teléfono tiene tus 12 palabras, la cuenta vinculada también las conserva, por lo que restaurar con ella las devuelve. Una cuenta que vinculaste en una versión anterior de la app solo conserva tu clave: toca **Conectar de nuevo** junto a ella y supera la comprobación de la pantalla de bloqueo de tu teléfono para incluir las palabras. En un teléfono sin 12 palabras no hay nada que incluir, por lo que no se muestra **Conectar de nuevo**.

Esta no es una forma de iniciar sesión. Tu cuenta sigue siendo tu propia clave. La cuenta vinculada solo te ayuda a recuperarla, en esa comunidad.

Para eliminarla, toca **Desconectar**.

## Si habías vinculado GitHub

BeanPool ya no utiliza GitHub. El identificador de una cuenta de GitHub es público, por lo que una copia vinculada a ella no estaba protegida con nada que solo tú tuvieras. Cuando el servidor de tu comunidad se actualiza, elimina todas las copias vinculadas a GitHub. Tu cuenta en sí no se ve afectada y tus 12 palabras siguen funcionando.

- Si GitHub era la única cuenta que vinculaste y tus 12 palabras están en este teléfono pero no anotadas, anótalas ahora (**Ajustes**, luego **Ver frase de recuperación**), o vincula Google, Facebook o (en un iPhone) Apple, como se indica arriba. Hasta que hagas una de estas acciones, este teléfono es tu única vía de entrada a tu cuenta.
- Si tienes anotadas tus 12 palabras, no necesitas hacer nada. Para tener también una cuenta de inicio de sesión, vincula Google, Facebook o (en un iPhone) Apple, como se indica arriba.
- Si GitHub era la única cuenta que vinculaste, este teléfono no tiene 12 palabras y no las tienes anotadas, vincula Google, Facebook o (en un iPhone) Apple ahora. Hasta que lo hagas, este teléfono es tu única vía de entrada a tu cuenta.

## Quién puede abrir la copia

Una cuenta de inicio de sesión vinculada funciona porque el servidor de tu comunidad guarda una copia cifrada de tu cuenta para ella. Las personas que administran ese servidor pueden abrir esta copia, porque su servidor comprueba tu inicio de sesión. En la comunidad global, esa entidad es BeanPool. Una copia robada de la base de datos del servidor no puede abrirla, una vez que el servidor se ha actualizado para ello. Cualquier persona que tome el control de tu cuenta de inicio de sesión también puede entrar: consulta «Si alguien más lo intenta».

Si prefieres que nadie excepto tú pueda entrar, usa solo tus 12 palabras: mantenlas anotadas y toca **Desconectar** junto a cada cuenta de inicio de sesión. Desconectar elimina la copia. Un servidor de respaldo, el segundo servidor que algunas comunidades mantienen listo para asumir el control, también elimina su copia la próxima vez que copia del servidor principal (aproximadamente una vez por minuto). Desconectar no elimina las copias que ya están en los respaldos del servidor, ni la copia que el servidor conserva, como registro, cada vez que un inicio de sesión recupera tu cuenta. Las personas que administran el servidor también pueden abrirlas.

## Si alguien más lo intenta

Si alguien empieza a recuperar tu cuenta, Ajustes muestra **Alguien está recuperando tu cuenta** mientras el proceso está en curso. Si no eres tú, toca **Detener ahora**: el servidor de tu comunidad no entregará nada más a esa restauración. Si entran con tu cuenta de inicio de sesión vinculada, recibirás una alerta de que tu cuenta se acaba de restaurar en otro dispositivo, y es posible que ya hayan entrado para cuando la veas. Mantén segura esa cuenta de inicio de sesión, con su propia contraseña segura.

## Si el teléfono ya tiene una cuenta

Restaurar una cuenta diferente reemplaza la que está en este teléfono, ya sea que la restaures con tus 12 palabras o con una cuenta de inicio de sesión. La app pregunta primero, en **¿Reemplazar la cuenta de este teléfono?** (con una cuenta de inicio de sesión, una vez que hayas iniciado sesión). Nada cambia hasta que escribas **WIPE**, toques **Reemplazar cuenta** y superes la comprobación de la pantalla de bloqueo de tu teléfono. Toca **Conservar**, luego el nombre de la cuenta, **volver** para dejar todo como estaba.

Asegúrate de tener las 12 palabras de la cuenta que estás reemplazando. Si este teléfono las tiene, esa pantalla las muestra cuando tocas **Mostrar las 12 palabras de** (nombre de la cuenta) y superas la comprobación de la pantalla de bloqueo de tu teléfono. Si este teléfono no tiene 12 palabras para esa cuenta (Ajustes lo indica), sin una cuenta de inicio de sesión vinculada no podrás recuperarla.

## Perdiste tu teléfono y tus 12 palabras

Sin tus 12 palabras y sin una cuenta de inicio de sesión vinculada, un administrador de tu comunidad puede transferir tu cuenta a un teléfono nuevo, con tus frijoles, tu nombre y tu historial. Ve a verlo en persona: primero comprobará que seas tú.

- El administrador genera un código de cambio de clave en su pantalla. Si tu teléfono anterior todavía tiene la app, recibe un aviso de que un administrador comenzó a transferir tu cuenta.
- En tu teléfono nuevo, abre BeanPool, toca **¿Ya eres miembro? Restaurar cuenta**, luego **Un administrador me dio un código de cambio de clave**. Escanea el código QR en la pantalla del administrador o escribe el código (comienza con RK-) y el nombre de tu comunidad. En un navegador, el enlace del código QR abre la misma pantalla; o abre la aplicación web de tu comunidad, toca **Ya soy miembro →**, luego **Un administrador me dio un código de cambio de clave** y escribe el código.
- Tu teléfono muestra un número de dos dígitos y, debajo, la dirección de la comunidad a la que consultó. Muestra ambos al administrador: él escribe el número en su pantalla. El número asegura que sea tu teléfono el que vinculen y no alguien que vio el código. **Ahora no** deja el número: tu teléfono conserva su lugar y el mismo código vuelve a mostrar el mismo número.
- Si el teléfono nuevo no tenía cuenta de BeanPool, entonces muestra las 12 palabras de tu **nueva** clave. Anótalas: tus palabras anteriores ya no funcionan y tu teléfono antiguo deja de funcionar definitivamente. Un teléfono que ya tenía una cuenta (para otra comunidad) conserva las 12 palabras de esa cuenta, y ahora recuperan esta cuenta también.
- Si habías vinculado una cuenta de inicio de sesión, tu teléfono te pide que la vincules nuevamente en Protección de la cuenta: la que tenías protegía tu clave anterior, por lo que fue eliminada.
- Las personas con las que chateas verán que tu clave cambió. Diles que fuiste tú y léeles tu **Mi código de clave**, en **Ajustes**, en **Protección de la cuenta** en el teléfono. Consulta «Si un chat dice que la clave detrás de un nombre cambió».

El código dura 24 horas. Si tu administrador dice que tu teléfono no es el que vio o el código caduca, pídele uno nuevo.
