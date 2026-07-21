import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Project from './pages/Project';
import Payments from './pages/Payments';
import Team from './pages/Team';
import Chat from './pages/Chat';
import Notifications from './pages/Notifications';
import ClientDashboard from './pages/ClientDashboard';
import Layout from './components/Layout';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}><div className="spinner" style={{width:32,height:32}}/></div>;
  return user ? children : <Navigate to="/login" />;
}

// Siempre anidado dentro de PrivateRoute (ver abajo), que ya espera a que loading resuelva
// y a que haya user antes de montar cualquier ruta hija — repetir esos chequeos acá sería código muerto.
function AdminRoute({ children }) {
  const { user } = useAuth();
  if (user.role !== 'admin') return <Navigate to="/" />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="project/:id" element={<Project />} />
            <Route path="client/:id" element={<ClientDashboard />} />
            <Route path="team" element={<Team />} />
            <Route path="chat" element={<Chat />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="payments" element={<AdminRoute><Payments /></AdminRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
