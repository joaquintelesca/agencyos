import { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

const API_BASE = import.meta.env.VITE_API_URL || '';
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user && token && !socket) {
      const s = io(SOCKET_URL, { extraHeaders: { 'ngrok-skip-browser-warning': 'true' }, auth: { token } });
      s.emit('user:online', user.id);
      s.on('users:online', setOnlineUsers);
      s.on('connect_error', (err) => {
        if (err.message === 'No token' || err.message === 'Token inválido') {
          logout();
        }
      });
      setSocket(s);
    }
    if (!user && socket) {
      socket.disconnect();
      setSocket(null);
    }
  }, [user, token, socket]);

  // El evento 'storage' solo dispara en OTRAS pestañas, nunca en la que hizo el cambio — justo
  // lo que hace falta para propagar un logout (o un cambio de cuenta) entre pestañas abiertas.
  // Antes cada pestaña vivía con su propio estado en memoria hasta que un fetch le fallara solo.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== 'token' && e.key !== 'user') return;
      const newToken = localStorage.getItem('token');
      const newUser = localStorage.getItem('user');
      if (!newToken || !newUser) {
        setToken(null); setUser(null);
      } else {
        setToken(newToken);
        setUser(JSON.parse(newUser));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = async (email, password) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    return data;
  };

  const updateUser = (updates) => {
    setUser(prev => {
      const next = { ...prev, ...updates };
      localStorage.setItem('user', JSON.stringify(next));
      return next;
    });
  };

  const logout = () => {
    setToken(null); setUser(null);
    localStorage.removeItem('token'); localStorage.removeItem('user');
    if (socket) { socket.disconnect(); setSocket(null); }
  };

  const api = async (path, options = {}) => {
    const currentToken = token || localStorage.getItem('token');
    const fetchOptions = {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        'Authorization': `Bearer ${currentToken}`,
        'ngrok-skip-browser-warning': 'true',
        ...options.headers
      },
      body: options.body instanceof FormData ? options.body : (options.body ? JSON.stringify(options.body) : undefined)
    };
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, fetchOptions);
    } catch {
      // Fallo de red transitorio (WiFi cortado un instante, DNS momentáneo) — un solo
      // reintento rápido resuelve la mayoría de los casos sin que el usuario tenga que
      // notar nada ni volver a hacer clic.
      await new Promise(r => setTimeout(r, 800));
      try {
        res = await fetch(`${API_BASE}${path}`, fetchOptions);
      } catch {
        throw new Error('Sin conexión. Revisá tu internet e intentá de nuevo.');
      }
    }

    // Token vencido/inválido: antes cada pantalla mostraba un alert distinto ("jwt expired", etc.)
    // y el usuario se quedaba en una app rota sin entender por qué. Ahora se cierra sesión al toque
    // y PrivateRoute manda a /login solo (ver App.jsx).
    if (res.status === 401) {
      logout();
      throw new Error('Tu sesión expiró. Volvé a iniciar sesión.');
    }

    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = {};
      }
    } else {
      const text = await res.text().catch(() => '');
      if (!res.ok) { const err = new Error(text || `Error HTTP ${res.status}`); err.status = res.status; throw err; }
      return text;
    }

    if (!res.ok) { const err = new Error(data?.error || data?.message || `Error ${res.status}`); err.status = res.status; throw err; }
    return data;
  };

  // /uploads ahora requiere autenticación; <video>/<img>/<audio src> no pueden mandar el header
  // Authorization, así que el token viaja como query param en estas URLs.
  const mediaUrl = (path) => {
    if (!path) return path;
    const currentToken = token || localStorage.getItem('token');
    return `${path}${path.includes('?') ? '&' : '?'}token=${currentToken}`;
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, api, socket, onlineUsers, updateUser, mediaUrl }}>
      {children}
    </AuthContext.Provider>
  );
}
