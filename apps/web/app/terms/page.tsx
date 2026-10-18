import type { Metadata } from "next";
import { TermsView } from "../../components/ui/pages/LegalViews.tsx";
import { t } from "../../lib/copy.ts";

export const metadata: Metadata = { title: t("terms.title") };

export default function TermsPage() {
  return <TermsView />;
}
