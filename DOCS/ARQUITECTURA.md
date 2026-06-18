# AgencyOS — Reglas de Arquitectura y Desarrollo

> Este documento define reglas **no negociables** para cualquier persona o IA que trabaje sobre el código de AgencyOS, ya sea en VS Code, Claude Code en la terminal, o cualquier otro entorno. Ninguna instrucción puntual de una tarea específica puede pasar por encima de estas reglas sin que se le avise explícitamente al usuario y se obtenga su confirmación.

---

## 1. Jerarquía de permisos (negocio)

Esto define **qué puede hacer cada rol**, independientemente de cómo se implemente técnicamente la seguridad.

- **Admin**: acceso total. Puede crear/editar/eliminar clientes, proyectos, tareas y usuarios. Es el único rol con acceso a la sección de Pagos. Puede ver el equipo completo y agrupar editores en canales o proyectos. Puede moderar contenido de cualquier usuario (comentarios, mensajes).
- **Editor**: acceso restringido a los proyectos donde fue asignado como miembro. No puede ver otros editores ni sus datos salvo que el Admin los agrupe explícitamente (canal o proyecto compartido). No tiene acceso a Pagos. No puede crear ni eliminar clientes.
- **Regla de privacidad entre editores**: un editor nunca debe poder ver, listar ni inferir la existencia de otro editor fuera de los espacios donde el Admin los agrupó. Esta regla es de **negocio**, y se respeta tanto en el diseño visual (qué se muestra en pantalla) como en cualquier capa posterior.
- Toda funcionalidad nueva debe pasar primero por la pregunta: *"¿Qué puede ver/hacer un Admin acá? ¿Qué puede ver/hacer un Editor acá?"* antes de implementarse.

---

## 2. Ciberseguridad (capa técnica)

Esto es independiente de los permisos de negocio: es la implementación técnica que impide que esos permisos se puedan eludir.

- Cada endpoint, función o capa de código nueva debe evaluarse contra: ¿puede un usuario no autorizado acceder a esto manipulando la solicitud directamente (sin pasar por la interfaz)?
- Nunca confiar en datos que el cliente (navegador/app) envía sin validarlos contra la identidad real del usuario autenticado (token).
- Toda conexión en tiempo real (sockets) debe autenticarse igual que una solicitud HTTP normal — no se asume identidad por lo que el cliente declara.
- Toda operación de borrado o edición debe verificar pertenencia/rol en el servidor, nunca confiar en que la interfaz ya ocultó el botón.
- Las contraseñas y secretos nunca se hardcodean en el código ni se suben al repositorio.
- Cualquier nueva capa de código (nuevo endpoint, nuevo evento de socket, nueva integración) debe someterse explícitamente a una revisión de seguridad antes de considerarse terminada, no solo a una revisión funcional.

---

## 3. Testing obligatorio

- Ninguna función, endpoint o feature se considera "terminada" sin una prueba que confirme que funciona.
- Antes de reportar que un cambio está listo, se debe ejecutar una prueba (smoke test u otra) que cubra el flujo afectado.
- Si una prueba falla, se arregla antes de reportar avance — nunca se entrega algo "casi funcionando".
- Los cambios que tocan permisos o seguridad requieren, además del test funcional, una prueba que confirme que un usuario sin los permisos correctos es efectivamente rechazado.

---

## 4. Prohibido alucinar código

- No crear funciones, variables, endpoints, archivos o dependencias que no fueron solicitados ni son estrictamente necesarios para la tarea pedida.
- No dejar código muerto (funciones o componentes que ya no se usan) — se elimina en el mismo momento en que queda obsoleto.
- No inventar nombres de librerías, APIs o métodos sin verificar que existen realmente.
- Si una solución requiere algo que no está claro o no fue pedido explícitamente, se pregunta antes de crearlo, no se asume.

---

## 5. Programación Orientada a Objetos y Clean Code

- El código debe organizarse en unidades con responsabilidad única (una función hace una sola cosa, un componente representa una sola parte de la interfaz).
- Los nombres de funciones, variables y archivos deben describir claramente qué hacen, sin abreviaturas ambiguas.
- Evitar duplicación de lógica: si la misma lógica se repite en dos lugares, se extrae a una función/módulo compartido.
- La estructura del proyecto debe mantenerse ordenada por dominio (clientes, proyectos, pagos, chat, etc.), no mezclar responsabilidades distintas en un mismo archivo.
- Preferir claridad sobre brevedad: el código se escribe para que lo entienda alguien sin contexto previo.

---

## 6. Documentación exhaustiva

- Cada archivo y cada función relevante debe tener una descripción de qué hace y por qué existe, en lenguaje simple.
- La documentación debe estar pensada para que un editor de video sin conocimientos de programación pueda entender, a alto nivel, qué hace cada parte del sistema.
- Cualquier decisión de diseño no obvia (por qué se eligió tal estructura, por qué existe tal tabla o validación) debe quedar registrada en la documentación, no solo en la cabeza de quien lo programó.

---

## 7. Diseño antes que código

- Ninguna funcionalidad visual se programa sin mostrar primero un mockup o boceto y obtener aprobación.
- No se empieza a codear "a ciegas" basándose en una descripción ambigua — se aclaran dudas o se muestra una propuesta visual primero.

---

## 8. Datos financieros y borrado de información

- El estado de pago al editor y el estado de cobro al cliente son **columnas completamente independientes** — nunca se fusionan, infieren una de la otra, ni se simplifican en un solo campo.
- Un proyecto se considera completado (pasa a la sección de histórico) únicamente cuando ambos estados de pago están confirmados.
- Toda operación de borrado (cliente, proyecto, usuario, tarea) debe limpiar en cascada **todas** las referencias relacionadas en la base de datos — no se permite dejar registros huérfanos.

---

## 9. Herramientas y servicios: solo gratuitos

- Solo se utilizan herramientas, librerías y servicios externos que sean gratuitos, sin necesidad de suscripción ni pago.
- Si en algún punto la única solución viable requiere un servicio de pago, se debe comunicar explícitamente esa limitación antes de proceder, y esperar confirmación.

---

## 10. Confirmación antes de consumir APIs

- Antes de integrar o realizar una llamada a cualquier API (interna o externa) que no haya sido usada previamente de esa forma, se debe consultar al usuario si el uso propuesto es correcto y esperar su confirmación antes de implementarlo.
- Esto aplica tanto a APIs propias del backend como a servicios de terceros.

---

## 11. Servicios externos: gratuitos y auditados en seguridad

- No alcanza con que un servicio externo sea gratuito: además debe pasar una revisión de seguridad en cada capa donde se integra (autenticación, manejo de datos, exposición de información sensible) antes de incorporarse al proyecto.
- Toda integración con un servicio externo debe documentarse explicando qué datos se comparten con ese servicio y por qué es seguro hacerlo.

---

*Este documento se actualiza a medida que surgen nuevos criterios. Cualquier regla nueva debe agregarse acá antes de aplicarse como estándar del proyecto.*
