// ─── CÁLCULO DE MONTOS DE PAGO ─────────────────────────────────────────────────
// Misma lógica que replican Payments.jsx/Dashboard.jsx del lado del cliente — acá hace falta
// para poder "congelar" el monto real en el momento exacto en que se marca pagado/cobrado.
// Separado de server/index.js (y no solo definido ahí) para poder testearlo sin levantar todo el
// servidor — son funciones puras, sin DB ni HTTP de por medio, el caso ideal para un test unitario.

// El único cuyo auto-asignarse como editor de un proyecto NO representa un pago real es el dueño
// de la agencia — decisión explícita del usuario, no "cualquier admin": antes se chequeaba
// `role === 'admin'`, así que el día que exista un segundo admin (un socio, alguien que ayude a
// gestionar pagos) y ESE admin sea el editor asignado, un cliente pagando marcaba el proyecto como
// saldado solo, aunque a ese admin nunca se le hubiera pagado de verdad. Por email, no por id: el
// id cambia entre entornos (dev/prod), el email de la cuenta real no.
const OWNER_EMAIL = 'joaquintelesca@gmail.com';

// El 15% es el default de Upwork, pero `parseFloat(x) || 15` convertía un 0% negociado (falsy)
// en 15% y subestimaba el neto del cliente en ese 15% en cada guardado.
function parseUpworkFeePct(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 15;
}
function computeEditorAmount(p) {
  if (p.payment_type === 'hourly') return (parseFloat(p.payment_amount) || 0) * (parseFloat(p.payment_hours) || 0);
  return parseFloat(p.payment_amount) || 0;
}
function computeClientGrossAmount(p) {
  if (p.payment_type === 'hourly') return (parseFloat(p.client_amount) || 0) * (parseFloat(p.payment_hours) || 0);
  return parseFloat(p.client_amount) || 0;
}
function computeClientNetAmount(p) {
  const gross = computeClientGrossAmount(p);
  const isUpworkBilled = p.upwork_status === 'Pendiente de carga' || p.upwork_status === 'Cargado';
  if (!isUpworkBilled) return gross;
  return gross * (1 - (parseFloat(p.upwork_fee_pct) || 0) / 100);
}

// Antes Dashboard.jsx y Payments.jsx reimplementaban esta misma cuenta cada uno por su lado (3
// copias entre servidor y los dos archivos de cliente) — si mañana cambia una regla de negocio
// (ej. cómo se calcula el neto de Upwork), hay que acordarse de tocar los 3 lugares. Estos 3
// campos calculados van en la respuesta de cualquier endpoint que devuelva proyectos con datos de
// pago, así que el cliente solo los lee en vez de recalcularlos — "congelado si ya está saldado
// (editor_paid/client_paid), en vivo si no" es exactamente lo que antes hacían displayEditorAmount/
// displayClientGross/displayClientNet en Payments.jsx a mano.
// `_editor_email` es un campo temporal que cada query mete con un .select() extra junto a
// payment_editor_name/editor_name (mismo join, un campo más) — withComputedTotals lo consume acá
// y lo borra, así el cliente nunca ve el email real, solo el booleano que le hace falta para
// decidir si mostrar el toggle de "pagado al editor" o el "No aplica".
function withComputedTotals(p) {
  if (!p) return p;
  p.editor_is_owner = p._editor_email === OWNER_EMAIL;
  delete p._editor_email;
  p.computed_editor_total = p.editor_paid === 'paid' && p.editor_paid_amount != null ? Number(p.editor_paid_amount) : computeEditorAmount(p);
  p.computed_client_gross = p.client_paid === 'cobrado' && p.client_paid_amount_gross != null ? Number(p.client_paid_amount_gross) : computeClientGrossAmount(p);
  p.computed_client_net = p.client_paid === 'cobrado' && p.client_paid_amount_net != null ? Number(p.client_paid_amount_net) : computeClientNetAmount(p);
  return p;
}

module.exports = {
  OWNER_EMAIL,
  parseUpworkFeePct,
  computeEditorAmount,
  computeClientGrossAmount,
  computeClientNetAmount,
  withComputedTotals,
};
