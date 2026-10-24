import { redirect } from "react-router";

export function loader(_args) {
  throw redirect("/app");
}

export default function OrdersRemoved() {
  return null;
}
