import { decimalHoursToParts, partsToDecimalHours } from '../utils/format';

// Reemplaza el input único "horas trabajadas" en los 3 lugares donde se carga a mano (wizard de
// proyecto nuevo, editar proyecto, modal de precio) — pedido explícito del usuario: los proyectos
// por hora a veces cierran en minutos sueltos (5h20m), no solo horas enteras, y antes no había
// forma de cargar eso sin redondear. Minutos de a 10 nada más (no minuto a minuto), como se pidió.
// `value`/`onChange` siguen siendo el decimal de siempre (5.33) — nada del resto del código (cálculo
// de montos, guardado) necesita enterarse de que ahora se carga en dos partes.
export default function HoursMinutesInput({ value, onChange, disabled, title }) {
  const { hours, minutes } = decimalHoursToParts(value);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input className="input" type="number" min="0" step="1" disabled={disabled} title={title}
        value={hours === 0 && !value ? '' : hours}
        onChange={e => onChange(partsToDecimalHours(e.target.value, minutes))}
        placeholder="Horas" style={{ flex: 1 }} />
      <select className="input" disabled={disabled} title={title} value={minutes}
        onChange={e => onChange(partsToDecimalHours(hours, e.target.value))}
        style={{ width: 90, flexShrink: 0 }}>
        {[0, 10, 20, 30, 40, 50].map(m => <option key={m} value={m}>{m} min</option>)}
      </select>
    </div>
  );
}
