import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Sans } from "next/font/google";
import { PlayAwareFooter } from "../components/play/PlayAwareFooter.tsx";
import { rawCopy, t } from "../lib/copy.ts";
import { isProductionDeploy, THEME_COLOR } from "../lib/site.ts";
import "./globals.css";

// DESIGN.md: Barlow Condensed 600/700 for scoreboard numbers, headings, buttons.
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

// DESIGN.md: IBM Plex Sans 400/500/600 for body.
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
});

// COPY.md section 10. The page-title template is "{pageName} · PowerPlay" with {pageName} as Next's %s.
const indexable = isProductionDeploy();

export const metadata: Metadata = {
  title: { default: t("meta.title.home"), template: rawCopy("meta.title.page").replace("{pageName}", "%s") },
  description: t("meta.description"),
  applicationName: t("app.name"),
  // No og:image / twitter:image yet: docs/design/assets/brand/og-sample.png is a placeholder sample and
  // the per-result card is Step 5. Add one here when a real default image exists.
  openGraph: {
    type: "website",
    siteName: t("app.name"),
    title: t("og.title.default"),
    description: t("og.description.default"),
  },
  twitter: {
    card: "summary_large_image",
    title: t("og.title.default"),
    description: t("og.description.default"),
  },
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/brand/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  // Production only; previews and branch deploys also send X-Robots-Tag: noindex (next.config.ts).
  robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR, // = --color-bg in globals.css
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlowCondensed.variable} ${ibmPlexSans.variable}`}>
      <body className="flex min-h-dvh flex-col antialiased">
        <div className="flex flex-1 flex-col">{children}</div>
        <PlayAwareFooter />
      </body>
    </html>
  );
}
