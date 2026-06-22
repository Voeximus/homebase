import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app under /homebase/ in production; dev/preview
  // stays at the root so the local server and tooling work normally.
  base: mode === 'production' ? '/homebase/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' (not autoUpdate): a new deploy surfaces an in-app "Update
      // available" button instead of silently swapping the SW (which left the
      // running page stale until you closed + reopened). injectRegister:false so
      // the useRegisterSW() hook is the single registrar and its onNeedRefresh
      // callback fires reliably.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Homebase',
        short_name: 'Homebase',
        description: "Gino & Xinyan's money + health, calibrated in one place.",
        theme_color: '#0a0d12',
        background_color: '#0a0d12',
        display: 'standalone',
        orientation: 'portrait',
        categories: ['finance', 'health', 'lifestyle'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-1024x1024.png', sizes: '1024x1024', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'maskable-icon-1024x1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell so it opens instantly; Supabase API/realtime
        // calls are cross-origin and always hit the network (fresh data).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Pull our Web Push handlers (push / notificationclick) into the generated
        // service worker so notifications work in the installed PWA.
        importScripts: ['push-sw.js'],
      },
    }),
  ],
}))
