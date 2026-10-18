/**
 * Site-wide launch config. Single place for values that must be filled before launch
 * (docs/LAUNCH.md go/no-go: "Contact email set", legal pages "Last updated").
 *
 * Ownership: pure constants, no state. Never invent a value here: null means "not decided yet"
 * and the legal pages render a visible placeholder from lib/copy.ts.
 */

export interface SiteConfig {
  /** Contact address for Privacy and Terms ({contactEmail} in COPY.md). TODO(owner): set before launch. */
  readonly contactEmail: string | null;
  /** "Last updated" date for Privacy and Terms ({date} in COPY.md), as YYYY-MM-DD. TODO(owner): set at launch. */
  readonly legalUpdated: string | null;
  /** Public documentation link credited on About (COPY.md section 3). */
  readonly nhlApiDocsUrl: string;
}

export const SITE_CONFIG: SiteConfig = {
  contactEmail: null,
  legalUpdated: null,
  nhlApiDocsUrl: "https://github.com/Zmalski/NHL-API-Reference",
};

/**
 * Season range the data covers, supplied by the export (never typed). Strings so callers choose the
 * format: `firstSeason`/`lastSeason` like a season label, `firstYear`/`lastYear` like a plain year.
 */
export interface SeasonRange {
  readonly firstSeason: string;
  readonly lastSeason: string;
  readonly firstYear: string;
  readonly lastYear: string;
}

/**
 * Season range for static pages. Returns undefined until lib/daily (data agent) provides it;
 * pages then omit the year phrase (PENDING_COPY "...noRange" variants).
 */
export function getSeasonRange(): SeasonRange | undefined {
  return undefined;
}

/** Format a YYYY-MM-DD legal date for display; null/invalid -> null so the page shows the placeholder. O(1). */
export function formatLegalDate(iso: string | null): string | null {
  if (iso === null || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" }).format(d);
}

/** Where "Take the bench" on How it works goes. "/" until the play route is settled (app/play is another owner). */
export const HOW_CTA_HREF = "/";

/** = --color-bg in globals.css; used for the browser theme colour and the PWA manifest. */
export const THEME_COLOR = "#0B1220";

/**
 * Same rule as next.config.ts: Netlify sets CONTEXT ("production", "deploy-preview", ...).
 * Only production is indexable; previews and branch deploys are not.
 */
export function isProductionDeploy(env: Record<string, string | undefined> = process.env): boolean {
  return env.CONTEXT === undefined || env.CONTEXT === "production";
}
