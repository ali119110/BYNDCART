import prisma from "../db.server";

/**
 * Read-only lookup against the local ProductCache table.
 * Returns null if not cached yet.
 */
export async function getProductByVariantId(shopifyStoreId, shopifyVariantId) {
  return await prisma.productCache.findFirst({
    where: { shopifyStoreId, shopifyVariantId },
  });
}

/**
 * Upsert a variant snapshot into ProductCache, keyed on shopifyVariantId.
 */
export async function upsertProductCache(shopifyStoreId, variant) {
  return await prisma.productCache.upsert({
    where: { shopifyVariantId: variant.shopifyVariantId },
    update: {
      shopifyProductId: variant.shopifyProductId,
      title: variant.title,
      variantTitle: variant.variantTitle ?? null,
      sku: variant.sku ?? null,
      imageUrl: variant.imageUrl ?? null,
      price: variant.price,
      fetchedAt: new Date(),
    },
    create: {
      shopifyStoreId,
      shopifyVariantId: variant.shopifyVariantId,
      shopifyProductId: variant.shopifyProductId,
      title: variant.title,
      variantTitle: variant.variantTitle ?? null,
      sku: variant.sku ?? null,
      imageUrl: variant.imageUrl ?? null,
      price: variant.price,
    },
  });
}

/**
 * Fetch a single variant from Shopify's Admin GraphQL API.
 * `admin` is the authenticated client from tenant context (null in local SKIP_AUTH dev mode).
 */
export async function fetchVariantFromShopify(admin, shopifyVariantId) {
  if (!admin) return null;
  const response = await admin.graphql(
    `#graphql
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        title
        sku
        price
        image { url }
        product { id title }
      }
    }`,
    { variables: { id: shopifyVariantId } },
  );
  const { data } = await response.json();
  const variant = data?.productVariant;

  if (!variant) return null;

  return {
    shopifyVariantId: variant.id,
    shopifyProductId: variant.product?.id ?? "",
    title: variant.product?.title ?? "Unknown Product",
    variantTitle: variant.title !== "Default Title" ? variant.title : null,
    sku: variant.sku ?? null,
    imageUrl: variant.image?.url ?? null,
    price: parseFloat(variant.price ?? "0"),
  };
}

/**
 * Cache-aside helper: return cached variant if present, otherwise fetch from
 * Shopify, cache it, and return it. Returns null gracefully if admin is
 * unavailable (local dev) and nothing is cached yet.
 */
export async function getOrCacheVariant(
  admin,
  shopifyStoreId,
  shopifyVariantId,
) {
  const cached = await getProductByVariantId(shopifyStoreId, shopifyVariantId);

  if (cached) return cached;
  const fetched = await fetchVariantFromShopify(admin, shopifyVariantId);

  if (!fetched) return null;

  return await upsertProductCache(shopifyStoreId, fetched);
}

/** Fetch searchable products from Shopify and keep the returned variants warm in ProductCache. */
export async function getShopifyStoreProducts({
  shopifyStoreId,
  admin,
  query = "",
}) {
  if (!admin) {
    const cached = await prisma.productCache.findMany({
      where: {
        shopifyStoreId,
        ...(query.trim()
          ? {
              OR: [
                { title: { contains: query.trim(), mode: "insensitive" } },
                {
                  variantTitle: { contains: query.trim(), mode: "insensitive" },
                },
                { sku: { contains: query.trim(), mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { title: "asc" },
      take: 50,
    });

    return cached.map((variant) => ({
      ...variant,
      price: Number(variant.price),
      productTitle: variant.title,
      options: [],
    }));
  }

  const response = await admin.graphql(
    `#graphql
    query getStoreProducts($query: String) {
      products(first: 50, query: $query, sortKey: TITLE) {
        edges {
          node {
            id
            title
            featuredImage { url }
            options { name values }
            variants(first: 50) {
              edges {
                node { id title sku price image { url } selectedOptions { name value } }
              }
            }
          }
        }
      }
    }`,
    { variables: { query: query.trim() || null } },
  );
  const { data } = await response.json();
  const variants = [];

  for (const edge of data?.products?.edges ?? []) {
    const product = edge.node;

    for (const variantEdge of product.variants?.edges ?? []) {
      const variant = variantEdge.node;
      const options = variant.selectedOptions ?? [];

      await upsertProductCache(shopifyStoreId, {
        shopifyVariantId: variant.id,
        shopifyProductId: product.id,
        title: product.title,
        variantTitle: variant.title !== "Default Title" ? variant.title : null,
        sku: variant.sku ?? null,
        imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
        price: parseFloat(variant.price ?? "0"),
        options,
      });
      variants.push({
        shopifyVariantId: variant.id,
        shopifyProductId: product.id,
        title: product.title,
        productTitle: product.title,
        variantTitle: variant.title !== "Default Title" ? variant.title : null,
        sku: variant.sku ?? null,
        imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
        price: parseFloat(variant.price ?? "0"),
        options,
      });
    }
  }

  return variants;
}

/**
 * Bulk variant upsert, used by the products/create and products/update
 * webhook handlers where the payload already contains full variant data
 * (no extra GraphQL round-trip needed).
 */
export async function upsertVariantsFromWebhook(
  shopifyStoreId,
  productPayload,
) {
  const productId = `gid://shopify/Product/${productPayload.id}`;
  const productTitle = productPayload.title ?? "Unknown Product";
  const variants = productPayload.variants ?? [];

  for (const v of variants) {
    await upsertProductCache(shopifyStoreId, {
      shopifyVariantId: `gid://shopify/ProductVariant/${v.id}`,
      shopifyProductId: productId,
      title: productTitle,
      variantTitle: v.title && v.title !== "Default Title" ? v.title : null,
      sku: v.sku ?? null,
      imageUrl: productPayload.image?.src ?? null,
      price: parseFloat(v.price ?? "0"),
    });
  }
}

export async function deleteProductFromWebhook(shopifyStoreId, productPayload) {
  const productId = productPayload.id
    ? `gid://shopify/Product/${productPayload.id}`
    : null;

  if (!productId) return;

  try {
    await prisma.productCache.deleteMany({
      where: { shopifyStoreId, shopifyProductId: productId },
    });
  } catch (e) {
    // Ignore error if not cached
  }
}

export async function syncShopifyProducts(shopifyStoreId, admin) {
  if (!admin) return { success: true, synchronizedCount: 0 };
  let synchronizedCount = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query getProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              title
              featuredImage { url }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    image { url }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { cursor } },
    );
    const { data } = await response.json();
    const edges = data?.products?.edges ?? [];

    for (const edge of edges) {
      const pNode = edge.node;
      const vEdges = pNode.variants?.edges ?? [];

      for (const vEdge of vEdges) {
        const vNode = vEdge.node;

        await upsertProductCache(shopifyStoreId, {
          shopifyVariantId: vNode.id,
          shopifyProductId: pNode.id,
          title: pNode.title,
          variantTitle: vNode.title !== "Default Title" ? vNode.title : null,
          sku: vNode.sku ?? null,
          imageUrl: vNode.image?.url ?? pNode.featuredImage?.url ?? null,
          price: parseFloat(vNode.price ?? "0"),
        });
        synchronizedCount++;
      }
    }

    hasNextPage = data?.products?.pageInfo?.hasNextPage ?? false;
    cursor = data?.products?.pageInfo?.endCursor ?? null;
    if (synchronizedCount >= 500) break;
  }

  return { success: true, synchronizedCount };
}
