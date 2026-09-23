import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UndoProvider } from './context/UndoContext';
import { AlertProvider } from './context/AlertContext';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';

// Cada página es su propio chunk, bajado recién cuando se navega a esa ruta — antes todo el
// bundle (>500kB, ya superaba el umbral de warning de Vite) se descargaba entero antes de poder
// ver ni el login. Layout/contexts se quedan eager: hacen falta para el shell de cualquier ruta
// privada, dividirlos no ahorraría nada y solo agregaría una espera extra en cada navegación.
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const Project = lazy(() => import('./pages/Project'));
const Payments = lazy(() => import('./pages/Payments'));
const VideosDashboard = lazy(() => import('./pages/VideosDashboard'));
const Storage = lazy(() => import('./pages/Storage'));
const Settings = lazy(() => import('./pages/Settings'));
const Team = lazy(() => import('./pages/Team'));
const Chat = lazy(() => import('./pages/Chat'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Earnings = lazy(() => import('./pages/Earnings'));
const ClientDashboard = lazy(() => import('./pages/ClientDashboard'));
const PublicReview = lazy(() => import('./pages/PublicReview'));
const ClientReview = lazy(() => import('./pages/ClientReview'));

const PageLoader = () => <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}><div className="spinner" style={{width:32,height:32}}/></div>;

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
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
              <Suspense fallback={<PageLoader />}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  {/* Pública a propósito, fuera de PrivateRoute — el cliente que abre esto no
                      tiene cuenta ni la va a crear. */}
                  <Route path="/review/:token" element={<PublicReview />} />
                  <Route path="/client-review/:token" element={<ClientReview />} />
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
                    <Route path="storage" element={<AdminRoute><Storage /></AdminRoute>} />
                    <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </UndoProvider>
        </AlertProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
