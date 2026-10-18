import type { Metadata } from "next";
import { Suspense } from "react";
import { ResultsView } from "../../components/results/ResultsView.tsx";
import { t } from "../../lib/copy.ts";

export const metadata: Metadata = { title: t("nav.results") };

// useSearchParams needs a Suspense boundary so the route can still be prerendered.
export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <ResultsView />
    </Suspense>
  );
}
