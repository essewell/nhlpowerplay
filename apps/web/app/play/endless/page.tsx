import type { Metadata } from "next";
import { PlayScreen } from "../../../components/play/PlayScreen.tsx";
import { t } from "../../../lib/copy.ts";

export const metadata: Metadata = { title: t("nav.endless") };

export default function PlayEndlessPage() {
  return <PlayScreen mode="endless" />;
}
