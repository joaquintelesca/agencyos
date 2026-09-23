// Días hábiles (lunes a viernes) entre dos fechas — un fin de semana de por medio no cuenta como
// "N días sin respuesta" de la misma forma que N días de semana. Extraído de review-reminders.js
// cuando payment-reminders.js necesitó exactamente la misma cuenta.
function businessDaysBetween(from, to) {
  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay(); // 0 = domingo, 6 = sábado
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

module.exports = { businessDaysBetween };
