import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "MoneyMoneyHome",
    short_name: "MMH",
    description: "Local-first family finance system",
    lang: "zh-CN",
    start_url: "/overview",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "fullscreen", "minimal-ui"],
    background_color: "#f4f7fb",
    theme_color: "#f4f7fb",
    orientation: "portrait",
    categories: ["finance", "productivity"],
    icons: [
      {
        src: "/branding/mmh-logo-pwa-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/branding/mmh-logo-pwa-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/branding/mmh-logo-pwa-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "概览",
        short_name: "概览",
        url: "/overview",
        icons: [
          {
            src: "/branding/mmh-logo-pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "记一笔",
        short_name: "记一笔",
        url: "/?quickEntry=1",
        icons: [
          {
            src: "/branding/mmh-logo-pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };
}
