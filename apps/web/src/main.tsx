import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { createOidcAuthClient } from './auth/oidc-client.js'
import { readWebAppConfig } from './config.js'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Root element is missing')
}

try {
  const config = readWebAppConfig(import.meta.env, window.location.origin)
  const authClient = createOidcAuthClient(config)
  createRoot(root).render(
    <StrictMode>
      <App authClient={authClient} config={config} />
    </StrictMode>,
  )
} catch (error) {
  const detail = error instanceof Error ? error.message : 'The web application is misconfigured'
  createRoot(root).render(
    <main className="centered-message">
      <div role="alert">
        <p className="eyebrow">Configuration</p>
        <h1>Cannot start the upload workspace</h1>
        <p>{detail}</p>
      </div>
    </main>,
  )
}
