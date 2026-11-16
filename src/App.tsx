import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import Layout from './components/Layout';

// Route-level code splitting: each page (and its heavy deps like recharts) loads on demand
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Namespaces = lazy(() => import('./pages/Namespaces'));
const Pods = lazy(() => import('./pages/Pods'));
const Deployments = lazy(() => import('./pages/Deployments'));
const Nodes = lazy(() => import('./pages/Nodes'));
const Logs = lazy(() => import('./pages/Logs'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Incidents = lazy(() => import('./pages/Incidents'));

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/namespaces" element={<Namespaces />} />
              <Route path="/pods" element={<Pods />} />
              <Route path="/deployments" element={<Deployments />} />
              <Route path="/nodes" element={<Nodes />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/incidents" element={<Incidents />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
