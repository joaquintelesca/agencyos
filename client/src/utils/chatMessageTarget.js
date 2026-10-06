// Para un mensaje de chat general (DM/canal), el título de la fila es "con quién" (la contraparte
// del DM, o el canal), no el contenido — mismo criterio que dm-tabs/conversations del lado del
// servidor. Un DM propio con uno mismo ("Notas") tiene sender_id === receiver_id === yo, por eso
// se chequea explícitamente antes que la resta sender/receiver de cualquier otro caso. Extraído
// de SearchPalette.jsx para reusarlo también en la lista de mensajes guardados.
export default function chatMessageTarget(m, myId) {
  if (m.type === 'channel') return { label: `#${m.channel_name || 'canal'}`, path: `/chat?type=channel&id=${m.channel_id}&message=${m.id}` };
  const isSelfNote = m.sender_id === myId && m.receiver_id === myId;
  const otherId = isSelfNote ? myId : (m.sender_id === myId ? m.receiver_id : m.sender_id);
  const otherName = isSelfNote ? 'Notas' : (m.sender_id === myId ? m.receiver_name : m.sender_name);
  const clientParam = m.client_id ? `&client=${m.client_id}` : '';
  return { label: otherName, path: `/chat?type=dm&id=${otherId}&message=${m.id}${clientParam}` };
}
