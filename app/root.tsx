import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import type { LoaderFunction } from "react-router";

export const loader: LoaderFunction = async () => {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "mock-api-key",
    isOffline: process.env.SKIP_AUTH === "true",
  };
};

export default function App() {
  const data = useLoaderData<typeof loader>();
  const { apiKey, isOffline } = data || { apiKey: "mock-api-key", isOffline: true };

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {!isOffline && (
          <>
            <meta name="shopify-api-key" content={apiKey} />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
            <script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
          </>
        )}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
