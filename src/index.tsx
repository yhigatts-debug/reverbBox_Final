import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// index.htmlでreverb_combined.jsをロード済み
// WASMの準備完了を待ってからReactアプリをマウント
function waitForWasm(): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const M = (window as any).Module;
      if (typeof M !== 'undefined' && typeof M._prepare === 'function') {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
}

waitForWasm().then(() => {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Could not find root element');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
