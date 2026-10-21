import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (process.env.SKIP_AUTH === "true") {
    return { apiKey: "mock-api-key", isOffline: true };
  }
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "", isOffline: false };
};

const navigationItems = [
  { label: "Dashboard", href: "/app" },
  { label: "Returns", href: "/app/returns" },
  { label: "Exchanges", href: "/app/exchanges" },
  { label: "Customers", href: "/app/customers" },
  { label: "Shipments", href: "/app/shipments" },
  { label: "Analytics", href: "/app/analytics" },
  { label: "Settings", href: "/app/settings" },
  { label: "Warehouse", href: "/app/warehouse" },
  { label: "Couriers", href: "/app/couriers" },
  { label: "Notifications", href: "/app/notifications" },
  { label: "Refunds", href: "/app/refunds" },
  { label: "COD", href: "/app/reconciliation" },
  { label: "Billing", href: "/app/billing" },
] as const;

function AppNavigation() {
  const { pathname } = useLocation();

  return (
    <s-app-nav aria-label="Primary navigation">
      {navigationItems.map((item) => {
        const isActive = item.href === "/app"
          ? pathname === "/app" || pathname === "/app/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <s-link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </s-link>
        );
      })}
    </s-app-nav>
  );
}

const styles = (
  <style dangerouslySetInnerHTML={{ __html: `
    :root {
      color-scheme: light;
      --bc-shell-bg: #f6f7f8;
      --bc-shell-surface: #ffffff;
      --bc-shell-ink: #202223;
      --bc-shell-muted: #616a70;
      --bc-shell-line: #e1e3e5;
      --bc-shell-brand: #263f8c;
      --bc-shell-brand-soft: #eef2ff;
    }

    html,
    body {
      max-width: 100%;
    }

    body {
      background: var(--bc-shell-bg);
      color: var(--bc-shell-ink);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    s-page {
      display: block;
      width: 100%;
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px 24px;
      box-sizing: border-box;
      overflow-x: clip;
    }

    s-app-nav {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      gap: 3px;
      width: calc(100% - 48px);
      max-width: 1440px;
      margin: 16px auto 22px;
      padding: 7px;
      box-sizing: border-box;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      -webkit-overflow-scrolling: touch;
      border: 1px solid var(--bc-shell-line);
      border-radius: 14px;
      background: var(--bc-shell-surface);
      box-shadow: 0 2px 8px rgba(31, 33, 36, 0.035);
      --s-link-color-f4125: #202223;
      --s-link-color-hover-f4125: #202223;
      --s-link-color-active-f4125: #202223;
      --p-color-text-link-f4125: #202223;
      --p-color-text-link-hover-f4125: #202223;
      --p-color-text-link-active-f4125: #202223;
      scrollbar-width: thin;
      scrollbar-color: #c9cccf transparent;
    }

    s-app-nav::-webkit-scrollbar {
      height: 4px;
    }

    s-app-nav::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: #c9cccf;
    }

    s-link {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      min-height: 39px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 9px;
      color: #202223 !important;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.2;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    }

    s-link:hover,
    s-link:focus-visible {
      background: #f6f7f8;
      color: #202223 !important;
    }

    s-link[aria-current="page"] {
      border-color: #d5d8dc;
      background: #f4f5f6;
      color: #202223 !important;
      font-weight: 700;
    }

    s-link::part(link) {
      color: #202223 !important;
      text-decoration: none;
    }

    s-heading,
    h1,
    h2,
    h3,
    h4,
    strong {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    s-box {
      display: block;
      box-sizing: border-box;
      border: 1px solid var(--bc-shell-line);
      border-radius: 14px;
      background: var(--bc-shell-surface);
      box-shadow: 0 1px 3px rgba(31, 33, 36, 0.035);
    }

    s-heading {
      color: var(--bc-shell-ink);
      font-weight: 700;
    }

    s-text[tone="success"] {
      color: #087f5b;
      font-weight: 600;
    }

    s-text[tone="critical"] {
      color: #b42318;
      font-weight: 600;
    }

    s-text[tone="warning"] {
      color: #916a00;
      font-weight: 600;
    }

    @media (max-width: 760px) {
      s-app-nav {
        width: calc(100% - 20px);
        margin: 10px auto 16px;
        padding: 6px;
        border-radius: 11px;
      }

      s-link {
        min-height: 38px;
        padding: 0 11px;
        font-size: 12.5px;
      }

      s-page {
        padding: 12px 10px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      s-link {
        transition: none;
      }
    }
  `}} />
);

export default function App() {
  const { apiKey, isOffline } = useLoaderData<typeof loader>();

  return (
    <>
      {styles}
      {isOffline ? (
        <>
          <AppNavigation />
          <Outlet />
        </>
      ) : (
        <AppProvider embedded={true} apiKey={apiKey}>
          <AppNavigation />
          <Outlet />
        </AppProvider>
      )}
    </>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
