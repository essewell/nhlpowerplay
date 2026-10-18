import type { Metadata } from "next";
import { PrivacyView } from "../../components/ui/pages/LegalViews.tsx";
import { t } from "../../lib/copy.ts";

export const metadata: Metadata = { title: t("privacy.title") };

export default function PrivacyPage() {
  return <PrivacyView />;
}
