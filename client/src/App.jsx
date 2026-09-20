import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UndoProvider } from './context/UndoContext';
import { AlertProvider } from './context/AlertContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CalendarPage from './pages/Calendar';
import Project from './pages/Project';
import Payments from './pages/Payments';
import VideosDashboard from './pages/VideosDashboard';
import Team from './pages/Team';
import Chat from './pages/Chat';
import Notifications from './pages/Notifications';
import Earnings from './pages/Earnings';
import ClientDashboard from './pages/ClientDashboard';
import PublicReview from './pages/PublicReview';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';

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
    <ErrorBoundary>
      <AuthProvider>
        <AlertProvider>
          <UndoProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<Login />} />
                {/* Pública a propósito, fuera de PrivateRoute — el cliente que abre esto no
                    tiene cuenta ni la va a crear. */}
                <Route path="/review/:token" element={<PublicReview />} />
                <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                  <Route index element={<Dashboard />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="project/:id" element={<Project />} />
                  <Route path="client/:id" element={<ClientDashboard />} />
                  <Route path="team" element={<Team />} />
                  <Route path="chat" element={<Chat />} />
                  <Route path="notifications" element={<Notifications />} />
                  <Route path="earnings" element={<Earnings />} />
                  <Route path="payments" element={<AdminRoute><Payments /></AdminRoute>} />
                  <Route path="videos" element={<AdminRoute><VideosDashboard /></AdminRoute>} />
                </Route>
              </Routes>
            </BrowserRouter>
          </UndoProvider>
        </AlertProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
