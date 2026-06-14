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

  const logout = () => {
    setToken(null); setUser(null);
    localStorage.removeItem('token'); localStorage.removeItem('user');
    if (socket) { socket.disconnect(); setSocket(null); }
  };

  const api = async (path, options = {}) => {
    const currentToken = token || localStorage.getItem('token');
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        'Authorization': `Bearer ${currentToken}`,
        'ngrok-skip-browser-warning': 'true',
        ...options.headers
      },
      body: options.body instanceof FormData ? options.body : (options.body ? JSON.stringify(options.body) : undefined)
    });

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
      if (!res.ok) throw new Error(text || `Error HTTP ${res.status}`);
      return text;
    }

    if (!res.ok) throw new Error(data?.error || data?.message || `Error ${res.status}`);
    return data;
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, api, socket, onlineUsers }}>
      {children}
    </AuthContext.Provider>
  );
}
