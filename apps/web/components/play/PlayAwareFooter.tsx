"use client";

import { usePathname } from "next/navigation";
import { Footer } from "../ui/Footer.tsx";

/** The site footer everywhere except the /play screens, where the sheet owns the bottom of the screen. */
export function PlayAwareFooter() {
  const pathname = usePathname();
  if (pathname === "/play" || pathname.startsWith("/play/")) return null;
  return <Footer />;
}
