import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initApi } from '@/api';
import { App } from '@/App';
import '@/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');

void initApi().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
