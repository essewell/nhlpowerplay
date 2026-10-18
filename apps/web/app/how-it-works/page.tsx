import type { Metadata } from "next";
import { HowItWorksView } from "../../components/ui/pages/HowItWorksView.tsx";
import { t } from "../../lib/copy.ts";
import { getSeasonRange } from "../../lib/site.ts";

export const metadata: Metadata = { title: t("how.title") };

export default function HowItWorksPage() {
  return <HowItWorksView seasonRange={getSeasonRange()} />;
}
