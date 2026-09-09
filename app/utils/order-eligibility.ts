/**
 * Checks whether an order is still within the return window, given the
 * order's creation date and the store's configured window length in days.
 * Pure function, safe to import from both server and client code.
 */
export function isWithinReturnWindow(orderCreatedAt: string, returnWindowDays: number): boolean {
  const orderDate = new Date(orderCreatedAt);
  const deadline = new Date(orderDate);
  deadline.setDate(deadline.getDate() + returnWindowDays);
  return new Date() <= deadline;
}
