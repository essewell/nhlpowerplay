import type { Metadata } from "next";
import { PlayScreen } from "../../../components/play/PlayScreen.tsx";
import { t } from "../../../lib/copy.ts";

export const metadata: Metadata = { title: t("nav.daily") };

export default function PlayDailyPage() {
  return <PlayScreen mode="daily" />;
}
