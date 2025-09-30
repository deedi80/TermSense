import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// Ensure the root element exists
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}