import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="panel">
      <h1>Page not found</h1>
      <p className="muted">
        <Link to="/">Back to the overview</Link>
      </p>
    </div>
  );
}
