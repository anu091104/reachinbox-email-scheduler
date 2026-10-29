import { Loader2 } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { EmailDetailPage } from './pages/EmailDetailPage';
import { LoginPage } from './pages/LoginPage';
import { MailboxPage } from './pages/MailboxPage';

// The rich-text editor is the heaviest dependency; load it only when composing.
const ComposePage = lazy(() => import('./pages/ComposePage').then((m) => ({ default: m.ComposePage })));

const Spinner = () => (
  <div className="flex h-full items-center justify-center text-muted">
    <Loader2 className="animate-spin" />
  </div>
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/scheduled" element={<MailboxPage key="scheduled" tab="scheduled" />} />
        <Route path="/sent" element={<MailboxPage key="sent" tab="sent" />} />
        <Route path="/emails/:id" element={<EmailDetailPage />} />
        <Route
          path="/compose"
          element={
            <Suspense fallback={<Spinner />}>
              <ComposePage />
            </Suspense>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/scheduled" replace />} />
    </Routes>
  );
}
