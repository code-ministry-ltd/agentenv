import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.querySelector('#root');
if (!(container instanceof HTMLElement)) {
  throw new Error('The agentenv UI root is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
