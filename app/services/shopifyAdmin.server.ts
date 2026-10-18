const API_VERSION = "2026-07";

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

export function configuredShopDomain(): string | null {
  const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
  return shop || null;
}

export async function getClientCredentialsToken(shop: string): Promise<string> {
  const cached = tokenCache.get(shop);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Shopify client credentials are not configured.");
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const reason = body.error_description || body.error || response.status;
    throw new Error(`Shopify token request failed: ${reason}`);
  }

  const expiresIn = Number(body.expires_in) || 86_399;
  tokenCache.set(shop, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return body.access_token;
}

export async function createClientCredentialsAdmin(shop: string) {
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const token = await getClientCredentialsToken(shop);
      return fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
    },
  };
}
