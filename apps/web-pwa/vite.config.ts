import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA, type ManifestOptions } from "vite-plugin-pwa";

export const META_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const HTTP_CSP = `${META_CSP}; frame-ancestors 'none'`;

export const SECURITY_HEADERS = {
  "Content-Security-Policy": HTTP_CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export function resolvePwaBuildId(value: string | undefined): string {
  const buildId = value ?? "local";

  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(buildId) ||
    /(?:secret|token|password|private|credential)/iu.test(buildId)
  ) {
    throw new Error(
      "PWA_BUILD_ID must be a non-secret identifier of 1-64 ASCII letters, digits, dots, underscores, or hyphens.",
    );
  }

  return buildId;
}

export const PWA_BUILD_ID = resolvePwaBuildId(process.env.PWA_BUILD_ID);

export const PWA_MANIFEST = {
  id: "/",
  name: "Наш бюджет",
  short_name: "Наш бюджет",
  description: "План, факт и контроль семейных лимитов — даже без интернета.",
  lang: "ru",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#100904",
  theme_color: "#100904",
  categories: ["finance", "productivity"],
  icons: [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
} satisfies Partial<ManifestOptions>;

function buildMetadataPlugin(): Plugin {
  return {
    name: "family-budget-build-metadata",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify({ buildId: PWA_BUILD_ID })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    buildMetadataPlugin(),
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      manifest: PWA_MANIFEST,
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["**/icon-192.png", "**/icon-512.png"],
        additionalManifestEntries: [
          {
            url: "build-meta.json",
            revision: PWA_BUILD_ID,
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    sourcemap: false,
  },
  server: {
    port: 4173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: SECURITY_HEADERS,
  },
});
