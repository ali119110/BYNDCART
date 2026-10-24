/**
 * Pakistan logistics helper for address normalization, city auto-matching,
 * mobile number sanitization, and COD calculations across PostEx, Leopards, TCS, and Trax.
 */
export const MAJOR_PAKISTANI_CITIES = [
  "Karachi",
  "Lahore",
  "Islamabad",
  "Rawalpindi",
  "Faisalabad",
  "Multan",
  "Peshawar",
  "Quetta",
  "Sialkot",
  "Gujranwala",
  "Hyderabad",
  "Bahawalpur",
  "Sargodha",
  "Sukkur",
  "Gujrat",
  "Mardan",
  "Sahiwal",
  "Sheikhupura",
  "Rahim Yar Khan",
  "Jhang",
  "Dera Ghazi Khan",
  "Kasur",
  "Abbottabad",
  "Mirpur Khas",
  "Okara",
  "Mandi Bahauddin",
  "Chiniot",
  "Jhelum",
  "Kamoke",
  "Hafizabad",
  "Sadiqabad",
  "Muzaffargarh",
  "Khanewal",
  "Charsadda",
  "Swabi",
  "Nowshera",
  "Dadu",
  "Vehari",
  "Wah Cantt",
  "Kohat",
  "Dera Ismail Khan",
  "Attock",
  "Bannu",
  "Turbat",
  "Mirpur (AJK)",
  "Muzaffarabad",
  "Gilgit",
  "Skardu",
  "Gwadar",
  "Chitral",
  "Mingora",
  "Mansehra",
  "Chakwal",
  "Mianwali",
  "Tando Allahyar",
  "Tando Adam",
  "Kot Adu",
  "Khairpur",
  "Shikarpur",
  "Jacobabad",
  "Khuzdar",
  "Pakpattan",
  "Jaranwala",
  "Chishtian",
  "Daska",
  "Ahmadpur East",
  "Kamalia",
  "Wazirabad",
  "Gojra",
  "Bahawalnagar",
  "Muridke",
  "Bhalwal",
  "Haripur",
  "Swat",
];
const CITY_SYNONYMS = {
  khi: "Karachi",
  karachi: "Karachi",
  "karachi cantt": "Karachi",
  "karachi city": "Karachi",
  "dha karachi": "Karachi",
  lhr: "Lahore",
  lahore: "Lahore",
  "lahore cantt": "Lahore",
  "dha lahore": "Lahore",
  isb: "Islamabad",
  islamabad: "Islamabad",
  rwp: "Rawalpindi",
  pindi: "Rawalpindi",
  rawalpindi: "Rawalpindi",
  "rawalpindi cantt": "Rawalpindi",
  fsd: "Faisalabad",
  faisalabad: "Faisalabad",
  lyallpur: "Faisalabad",
  mux: "Multan",
  multan: "Multan",
  pew: "Peshawar",
  peshawar: "Peshawar",
  uet: "Quetta",
  quetta: "Quetta",
  skt: "Sialkot",
  sialkot: "Sialkot",
  gwa: "Gujranwala",
  gujranwala: "Gujranwala",
  hyd: "Hyderabad",
  hyderabad: "Hyderabad",
  bwp: "Bahawalpur",
  bahawalpur: "Bahawalpur",
  sgd: "Sargodha",
  sargodha: "Sargodha",
  skr: "Sukkur",
  sukkur: "Sukkur",
  ryk: "Rahim Yar Khan",
  "r.y. khan": "Rahim Yar Khan",
  "rahim yar khan": "Rahim Yar Khan",
  dgk: "Dera Ghazi Khan",
  "d.g. khan": "Dera Ghazi Khan",
  "dg khan": "Dera Ghazi Khan",
  "dera ghazi khan": "Dera Ghazi Khan",
  dik: "Dera Ismail Khan",
  "d.i. khan": "Dera Ismail Khan",
  "di khan": "Dera Ismail Khan",
  "dera ismail khan": "Dera Ismail Khan",
  atd: "Abbottabad",
  abbottabad: "Abbottabad",
  wah: "Wah Cantt",
  "wah cantt": "Wah Cantt",
  "wah cannt": "Wah Cantt",
  mbd: "Mandi Bahauddin",
  "mandi bahauddin": "Mandi Bahauddin",
  "mandi baha ud din": "Mandi Bahauddin",
  mirpur: "Mirpur (AJK)",
  "mirpur ajk": "Mirpur (AJK)",
};

/**
 * Normalizes any Pakistani mobile number format (+92300, 0092300, 92300, 0300-1234567)
 * into the standard 11-digit courier format: 03XXXXXXXXX.
 */
export function normalizePakistaniMobile(raw) {
  let digits = String(raw || "").replace(/[^0-9]/g, "");

  if (digits.startsWith("0092")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("92") && digits.length === 12)
    digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("3"))
    digits = `0${digits}`;

  if (/^03[0-9]{9}$/.test(digits)) {
    return digits;
  }

  return digits;
}

/**
 * Validates if the phone number is a genuine 11-digit Pakistani mobile number.
 */
export function isValidPakistaniMobile(phone) {
  const normalized = normalizePakistaniMobile(phone);

  return /^03[0-9]{9}$/.test(normalized);
}

/**
 * Matches customer input or shipping address string against canonical Pakistani cities.
 */
export function matchPakistaniCity(inputCity, fullAddress) {
  const cleanCity = String(inputCity || "")
    .trim()
    .toLowerCase()
    .replace(/[.,\-_/]/g, " ")
    .replace(/\s+/g, " ");

  if (cleanCity && CITY_SYNONYMS[cleanCity]) {
    return CITY_SYNONYMS[cleanCity];
  }

  // Exact case-insensitive match against canonical city list
  for (const city of MAJOR_PAKISTANI_CITIES) {
    if (city.toLowerCase() === cleanCity) {
      return city;
    }
  }

  // Partial match inside city input
  for (const [synonym, canonical] of Object.entries(CITY_SYNONYMS)) {
    if (cleanCity.includes(synonym) && synonym.length >= 3) {
      return canonical;
    }
  }

  // Check full address string if city input was ambiguous or unmapped
  const cleanAddress = String(fullAddress || "")
    .toLowerCase()
    .replace(/[.,\-_/]/g, " ")
    .replace(/\s+/g, " ");

  for (const [synonym, canonical] of Object.entries(CITY_SYNONYMS)) {
    // Only test words of length 4+ to prevent false substring positives in street names
    if (synonym.length >= 4 && cleanAddress.includes(synonym)) {
      return canonical;
    }
  }

  // Never invent a delivery city. Require an explicit choice when Shopify's city
  // field and address do not identify one.
  return inputCity ? inputCity.trim() : "";
}

/**
 * Estimates package weight from line items or defaults to 0.5 kg standard flyer size.
 */
export function estimatePackageWeight(lineItems) {
  if (!lineItems || !lineItems.length) return 0.5;
  const totalGrams = lineItems.reduce((acc, item) => {
    const qty = Number(item.quantity) || 1;
    const g = Number(item.grams) || 250;

    return acc + qty * g;
  }, 0);
  const kg = Math.round((totalGrams / 1000) * 10) / 10;

  return Math.max(0.5, kg);
}
