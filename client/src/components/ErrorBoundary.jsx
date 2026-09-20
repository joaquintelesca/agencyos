import { Component } from 'react';

// Sin esto, cualquier error de render desmonta el árbol entero y deja una pantalla en blanco en
// medio del trabajo, sin pista de qué pasó. Tiene que ser una clase: React no expone
// componentDidCatch a los componentes de función.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Error de render:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: 24, background: 'var(--bg)' }}>
        <div className="card" style={{ maxWidth: 440, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-lg)', fontWeight: 800, marginBottom: 8 }}>Algo se rompió en esta pantalla</h1>
          <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text2)', lineHeight: 'var(--lh-normal)', marginBottom: 18 }}>
            El error quedó registrado en la consola del navegador. Tus datos no se perdieron: recargá para volver.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Recargar</button>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text3)', marginTop: 16, fontFamily: 'monospace', wordBreak: 'break-word' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
        </div>
      </div>
    );
  }
}
