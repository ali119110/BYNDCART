import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireTenantContext } from "../services/tenant.server";

/**
 * Customer risk management has been retired from the BYNDCART navigation.
 * Keep a tenant-authenticated redirect for bookmarked legacy URLs.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireTenantContext(request);
  return redirect("/app");
};

export default function Customers() {
  return null;
}
