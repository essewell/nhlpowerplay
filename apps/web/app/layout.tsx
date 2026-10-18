import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Sans } from "next/font/google";
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

export const metadata: Metadata = {
  title: "PowerPlay",
  description: "Coach a real NHL power play.",
};

export const viewport: Viewport = {
  themeColor: "#0B1220", // = --color-bg in globals.css
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlowCondensed.variable} ${ibmPlexSans.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
