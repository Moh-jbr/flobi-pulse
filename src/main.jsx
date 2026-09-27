import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import { connect } from './lib/store.js';

connect(async () => {
  if (window.pulse) return window.pulse;
  const { createBrowserBridge } = await import('./lib/browser-bridge.js');
  return createBrowserBridge();
});

createRoot(document.getElementById('root')).render(<App />);
