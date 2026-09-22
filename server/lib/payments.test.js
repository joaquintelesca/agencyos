const {
  OWNER_EMAIL,
  parseUpworkFeePct,
  computeEditorAmount,
  computeClientGrossAmount,
  computeClientNetAmount,
  withComputedTotals,
} = require('./payments');

describe('parseUpworkFeePct', () => {
  it('devuelve el 15% por default si no hay valor', () => {
    expect(parseUpworkFeePct(undefined)).toBe(15);
    expect(parseUpworkFeePct(null)).toBe(15);
    expect(parseUpworkFeePct('')).toBe(15);
  });

  it('acepta 0% negociado sin caer al default (0 es falsy, no "sin valor")', () => {
    expect(parseUpworkFeePct(0)).toBe(0);
    expect(parseUpworkFeePct('0')).toBe(0);
  });

  it('clampea valores fuera de rango a [0, 100]', () => {
    expect(parseUpworkFeePct(150)).toBe(100);
    expect(parseUpworkFeePct(-5)).toBe(0);
  });

  it('respeta un porcentaje válido dentro de rango', () => {
    expect(parseUpworkFeePct(12.5)).toBe(12.5);
  });
});

describe('computeEditorAmount', () => {
  it('precio fijo: usa payment_amount directo', () => {
    expect(computeEditorAmount({ payment_type: 'fixed', payment_amount: 500 })).toBe(500);
  });

  it('por horas: multiplica payment_amount (tarifa) por payment_hours', () => {
    expect(computeEditorAmount({ payment_type: 'hourly', payment_amount: 20, payment_hours: 8 })).toBe(160);
  });

  it('campos faltantes o no numéricos caen a 0, no a NaN', () => {
    expect(computeEditorAmount({ payment_type: 'fixed', payment_amount: null })).toBe(0);
    expect(computeEditorAmount({ payment_type: 'hourly', payment_amount: 20, payment_hours: undefined })).toBe(0);
  });
});

describe('computeClientGrossAmount', () => {
  it('precio fijo: usa client_amount directo', () => {
    expect(computeClientGrossAmount({ payment_type: 'fixed', client_amount: 800 })).toBe(800);
  });

  it('por horas: multiplica client_amount (tarifa al cliente) por payment_hours', () => {
    expect(computeClientGrossAmount({ payment_type: 'hourly', client_amount: 35, payment_hours: 8 })).toBe(280);
  });
});

describe('computeClientNetAmount', () => {
  it('sin facturación por Upwork, el neto es igual al bruto', () => {
    const p = { payment_type: 'fixed', client_amount: 1000, upwork_status: 'No' };
    expect(computeClientNetAmount(p)).toBe(1000);
  });

  it('con Upwork "Cargado", descuenta la comisión del bruto', () => {
    const p = { payment_type: 'fixed', client_amount: 1000, upwork_status: 'Cargado', upwork_fee_pct: 15 };
    expect(computeClientNetAmount(p)).toBe(850);
  });

  it('con Upwork "Pendiente de carga" también aplica la comisión (no solo "Cargado")', () => {
    const p = { payment_type: 'fixed', client_amount: 1000, upwork_status: 'Pendiente de carga', upwork_fee_pct: 20 };
    expect(computeClientNetAmount(p)).toBe(800);
  });

  it('0% de comisión negociado no descuenta nada (el bug histórico de "0 es falsy")', () => {
    const p = { payment_type: 'fixed', client_amount: 1000, upwork_status: 'Cargado', upwork_fee_pct: 0 };
    expect(computeClientNetAmount(p)).toBe(1000);
  });
});

describe('withComputedTotals', () => {
  it('devuelve null/undefined sin explotar', () => {
    expect(withComputedTotals(null)).toBe(null);
    expect(withComputedTotals(undefined)).toBe(undefined);
  });

  it('sin nada saldado, calcula los 3 montos en vivo', () => {
    const p = withComputedTotals({
      payment_type: 'fixed', payment_amount: 500, client_amount: 800,
      upwork_status: 'No', editor_paid: 'unpaid', client_paid: 'pendiente',
    });
    expect(p.computed_editor_total).toBe(500);
    expect(p.computed_client_gross).toBe(800);
    expect(p.computed_client_net).toBe(800);
  });

  it('con el editor ya pagado, usa el monto congelado aunque la tarifa en vivo haya cambiado', () => {
    const p = withComputedTotals({
      payment_type: 'fixed', payment_amount: 999, editor_paid: 'paid', editor_paid_amount: 500,
      client_amount: 0, upwork_status: 'No', client_paid: 'pendiente',
    });
    expect(p.computed_editor_total).toBe(500);
  });

  it('con el cliente ya cobrado, usa los montos bruto/neto congelados', () => {
    const p = withComputedTotals({
      payment_type: 'fixed', payment_amount: 0, client_amount: 999,
      client_paid: 'cobrado', client_paid_amount_gross: 800, client_paid_amount_net: 680,
      upwork_status: 'No', editor_paid: 'unpaid',
    });
    expect(p.computed_client_gross).toBe(800);
    expect(p.computed_client_net).toBe(680);
  });

  it('marca editor_is_owner por email del editor asignado, no por rol', () => {
    const owner = withComputedTotals({ _editor_email: OWNER_EMAIL, payment_type: 'fixed', payment_amount: 0, client_amount: 0, upwork_status: 'No', editor_paid: 'unpaid', client_paid: 'pendiente' });
    const other = withComputedTotals({ _editor_email: 'otro-admin@agencyos.com', payment_type: 'fixed', payment_amount: 0, client_amount: 0, upwork_status: 'No', editor_paid: 'unpaid', client_paid: 'pendiente' });
    expect(owner.editor_is_owner).toBe(true);
    expect(other.editor_is_owner).toBe(false);
  });

  it('borra el email temporal de la respuesta — el cliente nunca lo ve', () => {
    const p = withComputedTotals({ _editor_email: OWNER_EMAIL, payment_type: 'fixed', payment_amount: 0, client_amount: 0, upwork_status: 'No', editor_paid: 'unpaid', client_paid: 'pendiente' });
    expect(p._editor_email).toBeUndefined();
  });
});
