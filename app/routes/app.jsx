import {
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  if (process.env.SKIP_AUTH === "true") {
    return { apiKey: "mock-api-key", isOffline: true };
  }

  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "", isOffline: false };
};

const navigationItems = [
  { label: "Dashboard", href: "/app" },
  { label: "Bookings", href: "/app/bookings" },
  { label: "Shipments", href: "/app/shipments" },
  { label: "Returns", href: "/app/returns" },
  { label: "Exchanges", href: "/app/exchanges" },
  { label: "Analytics", href: "/app/analytics" },
  { label: "Settings", href: "/app/settings" },
  { label: "Warehouse", href: "/app/warehouse" },
  { label: "Couriers", href: "/app/couriers" },
  { label: "Notifications", href: "/app/notifications" },
  { label: "Refunds", href: "/app/refunds" },
  { label: "COD", href: "/app/reconciliation" },
  { label: "Billing", href: "/app/billing" },
];

function AppNavigation() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const isNavigating = navigation.state !== "idle";

  return (
    <>
      {isNavigating && (
        <div
          className="bc-navigation-progress"
          role="progressbar"
          aria-label="Loading panel"
        >
          <span />
        </div>
      )}
      <nav
        className="bc-app-nav"
        aria-label="Primary navigation"
        aria-busy={isNavigating}
      >
        {navigationItems.map((item) => {
          const isActive =
            item.href === "/app"
              ? pathname === "/app" || pathname === "/app/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.href}
              to={item.href}
              prefetch="intent"
              aria-current={isActive ? "page" : undefined}
              className="bc-app-nav-link"
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

const styles = (
  <style
    dangerouslySetInnerHTML={{
      __html: `
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

    .bc-app-nav {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      align-content: flex-start;
      flex-wrap: wrap;
      gap: 4px;
      width: calc(100% - 48px);
      max-width: 1500px;
      margin: 16px auto 22px;
      padding: 7px;
      box-sizing: border-box;
      overflow: visible;
      border: 1px solid var(--bc-shell-line);
      border-radius: 14px;
      background: var(--bc-shell-surface);
      box-shadow: 0 2px 8px rgba(31, 33, 36, 0.035);
    }

    .bc-app-nav-link {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      min-width: max-content;
      min-height: 39px;
      padding: 0 10px;
      box-sizing: border-box;
      border: 1px solid transparent;
      border-radius: 9px;
      color: #202223;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.2;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
    }

    .bc-app-nav-link:hover,
    .bc-app-nav-link:focus-visible {
      background: #f6f7f8;
      color: #202223;
    }

    .bc-app-nav-link[aria-current="page"] {
      border-color: #bfdbfe;
      background: #eff6ff;
      color: #2563eb;
      font-weight: 700;
      box-shadow: 0 1px 3px rgba(37, 99, 235, 0.12);
    }

    .bc-navigation-progress {
      position: fixed;
      inset: 0 auto auto 0;
      z-index: 10000;
      width: 100%;
      height: 3px;
      overflow: hidden;
      pointer-events: none;
      background: rgba(37, 99, 235, 0.12);
    }

    .bc-navigation-progress span {
      display: block;
      width: 34%;
      height: 100%;
      border-radius: 999px;
      background: #2563eb;
      animation: bc-navigation-progress 850ms ease-in-out infinite alternate;
      transform-origin: left center;
    }

    @keyframes bc-navigation-progress {
      from { transform: translateX(-10%) scaleX(0.7); }
      to { transform: translateX(210%) scaleX(1.1); }
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
      .bc-app-nav {
        width: calc(100% - 20px);
        margin: 10px auto 16px;
        padding: 6px;
        justify-content: flex-start;
        gap: 4px;
        border-radius: 11px;
      }

      .bc-app-nav-link {
        flex: 0 0 auto;
        min-width: max-content;
        min-height: 38px;
        padding: 0 9px;
        font-size: 12px;
      }

      s-page {
        padding: 12px 10px;
      }
    }

    @media (max-width: 420px) {
      .bc-app-nav {
        justify-content: flex-start;
        align-content: flex-start;
      }

      .bc-app-nav-link {
        flex: 0 0 auto;
        min-width: max-content;
        white-space: nowrap;
        text-align: left;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .bc-app-nav-link {
        transition: none;
      }
      .bc-navigation-progress span {
        animation: none;
        width: 100%;
      }
    }
  `,
    }}
  />
);

export default function App() {
  const { apiKey, isOffline } = useLoaderData();

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

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
