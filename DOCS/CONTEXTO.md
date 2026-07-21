AgencyOS — Contexto conceptual del proyecto
Documento de referencia para retomar el desarrollo en VS Code. Pensado para pegarse como contexto a una IA.

1. Qué es AgencyOS y para quién es

AgencyOS es una aplicación de gestión interna para una agencia de edición de video. Reemplaza la combinación de Slack (chat), Notion (gestión de proyectos y tareas) y Frame.io (revisión de video con comentarios sobre el timeline), unificando todo en una sola herramienta pensada específicamente para el flujo de trabajo de una agencia de video: clientes que encargan proyectos, editores que producen contenido, y un administrador (el dueño de la agencia) que coordina todo y gestiona los cobros y pagos.

La aplicación corre como una página web (no es una app de escritorio) y está deployada en internet, de forma que tanto el administrador como los editores pueden acceder desde cualquier lugar del mundo con una URL fija, sin depender de que una computadora específica esté encendida.

2. Roles: Admin y Editor

Existen dos roles dentro del sistema, con permisos claramente diferenciados:

Admin

Es el dueño de la agencia. Tiene control total: puede crear y eliminar clientes, proyectos, tareas y usuarios; puede ver todos los proyectos y todo el equipo; gestiona la sección de Pagos (que los editores no pueden ver); puede agrupar editores en canales de chat; puede moderar comentarios de cualquier usuario; y puede asignar editores a proyectos específicos.

Editor

Es un freelancer o miembro del equipo de edición. Solo puede ver y trabajar en los proyectos a los que fue asignado como miembro. No tiene acceso a la sección de Pagos. No puede ver el listado completo de otros editores ni sus datos de contacto. No puede crear ni eliminar clientes. Puede subir videos, comentar, responder comentarios, completar tareas y chatear, pero únicamente dentro de los proyectos donde es miembro.

3. Jerarquía: Clientes → Proyectos → Tareas

La estructura de datos del negocio sigue tres niveles anidados:

• Cliente: una marca o empresa externa que contrata a la agencia (ej. Nike, Adidas). Tiene nombre, color identificador, datos de contacto y notas internas.
• Proyecto: un trabajo específico para ese cliente (ej. 'Comercial verano 2026'). Cada proyecto tiene un editor asignado, una fecha límite (deadline), un estado de pago, y pertenece a un único cliente.
• Tarea: una unidad de trabajo concreta dentro de un proyecto, organizada en un tablero estilo Kanban con columnas Pendiente, En progreso, Revisión y Listo.
Esta jerarquía le permite al admin ver de un vistazo cuántos proyectos tiene cada cliente, y a su vez cuántas tareas tiene cada proyecto, sin mezclar información de distintos clientes.

4. Sistema de pagos: doble columna independiente

El núcleo del valor de negocio de la app es la gestión de pagos, y se diseñó deliberadamente para separar dos flujos de dinero que son independientes entre sí:

• Pagado al editor: indica si la agencia ya le pagó al editor freelance por su trabajo en ese proyecto.
• Cobrado al cliente: indica si el cliente ya le pagó a la agencia por el proyecto entregado.
Estos dos estados se manejan con controles totalmente separados, porque en la práctica no están sincronizados: la agencia puede pagarle al editor antes de cobrarle al cliente, o viceversa. Cuando un proyecto tiene AMBOS marcados como completos, se mueve automáticamente de la pestaña 'Activos' a la pestaña 'Completados' dentro de la sección Pagos, sirviendo como un registro histórico de transacciones cerradas. Esta sección es visible únicamente para el rol Admin.

5. Privacidad entre editores

Un principio de diseño no negociable de la aplicación es que los editores nunca deben poder verse entre sí, a menos que el admin los agrupe explícitamente en un mismo canal de chat o proyecto. Esto significa que un editor no puede ver el listado de otros editores, sus datos de contacto, ni en qué otros proyectos están trabajando. Esta restricción se implementó tanto a nivel de interfaz (ocultando esa información) como a nivel de servidor (bloqueando las consultas que intentarían acceder a esos datos), ya que inicialmente solo estaba aplicada en el frontend y representaba una falla de seguridad real.

6. Chat y revisión de video

Chat

El sistema de chat funciona de forma similar a Slack: existen mensajes directos (uno a uno) y canales grupales creados por el admin. Los mensajes se entregan en tiempo real mediante conexiones de socket (WebSockets), de forma que cuando alguien envía un mensaje, la otra persona lo ve aparecer sin necesidad de recargar la página. Soporta texto, archivos adjuntos, imágenes, video y notas de voz grabadas desde el navegador.

Revisión de video

Inspirado en Frame.io, cada proyecto tiene una sección de Videos donde se pueden subir distintas versiones de un mismo entregable. Sobre el reproductor de video se pueden dejar comentarios anclados a un momento exacto del timeline (o a un rango de tiempo), incluyendo dibujos a mano libre (flechas, rectángulos, líneas) superpuestos sobre el frame del video. Los comentarios se pueden marcar como resueltos, y tienen hilos de respuesta con sus propios archivos adjuntos.

7. El sistema de 'miembros de proyecto' (project_members)

Este es uno de los cambios más importantes incorporados durante el desarrollo. Originalmente, cualquier usuario autenticado (incluyendo editores) podía acceder a los datos de cualquier proyecto simplemente conociendo o adivinando su identificador, sin que el sistema verificara si esa persona realmente pertenecía a ese proyecto. Esto representaba una falla de seguridad grave: un editor podía leer tareas, mensajes, videos y comentarios de proyectos ajenos.

La solución fue introducir una tabla de 'miembros de proyecto' que registra explícitamente qué usuarios pertenecen a qué proyecto. Esta tabla se completó automáticamente la primera vez a partir de los datos ya existentes (quién creó el proyecto, quién es el editor de pago asignado, quién subió cada video, quién participó en el chat o comentó). A partir de esa migración, cada vez que un editor intenta acceder a cualquier dato de un proyecto, el servidor verifica primero si esa persona figura como miembro; si no lo es, la solicitud se rechaza. El rol Admin está exceptuado de esta verificación y siempre tiene acceso completo, ya que su función es supervisar todo el negocio.

Este mismo concepto de pertenencia se aplicó también a la mensajería en tiempo real: antes, un mensaje de chat de un proyecto se transmitía a todas las personas conectadas a la aplicación en ese momento, sin filtrar por quién debía realmente recibirlo. Ahora los mensajes solo se envían a la 'sala' de comunicación específica de ese proyecto, a la que solo se unen sus miembros verificados.

8. Estado actual: lo que está resuelto y lo que falta

Resuelto

• Autenticación de sockets mediante token, evitando que alguien pueda hacerse pasar por otro usuario.
• Restricción de registro de nuevas cuentas, de forma que un editor no pueda autopromoverse a administrador.
• Verificación de rol y pertenencia en las operaciones de edición y borrado de proyectos, tareas, clientes, videos y comentarios.
• Límite de intentos de inicio de sesión para evitar ataques de fuerza bruta.
• Los eventos financieros (actualización de pagos) ya no se transmiten a todos los usuarios conectados, solo a los administradores.
• Un administrador puede cambiar su propia contraseña y moderar comentarios de cualquier usuario.
• Borrado en cascada: al eliminar un proyecto o un cliente, se limpian correctamente las referencias relacionadas en lugar de dejar datos huérfanos.
• La carga de mensajes en el chat y en proyectos ahora usa paginación: se cargan los 50 más recientes y al scrollear hacia arriba se cargan los anteriores bajo demanda.
• Todos los mensajes de error del servidor están traducidos al español con textos claros para el usuario.
• La subida de archivos en el chat valida el tipo MIME contra una whitelist (imágenes, videos, audios, PDFs y texto plano), rechazando archivos no permitidos.
• Protección del último administrador: no se puede eliminar ni cambiar el rol del único admin restante.
• El cálculo de espacio de almacenamiento utilizado se cachea por 60 segundos, evitando escaneos repetidos del disco.
• Se limpió el código muerto del Dashboard (componentes ClientKanban/ProjectKanbanRow y variables sin usar).
• Dashboard: sección 'Esperando tu aprobación' muestra tareas en revisión de todos los proyectos con cliente, editor y estado.
• Videos: sistema de stacking — se pueden apilar versiones de un video con drag and drop, y al subir nueva versión se apilan automáticamente. Campo group_id en la tabla videos.
• Videos: fix del bug que impedía crear comentarios (pluck→select en subquery de notificaciones). Delete y respuestas ahora actualizan el estado local sin depender del socket.
• Equipo: panel lateral de seguimiento por editor (tareas pendientes, resumen de pagos pagados/pendientes) visible solo para admin.
• Pagos: filtros por cliente y por editor en ambas pestañas. Los proyectos solo aparecen en Pagos cuando tienen al menos una tarea en 'Listo'.
• Crear proyecto: editor y precio son obligatorios. Al asignar un editor a una tarea, se auto-asigna como editor de pago si el proyecto no tiene uno.
• Editar proyecto (lápiz del sidebar): se puede cambiar el editor asignado y el precio/tipo de pago.
• Header de proyecto: muestra el nombre del editor asignado junto al título. Soporte de query param ?tab=videos para navegación directa.
• Dashboard: sección 'Videos pendientes de revisión' muestra videos vinculados a tareas en revisión o con comentarios sin resolver. Clic navega directo a la pestaña de videos del proyecto.
• Privacidad entre editores reforzada a nivel de servidor: GET /api/users para no-admins ahora devuelve solo admins + el propio usuario, sin exponer a otros editores.
• Los endpoints de proyectos (lista y detalle) incluyen payment_editor_name y payment_editor_color via JOIN, eliminando la necesidad de buscar el editor en la lista de usuarios en el frontend.
• Bug fix: el contador 'Deadlines esta semana' del Dashboard ahora cuenta correctamente solo proyectos con deadline entre hoy y los próximos 7 días.
• Bug fix: al eliminar un video, se limpian correctamente reply_attachments antes de borrar comment_replies, evitando filas huérfanas en la base de datos.
• Performance: GET /api/projects reemplazó N×3 queries de COUNT individuales por un único GROUP BY, reduciendo la carga al servidor independientemente de la cantidad de proyectos.
• Bug fix: PUT /api/projects/:id y PATCH /api/payments/:projectId devuelven 404 en lugar de crash/body vacío cuando el ID no existe.
• Bug fix: DELETE /api/users/:id devuelve 404 si el usuario no existe (antes retornaba success silencioso).
• Bug fix: DELETE /api/tasks/:id restringido para editores — solo pueden borrar sus propias tareas asignadas (consistente con PUT).
• Bug fix: PATCH /api/clients/:id valida que el nombre no esté vacío.
• Bug fix: stack_with al subir video ignora el video padre si pertenece a otro proyecto.
• Privacidad: GET /api/projects/:id/tasks filtrado por rol — editores solo ven sus propias tareas asignadas, no las de otros editores del mismo proyecto.
• Notificaciones: nuevos tipos project_assigned (editor asignado a un proyecto) y task_assigned (editor asignado a una tarea). Se emiten al crear o reasignar.
• Notificaciones de chat: se agrupan por emisor mientras estén sin leer — N mensajes del mismo remitente generan 1 sola notificación (se actualiza el preview con el último mensaje).
• Bug fix Team: panel lateral de editor mostraba $0 para proyectos por horas (campo payment_rate inexistente → corregido a payment_amount).
• Bug fix Team: botones editar/eliminar en cards de usuario ahora detienen propagación del click (antes abrían panel de detalle y modal simultáneamente).
• Bug fix Pagos: total de horas en ProjectRow se calcula con el state local hours, actualizándose en tiempo real mientras el usuario escribe.
• Bug fix Notificaciones: el contador rojo del sidebar ahora baja correctamente al abrir una notificación o marcar todo como leído (antes solo se actualizaba la página de notificaciones, no el sidebar).
• Seguridad (auditoría completa del código — 3 críticos y 15 altos corregidos):
  - Los archivos subidos (videos, adjuntos de chat y de comentarios) ya no son públicos: hace falta estar logueado y ser miembro del proyecto/conversación dueña del archivo para descargarlos.
  - Se cerró un hueco que permitía subir un archivo peligroso (ej. HTML con código) disfrazado de imagen o video; ahora el tipo de archivo se valida de verdad, no solo por el nombre.
  - Se sacaron del login público las credenciales de admin por defecto (solo se muestran en desarrollo local).
  - Un admin degradado o eliminado pierde el acceso al instante, ya no sigue actuando como admin con su sesión vieja.
  - Un editor ya no puede ver el listado completo de clientes de la agencia ni la lista de todos los demás usuarios conectados — solo lo que le corresponde según sus proyectos/canales.
  - Borrar un usuario ahora limpia correctamente todo lo relacionado (adjuntos, respuestas de otros a sus comentarios, mensajes directos recibidos) sin dejar datos huérfanos.
  - Solo el admin puede crear tareas (antes cualquier editor con acceso al proyecto podía crear una tarea y asignarla a cualquier persona, agregándola al proyecto sin pasar por el admin).
• Bug fix Videos: el dibujo sobre el video (flechas, rectángulos, etc.) ahora queda alineado incluso en videos verticales o que no son 16:9; antes se desalineaba. También se guardan todos los trazos de un comentario, no solo el último, y borrar un comentario pide confirmación.
• Bug fix Chat/Videos: se corrigieron condiciones de carrera que podían mostrar mensajes o comentarios de la conversación/video anterior si se cambiaba rápido de uno a otro.
• Bug fix Pagos: las horas de un proyecto se actualizan si otra sesión las cambia mientras la pantalla está abierta, y ya no se pueden cargar horas o montos negativos.
• Bug fix: al hacer clic en una notificación de comentario de video, ahora sí se abre la pestaña de Videos Y el video correcto (antes solo cambiaba la URL sin actualizar la pantalla).
• Auditoría de código, segunda tanda (hallazgos Medio y Bajo, complementan la seguridad de arriba):
  - Al borrar un proyecto, video o comentario, ahora se borran también los archivos adjuntos del disco (antes solo se borraba la fila de la base de datos, y el archivo quedaba ocupando espacio para siempre).
  - Esos mismos borrados ahora son "todo o nada": si algo falla a mitad de camino, no queda información a medio borrar.
  - Un dibujo mal guardado en un comentario ya no puede tumbar la lista completa de comentarios de ese video para todos los usuarios.
  - Revisar el espacio usado en disco ya no traba el servidor mientras escanea (antes bloqueaba a todos los usuarios conectados un instante en cada subida de video).
  - El resto de las acciones de Videos (comentar, responder, resolver, subir, agrupar) ahora avisan si algo falla en vez de quedar en silencio.
  - Revisar un comentario viejo durante la reproducción ya no reabre por error la caja de "comentario nuevo".
  - El dashboard ahora muestra el editor real asignado a cada proyecto en "Próximos deadlines" (antes podía mostrar a cualquiera con una tarea asignada).
  - El cálculo de "vence hoy / vencido" en los deadlines ya no se corre por el huso horario.
  - Un mensaje en el chat de un proyecto ahora genera notificación para los demás miembros, no solo el aviso en tiempo real (si estaban offline, antes no se enteraban).
  - Limpieza de código: se unificó en un solo archivo compartido (`utils/format.js`) la lógica de iniciales y de "días para el deadline" que estaba copiada en 6 pantallas distintas; se sacó código muerto y duplicado en el sidebar y en Pagos.
9. Infraestructura actual

La aplicación está deployada en Render (plan gratuito), con el código fuente alojado en un repositorio privado de GitHub. El plan gratuito de Render tiene una limitación importante: el sistema de archivos del servidor no es permanente, por lo que la base de datos (actualmente SQLite) se reinicia y pierde todos los datos cada vez que el servicio se reinicia por inactividad o por un nuevo despliegue de código. Esta es la tarea pendiente de mayor impacto práctico: migrar la base de datos a un servicio externo persistente y gratuito (como Supabase o Neon, ambos basados en PostgreSQL), de forma que los usuarios, clientes y proyectos cargados no se pierdan.

A futuro, una vez que la aplicación esté funcionalmente completa y estable, está planeado envolverla como una aplicación de escritorio descargable usando Electron, similar a como Slack o Notion ofrecen tanto una versión web como una aplicación instalable que en el fondo utiliza el mismo código web.
