import { NavLink, Outlet } from 'react-router';

import { usingMocks } from '@/api';
import { useAuth } from '@/auth/AuthProvider';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/users', label: 'Users' },
  { to: '/scans', label: 'Scans' },
  { to: '/credits', label: 'Credits' },
  { to: '/revenue', label: 'Revenue' },
  { to: '/health', label: 'System health' },
];

export function Layout() {
  const { session, signOut } = useAuth();

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>
            ATS Scan AI <span className="brand-sub">Admin</span>
          </span>
        </div>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted small" title={session?.admin.email}>
            {session?.admin.email}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="content">
        {usingMocks && (
          <div className="mock-banner" role="note">
            Mock data. These numbers are generated locally and are not ATS Scan AI production data.
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {description && <p className="muted">{description}</p>}
    </header>
  );
}
