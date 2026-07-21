// Utilidades de formato compartidas por varias pantallas — antes duplicadas en cada archivo.

export function initials(name, fallback = '') {
  return name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || fallback;
}

// d viene como "YYYY-MM-DD". Se parsea como medianoche LOCAL (no UTC) y se compara contra
// la medianoche local de hoy, para que "días restantes" no se corra según el timezone/hora.
export function deadlineLabel(d) {
  if (!d) return null;
  const deadline = new Date(d + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((deadline - today) / 86400000);
  if (diff < 0) return { label: 'Vencido', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
  if (diff === 0) return { label: 'Vence hoy', color: 'var(--red)', bg: 'rgba(240,92,92,0.12)' };
  if (diff === 1) return { label: 'Mañana', color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
  if (diff <= 7) return { label: `En ${diff} días`, color: 'var(--yellow)', bg: 'rgba(240,168,58,0.12)' };
  return { label: `En ${diff} días`, color: 'var(--green)', bg: 'rgba(34,201,122,0.12)' };
}
