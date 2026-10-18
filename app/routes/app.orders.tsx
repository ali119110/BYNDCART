import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader(_args: LoaderFunctionArgs) {
  throw redirect("/app");
}

export default function OrdersRemoved() {
  return null;
}
