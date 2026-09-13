import type { MetadataRoute } from "next";

// Makes wacrm installable ("Add to Home Screen" / "Install app") on
// phones — opens full-screen from a home-screen icon instead of a
// bookmarked browser tab, without needing a native app or app-store
// listing. Purely cosmetic/ergonomic: it's still the same web app,
// same login, same data — just fewer taps to get back into it, and
// no visible browser chrome once launched.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "wacrm",
    short_name: "wacrm",
    description: "Self-hostable CRM template for WhatsApp.",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      {
        src: "/pwa-icon-192",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/pwa-icon-512",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
