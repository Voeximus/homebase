import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, getTheme, watchSystemTheme } from './lib/theme'

// The inline script in index.html already stamped the attribute so nothing
// flashes. This re-runs it to set <meta name="theme-color"> from the computed
// ground, and then follows the phone for as long as the page is open: on
// "Automatic", a sunset switch has to land on a page that is already rendered.
applyTheme(getTheme())
watchSystemTheme(() => applyTheme('system'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
