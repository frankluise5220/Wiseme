import "./globals.css";
import Script from "next/script";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ModalDragController } from "@/components/ModalDragController";
import { PwaServiceWorkerRegistration } from "@/components/PwaServiceWorkerRegistration";
import { ClientLogCollector } from "@/components/ClientLogCollector";
import { I18nProvider } from "@/components/I18nProvider";
import { DISPLAY_LANGUAGE_COOKIE } from "@/lib/server/i18n";
import type { DisplayLanguage } from "@/lib/client/appPreferences";

export const metadata: Metadata = {
  applicationName: "MoneyMoneyHome",
  title: "MoneyMoneyHome",
  description: "Local-first family finance system",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/branding/mmh-logo-pwa-192.png", sizes: "192x192", type: "image/png" },
      { url: "/branding/mmh-logo-pwa-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "MoneyMoneyHome",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#f4f7fb",
  colorScheme: "light",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await cookies();
  const raw = store.get(DISPLAY_LANGUAGE_COOKIE)?.value;
  const displayLanguage: DisplayLanguage = raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";

  return (
    <html lang={displayLanguage} suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="antialiased h-screen overflow-x-hidden overflow-y-hidden"
      >
        <I18nProvider initialLanguage={displayLanguage}>{children}</I18nProvider>
        <ModalDragController />
        <PwaServiceWorkerRegistration />
        <ClientLogCollector />
        <Script
          id="performance-measure-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const persist = (key, value) => {
                    if (value === null || value === undefined) return;
                    document.cookie = key + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000; samesite=lax";
                  };
                  persist("sidebar_collapsed", localStorage.getItem("sidebar_collapsed"));
                  persist("sidebar_group_by", localStorage.getItem("sidebar_group_by"));
                  persist("sidebar_hide_zero", localStorage.getItem("sidebar_hide_zero"));
                  persist("sidebar_hide_initial_data", localStorage.getItem("sidebar_hide_initial_data"));
                  persist("sidebar_owner_filter", localStorage.getItem("sidebar_owner_filter"));
                  persist("mmh_ai_panel_collapsed", localStorage.getItem("mmh_ai_panel_collapsed"));
                } catch (error) {}
                const perf = window.performance;
                if (!perf || typeof perf.measure !== "function" || perf.__mmhMeasureGuard) return;
                const originalMeasure = perf.measure.bind(perf);
                Object.defineProperty(perf, "__mmhMeasureGuard", { value: true });
                perf.measure = function(name, startOrOptions, endMark) {
                  try {
                    return originalMeasure(name, startOrOptions, endMark);
                  } catch (error) {
                    const message = error && typeof error.message === "string" ? error.message : "";
                    if (message.includes("negative time stamp")) {
                      return { name, entryType: "measure", startTime: 0, duration: 0 };
                    }
                    throw error;
                  }
                };
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}
