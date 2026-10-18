import type { MetadataRoute } from "next";
import { t } from "../lib/copy.ts";
import { THEME_COLOR } from "../lib/site.ts";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: t("app.manifest.name"),
    short_name: t("app.manifest.short_name"),
    description: t("app.manifest.description"),
    start_url: "/",
    display: "standalone",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: "/brand/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
