import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const isOffline = process.env.SKIP_AUTH === "true";
  if (isOffline) {
    return { apiKey: "mock-api-key", isOffline: true };
  }
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", isOffline: false };
};

const navLinks = (
  <s-app-nav>
    <s-link href="/app">Dashboard</s-link>
    <s-link href="/app/returns">Returns</s-link>
    <s-link href="/app/exchanges">Exchanges</s-link>
    <s-link href="/app/orders">Orders</s-link>
    <s-link href="/app/customers">Customers</s-link>
    <s-link href="/app/shipments">Shipments</s-link>
    <s-link href="/app/analytics">Analytics</s-link>
    <s-link href="/app/settings">Settings</s-link>
    <s-link href="/app/warehouse">Warehouse</s-link>
    <s-link href="/app/couriers">Couriers</s-link>
    <s-link href="/app/notifications">Notifications</s-link>
    <s-link href="/app/billing">Billing</s-link>
  </s-app-nav>
);

const styles = (
  <style dangerouslySetInnerHTML={{ __html: `
    body {
      background-color: #f8fafc !important;
      color: #1e293b !important;
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif !important;
    }
    s-page {
      display: block;
      max-width: 1240px;
      margin: 0 auto;
      padding: 24px 20px !important;
    }
    s-app-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      background: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(12px);
      padding: 10px 16px;
      border-radius: 12px;
      border: 1px solid rgba(226, 232, 240, 0.8);
      margin: 16px 20px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.03);
    }
    s-link {
      display: inline-block;
      color: #475569;
      text-decoration: none;
      font-weight: 550;
      font-size: 13px;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    s-link:hover {
      background-color: #f1f5f9;
      color: #6366f1;
    }
    s-heading, h1, h2, h3, h4, strong {
      font-family: 'Outfit', sans-serif !important;
    }
    s-box {
      display: block;
      background: white !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 16px !important;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -2px rgba(0, 0, 0, 0.02) !important;
      padding: 24px !important;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }
    s-box:hover {
      transform: translateY(-4px);
      box-shadow: 0 16px 24px -4px rgba(0, 0, 0, 0.04), 0 8px 8px -4px rgba(0, 0, 0, 0.03) !important;
      border-color: rgba(99, 102, 241, 0.3) !important;
    }
    s-heading {
      font-weight: 700 !important;
      color: #0f172a !important;
      font-size: 20px !important;
      margin-bottom: 8px !important;
    }
    s-text[tone="success"] {
      color: #10b981 !important;
      font-weight: 600 !important;
    }
    s-text[tone="critical"] {
      color: #ef4444 !important;
      font-weight: 600 !important;
    }
    s-text[tone="warning"] {
      color: #f59e0b !important;
      font-weight: 600 !important;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      color: #64748b !important;
      font-size: 11.5px !important;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 10px 6px !important;
      border-bottom: 2px solid #e2e8f0 !important;
      text-align: left;
    }
    td {
      padding: 12px 6px !important;
      border-bottom: 1px solid #f1f5f9 !important;
      font-size: 13.5px;
      color: #334155;
    }
    tr:hover td {
      background-color: #f8fafc;
    }
    s-button, button[type="submit"], [slot="primary-action"] button {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%) !important;
      color: white !important;
      border: none !important;
      border-radius: 8px !important;
      padding: 8px 16px !important;
      font-weight: 600 !important;
      font-size: 13px !important;
      cursor: pointer !important;
      box-shadow: 0 4px 10px 0 rgba(99, 102, 241, 0.3) !important;
      transition: all 0.2s ease-in-out !important;
      font-family: 'Plus Jakarta Sans', sans-serif !important;
    }
    s-button:hover, button[type="submit"]:hover, [slot="primary-action"] button:hover {
      transform: translateY(-1px) !important;
      box-shadow: 0 6px 14px 0 rgba(99, 102, 241, 0.4) !important;
      background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%) !important;
    }
    button {
      background: white !important;
      color: #334155 !important;
      border: 1px solid #e2e8f0 !important;
      border-radius: 8px !important;
      padding: 8px 16px !important;
      font-weight: 550 !important;
      font-size: 13px !important;
      cursor: pointer !important;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.02) !important;
      transition: all 0.2s ease-in-out !important;
      font-family: 'Plus Jakarta Sans', sans-serif !important;
    }
    button:hover {
      background: #f8fafc !important;
      border-color: #cbd5e1 !important;
      color: #0f172a !important;
    }
    input[type="text"], input[type="date"], select {
      border: 1px solid #cbd5e1 !important;
      background-color: #ffffff !important;
      border-radius: 8px !important;
      padding: 10px 14px !important;
      font-size: 13.5px !important;
      color: #1e293b !important;
      outline: none !important;
      transition: all 0.2s ease-in-out !important;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.01) !important;
      font-family: 'Plus Jakarta Sans', sans-serif !important;
    }
    input[type="text"]:focus, input[type="date"]:focus, select:focus {
      border-color: #6366f1 !important;
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1) !important;
    }
    div[style*="background: rgb(0, 128, 96)"], div[style*="background: #008060"] {
      background: linear-gradient(90deg, #10b981 0%, #059669 100%) !important;
    }
    div[style*="background: rgb(92, 106, 196)"], div[style*="background: #5c6ac4"] {
      background: linear-gradient(90deg, #6366f1 0%, #4f46e5 100%) !important;
    }
  `}} />
);

export default function App() {
  const { apiKey, isOffline } = useLoaderData<typeof loader>();

  if (isOffline) {
    return (
      <>
        {styles}
        {navLinks}
        <Outlet />
      </>
    );
  }

  return (
    <AppProvider embedded={true} apiKey={apiKey}>
      {navLinks}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};