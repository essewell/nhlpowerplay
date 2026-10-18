import { HomeView } from "../components/home/HomeView.tsx";
import { getSeasonRange } from "../lib/site.ts";

// The root layout sets the default title (COPY.md meta.title.home).
export default function Home() {
  return <HomeView seasonRange={getSeasonRange()} />;
}
