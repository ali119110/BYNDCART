export const USD_TO_PKR = 280;

export function planPriceInPKR(usdPrice: number): number {
  return Math.round(usdPrice * USD_TO_PKR);
}
