import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ width: '100%', maxWidth: '400px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: 40, height: 40, background: 'var(--accent)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>🎬</div>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>AgencyOS</span>
          </div>
          <p style={{ color: 'var(--text3)', marginTop: 8, fontSize: 14 }}>Tu agencia, todo en un lugar</p>
        </div>

        <div className="card" style={{ borderColor: 'var(--border2)' }}>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Email</label>
              <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@email.com" required />
            </div>
            <div className="form-group">
              <label>Contraseña</label>
              <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 16, background: 'rgba(240,92,92,0.08)', padding: '8px 12px', borderRadius: 8 }}>{error}</p>}
            <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center', height: 42 }} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Entrar'}
            </button>
          </form>
        </div>
        <p style={{ textAlign: 'center', color: 'var(--text3)', marginTop: 20, fontSize: 12 }}>
          Admin por defecto: admin@agencyos.com / admin123
        </p>
      </div>
    </div>
  );
}
