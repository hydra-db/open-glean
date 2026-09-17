"use client";
import React from "react";

// Original brand logos for connector providers from dashboard-2.0.
export const LOGO_IMG_BASE = "/static/images/logos/connectors";

export const PROVIDER_LOGO_ALIASES: Record<string, string> = {
  google: "gmail",
  googlemail: "gmail",
  microsoft: "ms_graph",
  outlook: "ms_graph",
  zoho_crm: "zoho",
  workday_raas: "workday",
};

// Connectors whose logos are SVG files in the public dir.
const LOGO_FILES: Record<string, string> = {
  slack: "slack.svg",
  gmail: "gmail.svg",
  github: "github.svg",
  notion: "notion.svg",
  linear: "linear.svg",
  mixpanel: "mixpanel.svg",
  jira: "jira.svg",
  gitlab: "gitlab.svg",
  salesforce: "salesforce.svg",
  zendesk: "zendesk.svg",
  confluence: "confluence.svg",
  trello: "trello.svg",
  hubspot: "hubspot.svg",
  asana: "asana.svg",
  monday: "monday.svg",
  wrike: "wrike.svg",
  sentry: "sentry.svg",
  pagerduty: "pagerduty.svg",
  datadog: "datadog.svg",
  intercom: "intercom.svg",
  amplitude: "amplitude.svg",
  googleanalytics: "googleanalytics.svg",
  gong: "gong.svg",
  affinity: "affinity.svg",
  gorgias: "gorgias.svg",
  helpscout: "helpscout.svg",
  stripe: "stripe.svg",
  quickbooks: "quickbooks.svg",
  xero: "xero.svg",
  okta: "okta.svg",
  bamboohr: "bamboohr.svg",
  greenhouse: "greenhouse.svg",
  coda: "coda.svg",
  smartsheet: "smartsheet.svg",
  zoho: "zoho.svg",
  airtable: "airtable.svg",
  freshdesk: "freshdesk.svg",
  granola: "granola.svg",
  fireflies: "fireflies.svg",
  loom: "loom.svg",
  google_search_console: "google_search_console.svg",
  posthog: "posthog.svg",
  google_calendar: "google_calendar.svg",
  contentful: "contentful.svg",
  zoom: "zoom.svg",
  figma: "figma.svg",
  bookstack: "bookstack.svg",
  surveymonkey: "surveymonkey.svg",
  typeform: "typeform.svg",
  googleads: "googleads.svg",
  mailchimp: "mailchimp.svg",
  google_sheets: "google_sheets.svg",
  clickup: "clickup.svg",
  shortcut: "shortcut.svg",
  calendly: "calendly.svg",
  box: "box.svg",
  dropbox: "dropbox.svg",
  google_drive: "google_drive.svg",
  nextcloud: "nextcloud.svg",
  uservoice: "uservoice.svg",
  tableau: "tableau.svg",
  twilio: "twilio.svg",
  dynamics: "dynamics.svg",
  linkedin_ads: "linkedin_ads.svg",
  marketo: "marketo.svg",
  ms_graph: "ms_graph.svg",
  segment: "segment.svg",
  ringcentral: "ringcentral.svg",
  sendgrid: "sendgrid.svg",
  workday: "workday.svg",
  workday_raas: "workday.svg",
  servicenow: "servicenow.svg",
  launchdarkly: "launchdarkly.svg",
  chargebee: "chargebee.svg",
  outreach: "outreach.svg",
  netsuite: "netsuite.svg",
  zoho_crm: "zoho.svg",
  bigquery: "bigquery.svg",
  twitter: "twitter.svg",
  attio: "attio.svg",
  supabase: "supabase.svg",
  sharepoint: "sharepoint.svg",
  discord: "discord.svg",
  klaviyo: "klaviyo.svg",
  pardot: "pardot.svg",
  lever: "lever.svg",
  avoma: "avoma.jpeg",
  pipedrive: "pipedrive.jpeg",
  recurly: "recurly.jpeg",
};

export function providerLogoImgSrc(provider?: string | null): string | null {
  if (!provider) return null;
  const key = provider.trim().toLowerCase();
  if (!key) return null;
  const id = PROVIDER_LOGO_ALIASES[key] ?? key.replace(/-/g, "_");
  const file = LOGO_FILES[id];
  return file ? `${LOGO_IMG_BASE}/${file}` : null;
}

type LogoProps = { size?: number; className?: string };

const LOGOS: Record<string, (p: Required<Pick<LogoProps, "size">>) => React.ReactNode> = {
  slack: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 122.8 122.8" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  ),
  gmail: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 52 40" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M3.6 40h7.3V22.4L0 14.2v22.2C0 38.4 1.6 40 3.6 40z" fill="#4285F4" />
      <path d="M41.1 40h7.3c2 0 3.6-1.6 3.6-3.6V14.2L41.1 22.4" fill="#34A853" />
      <path d="M41.1 3.6v18.8L52 14.2V5.5c0-5.1-5.8-7.9-9.8-4.9" fill="#FBBC04" />
      <path d="M10.9 22.4V3.6L26 14.9 41.1 3.6v18.8L26 33.6" fill="#EA4335" />
      <path d="M0 5.5v8.7l10.9 8.2V3.6L9.3.7C5.3-2.3 0 .6 0 5.5" fill="#C5221F" />
    </svg>
  ),
  github: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z"
        fill="currentColor"
      />
    </svg>
  ),
  notion: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
        fill="currentColor"
      />
    </svg>
  ),
  mixpanel: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="#7856FF"
        d="M6.967 9.996h3.053c-.763-.477-1.048-1.145-1.431-2.384L7.443 3.366C6.919 1.458 6.49.551 4.39.551H.004v1.145h.621c1.286 0 1.431.477 1.814 1.908L3.44 7.326c.524 1.814 1.337 2.67 3.53 2.67zm7.06 0h3.053c2.194 0 2.956-.86 3.484-2.67l1.001-3.722c.382-1.431.57-1.908 1.814-1.908H24V.551h-4.34c-2.146 0-2.576.86-3.053 2.815l-1.145 4.246c-.384 1.286-.673 1.907-1.435 2.384m-4.007 4.008h4.007V9.996H10.02zM0 23.449h4.39c2.1 0 2.529-.907 3.053-2.815l1.146-4.246c.383-1.239.668-1.907 1.431-2.384H6.967c-2.194 0-3.007.86-3.531 2.67l-1.001 3.722c-.383 1.431-.524 1.907-1.814 1.907H0zm19.65 0h4.343v-1.146h-.622c-1.239 0-1.431-.476-1.814-1.907l-1.001-3.722c-.524-1.814-1.286-2.67-3.483-2.67h-3.046c.762.477 1.041 1.098 1.424 2.384l1.145 4.246c.477 1.955.907 2.815 3.054 2.815"
      />
    </svg>
  ),
};

/**
 * Fallback for a connector with no bundled logo. A rounded tile with the app's
 * first letter and a colour derived from its name, so it reads as a designed
 * placeholder rather than a broken image or a plain grey box. The colour is
 * deterministic, so the same app always gets the same tile.
 */
function MonogramLogo({ id, size }: { id: string; size: number }) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.5),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size * 0.28,
        background: `linear-gradient(135deg, hsl(${hue} 42% 32%), hsl(${(hue + 24) % 360} 42% 22%))`,
        color: "#fff",
        fontWeight: 600,
        textTransform: "uppercase",
        lineHeight: 1,
      }}
    >
      {id.charAt(0)}
    </span>
  );
}

export function ProviderLogo({
  id,
  size = 20,
  className,
  fallback,
}: {
  id?: string;
  size?: number;
  className?: string;
  fallback?: React.ReactNode;
}) {
  if (!id) return fallback ?? null;
  const key = id.trim().toLowerCase();
  const canonical = PROVIDER_LOGO_ALIASES[key] ?? key.replace(/-/g, "_");
  const render = LOGOS[canonical];
  const imgFile = LOGO_FILES[canonical];
  // Human name for the accessible label, e.g. "ms_graph" -> "Ms Graph".
  const label = key
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <span
      className={className}
      role="img"
      aria-label={label}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 0, color: "inherit" }}
    >
      {render ? (
        render({ size })
      ) : imgFile ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${LOGO_IMG_BASE}/${imgFile}`}
          alt=""
          width={size}
          height={size}
          style={{ objectFit: "contain", width: size, height: size }}
        />
      ) : (
        fallback ?? <MonogramLogo id={key} size={size} />
      )}
    </span>
  );
}
