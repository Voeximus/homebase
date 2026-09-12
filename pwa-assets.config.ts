import {
  defineConfig,
  minimal2023Preset,
} from "@vite-pwa/assets-generator/config";

// The default minimal-2023 preset pads icons onto a WHITE background — which
// shows as white edges around a dark app. Override the maskable + apple icons
// to sit full-bleed on the app's graphite canvas so they fill the icon space
// like any native app, on any phone.
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    transparent: {
      sizes: [64, 192, 512, 1024],
      favicons: [[48, "favicon.ico"]],
    },
    maskable: {
      sizes: [512, 1024],
      padding: 0,
      resizeOptions: { background: "#0a0d12" },
    },
    apple: {
      sizes: [180],
      padding: 0,
      resizeOptions: { background: "#0a0d12" },
    },
  },
  images: ["public/favicon.svg"],
});
