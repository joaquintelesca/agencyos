// Utilidades de formato compartidas por varias pantallas — antes duplicadas en cada archivo.

export function initials(name, fallback = '') {
  return name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || fallback;
}

// d viene como "YYYY-MM-DD". Se parsea como medianoche LOCAL (no UTC) y se compara contra
// la medianoche local de hoy, para que "días restantes" no se corra según el timezone/hora.
// `new Date("2026-09-25")` a secas es medianoche UTC, así que comparado contra un `new Date()`
// local en UTC-3 después de las 21h da un día menos: un deadline de hoy pasaba a contar -1.
export function daysUntil(d) {
  if (!d) return null;
  // d normalmente viene como "YYYY-MM-DD" plano, pero por las dudas soporta también un ISO
  // completo (ej. "2026-09-01T00:00:00.000Z") sin romperse — se queda solo con la parte de fecha.
  const deadline = new Date(String(d).slice(0, 10) + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((deadline - today) / 86400000);
}

// "YYYY-MM" del mes LOCAL de un timestamp. Las fechas de pago se guardan con toISOString() (UTC),
// así que cortarlas con slice(0,7) mete un cobro marcado el 30 a las 22h de Argentina en el mes
// siguiente, descuadrando dos balances mensuales de una.
export function monthKey(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function deadlineLabel(d) {
  if (!d) return null;
  const diff = daysUntil(d);
  if (diff < 0) return { label: 'Vencido', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
  if (diff === 0) return { label: 'Vence hoy', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
  if (diff === 1) return { label: 'Mañana', color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
  if (diff <= 7) return { label: `En ${diff} días`, color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
  return { label: `En ${diff} días`, color: 'var(--green)', bg: 'rgba(34,201,122,0.12)' };
}
