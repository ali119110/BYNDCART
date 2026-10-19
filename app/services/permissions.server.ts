import prisma from "../db.server";

export type AppPermission =
  | "returns"
  | "exchanges"
  | "warehouse"
  | "shipments"
  | "refunds"
  | "cod"
  | "billing"
  | "settings";

const ROLE_PERMISSIONS: Record<string, AppPermission[]> = {
  OWNER: ["returns", "exchanges", "warehouse", "shipments", "refunds", "cod", "billing", "settings"],
  ADMIN: ["returns", "exchanges", "warehouse", "shipments", "refunds", "cod", "billing", "settings"],
  OPERATIONS: ["returns", "exchanges", "warehouse", "shipments", "refunds", "cod"],
  WAREHOUSE: ["warehouse", "shipments"],
  MEMBER: ["returns", "exchanges"],
};

export function roleAllows(role: string | null | undefined, permission: AppPermission) {
  const normalized = (role || "ADMIN").toUpperCase();
  const allowed = ROLE_PERMISSIONS[normalized] || ROLE_PERMISSIONS.ADMIN;
  return allowed.includes(permission);
}

function sessionEmail(session: any): string | null {
  return (
    session?.onlineAccessInfo?.associated_user?.email ||
    session?.email ||
    null
  );
}

/**
 * Enforces a mapped staff role when one exists.
 * Installing merchants and offline sessions have no staff email and keep owner access.
 */
export async function assertPermission(shopifyStoreId: string, session: any, permission: AppPermission) {
  const email = sessionEmail(session);
  if (!email) return;

  const user = await prisma.user.findFirst({
    where: {
      email,
      merchant: { shopifyStores: { some: { id: shopifyStoreId } } },
    },
  });

  if (!user) return;
  if (roleAllows(user.role, permission)) return;

  throw new Response(
    JSON.stringify({
      success: false,
      error: { message: "Your role cannot perform this action.", code: "FORBIDDEN" },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
}
