import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { LanguageProvider } from './LanguageProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside the error boundary, so its message is in the reader's language too. */}
    <LanguageProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </LanguageProvider>
  </StrictMode>,
)
