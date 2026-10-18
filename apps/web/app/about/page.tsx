import type { Metadata } from "next";
import { AboutView } from "../../components/ui/pages/AboutView.tsx";
import { t } from "../../lib/copy.ts";

export const metadata: Metadata = { title: t("nav.about") };

export default function AboutPage() {
  return <AboutView />;
}
