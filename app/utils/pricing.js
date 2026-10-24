export const USD_TO_PKR = 280;

export function planPriceInPKR(usdPrice) {
  return Math.round(usdPrice * USD_TO_PKR);
}
