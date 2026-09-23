import { createContext, useContext, useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

const API_BASE = import.meta.env.VITE_API_URL || '';
const SOCKET_URL = import.meta.env.VITE_API_URL || window.location.origin;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [mediaToken, setMediaToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [socket, setSocket] = useState(null);

  // Token corto y de un solo propósito para /uploads (ver server/index.js `authMedia`) — separado
  // del token de sesión de 7 días para que mediaUrl() ya no tenga que poner ESE en la URL de cada
  // <img>/<video>/<audio>. Se pide una vez al restaurar sesión/loguearse (esperado por `loading`,
  // así que mediaUrl() ya lo tiene disponible para el primer render de contenido autenticado) y se
  // renueva antes de vencer mientras la sesión siga abierta.
  const fetchMediaToken = async (currentToken) => {
    try {
      const res = await fetch(`${API_BASE}/api/media-token`, {
        headers: { 'Authorization': `Bearer ${currentToken}`, 'ngrok-skip-browser-warning': 'true' }
      });
      if (!res.ok) return;
      const data = await res.json();
      setMediaToken(data.token);
    } catch {
      // Sin red o el server caído un instante: mediaUrl() sigue funcionando con el token viejo
      // hasta el próximo intento (el intervalo de abajo reintenta solo, no hace falta reintento acá).
    }
  };

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    (async () => {
      if (savedToken && savedUser) await fetchMediaToken(savedToken);
      setLoading(false);
    })();
  }, []);

  // Token de media emitido por 30 minutos — se renueva cada 20 para no dejar una ventana donde
  // ya venció pero todavía no se pidió uno nuevo (que rompería imágenes/video a mitad de sesión).
  useEffect(() => {
    if (!user || !token) return;
    const interval = setInterval(() => fetchMediaToken(token), 20 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, token]);

  useEffect(() => {
    if (user && token && !socket) {
      const s = io(SOCKET_URL, { extraHeaders: { 'ngrok-skip-browser-warning': 'true' }, auth: { token } });
      // Las rooms del servidor (admins, user:<id>) no sobreviven a una reconexión — hay que
      // volver a unirse cada vez que el socket conecta, no solo la primera vez, o el cliente
      // deja de recibir eventos en vivo después de cualquier corte de red.
      s.on('connect', () => s.emit('user:online', user.id));
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
    await fetchMediaToken(data.token);
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
    setToken(null); setUser(null); setMediaToken(null);
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
    const method = (options.method || 'GET').toUpperCase();
    const isIdempotent = method === 'GET' || method === 'HEAD';
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, fetchOptions);
    } catch {
      if (!isIdempotent) throw new Error('Sin conexión. Revisá tu internet e intentá de nuevo.');
      // Fallo de red transitorio (WiFi cortado un instante, DNS momentáneo) — un solo
      // reintento rápido resuelve la mayoría de los casos sin que el usuario tenga que
      // notar nada ni volver a hacer clic. Solo para GET/HEAD: reintentar un POST/PUT/DELETE
      // podría repetir una acción que en realidad ya se aplicó del lado del servidor.
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
  // Authorization, así que el token viaja como query param en estas URLs — pero el de media
  // (corto, de un solo propósito), no el de sesión completa. Ver fetchMediaToken arriba.
  const mediaUrl = (path) => {
    if (!path) return path;
    // El token solo puede viajar a nuestro propio /uploads. Sin este chequeo, cualquier campo
    // que termine acá con una URL externa (p. ej. un file_url manipulado en un mensaje de chat)
    // se lleva la sesión de quien lo abra a ese host.
    if (typeof path !== 'string' || !path.startsWith('/uploads/')) return path;
    if (!mediaToken) return path;
    return `${path}${path.includes('?') ? '&' : '?'}token=${mediaToken}`;
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, api, socket, onlineUsers, updateUser, mediaUrl }}>
      {children}
    </AuthContext.Provider>
  );
}
