import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app under /homebase/ in production; dev/preview
  // stays at the root so the local server and tooling work normally.
  base: mode === 'production' ? '/homebase/' : '/',
  // The label reader's worker imports onnxruntime-web and lazy-loads parts of
  // itself; that needs ES-module worker output (the default 'iife' can't code-
  // split). Module workers run on iOS Safari 15+ and Chrome 80+.
  worker: { format: 'es' },
  // Pre-bundling onnxruntime-web in dev rewrites its import.meta.url-relative
  // asset lookups into .vite/deps, where the .wasm doesn't exist. We pass the
  // runtime's bytes in ourselves, but excluding it keeps dev identical to the
  // production build instead of working by accident.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
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
        //
        // The label reader's files are deliberately NOT in this list: the ONNX
        // models (6.2 MB) and onnxruntime's .wasm (14 MB) would make every app
        // install and every update download 20 MB for a feature most opens never
        // touch. They are cached the first time a scan actually needs them
        // (runtimeCaching below).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            // Cache-first: these files are immutable. Model URLs carry their
            // sha256 prefix in ?v=, and the .wasm name carries Vite's content
            // hash, so a changed file is a new URL rather than a stale hit —
            // and the loader re-checks every model's hash anyway. Once cached,
            // the second scan works with no network at all.
            urlPattern: ({ url }) =>
              url.pathname.includes('/models/pp-ocrv6-tiny/') || /\/assets\/ort-wasm[^/]*\.wasm$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'label-reader',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        // Pull our Web Push handlers (push / notificationclick) into the generated
        // service worker so notifications work in the installed PWA.
        importScripts: ['push-sw.js'],
      },
    }),
  ],
}))
