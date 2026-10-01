// ----------------------------------------------------
// Returns Mock Data
// ----------------------------------------------------
export const mockReturns = [
  {
    id: "RET-9042",
    orderNumber: "#1042",
    customerName: "Sarah Miller",
    customerEmail: "sarah.m@example.com",
    reason: "Size too small",
    status: "Pending",
    date: "2026-08-10",
    customerNote:
      "The boots fit too tight. I would like to exchange them or get credit.",
    items: [
      {
        name: "Premium Leather Winter Boots - Black / 7",
        sku: "BOOT-WNT-BLK-07",
        price: 120.0,
        quantity: 1,
      },
    ],
    timeline: [
      {
        status: "Pending",
        title: "Return Requested",
        description: "Customer requested a return for 1 item.",
        date: "2026-08-10 11:34 AM",
      },
    ],
  },
  {
    id: "RET-8935",
    orderNumber: "#1035",
    customerName: "Emily Watson",
    customerEmail: "emily.w@example.com",
    reason: "Defective item",
    status: "Approved",
    date: "2026-08-08",
    customerNote: "There is a tear on the left sleeve stitching.",
    items: [
      {
        name: "Polar Fleece Hoodie - Grey / M",
        sku: "HOOD-PLR-GRY-MD",
        price: 65.0,
        quantity: 1,
      },
    ],
    timeline: [
      {
        status: "Approved",
        title: "Return Approved",
        description: "System auto-approved the return based on policy rules.",
        date: "2026-08-08 04:12 PM",
      },
      {
        status: "Pending",
        title: "Return Requested",
        description: "Customer requested return due to stitching defect.",
        date: "2026-08-08 03:50 PM",
      },
    ],
  },
  {
    id: "RET-8902",
    orderNumber: "#1031",
    customerName: "David Kim",
    customerEmail: "david.k@example.com",
    reason: "Wrong item sent",
    status: "In Transit",
    date: "2026-08-07",
    items: [
      {
        name: "Wool Knit Beanie - Olive",
        sku: "BEAN-WOL-OLV-OS",
        price: 25.0,
        quantity: 1,
      },
    ],
    timeline: [
      {
        status: "In Transit",
        title: "Package Picked Up",
        description: "Carrier (DHL) picked up return shipment from customer.",
        date: "2026-08-09 10:00 AM",
      },
      {
        status: "Approved",
        title: "Return Approved",
        description: "Admin approved wrong item return.",
        date: "2026-08-07 02:30 PM",
      },
      {
        status: "Pending",
        title: "Return Requested",
        description: "Customer submitted wrong item request.",
        date: "2026-08-07 01:15 PM",
      },
    ],
  },
  {
    id: "RET-8841",
    orderNumber: "#1025",
    customerName: "Michael Chang",
    customerEmail: "michael.c@example.com",
    reason: "Buyer's remorse",
    status: "Received",
    date: "2026-08-05",
    items: [
      {
        name: "Minimalist Canvas Backpack - Tan",
        sku: "BAG-MIN-TAN-OS",
        price: 85.0,
        quantity: 1,
      },
    ],
    timeline: [
      {
        status: "Received",
        title: "Package Delivered",
        description:
          "Return delivered at primary warehouse. Inspection pending.",
        date: "2026-08-08 09:30 AM",
      },
      {
        status: "In Transit",
        title: "In Transit",
        description: "Shipment is in route.",
        date: "2026-08-05 02:00 PM",
      },
      {
        status: "Approved",
        title: "Return Approved",
        description: "Approved",
        date: "2026-08-05 01:00 PM",
      },
    ],
  },
  {
    id: "RET-8712",
    orderNumber: "#1019",
    customerName: "Sarah Connor",
    customerEmail: "sconnor@example.com",
    reason: "Size too large",
    status: "Completed",
    date: "2026-08-03",
    items: [
      {
        name: "Performance Running Shorts - Blue / L",
        sku: "SHRT-RUN-BLU-LG",
        price: 40.0,
        quantity: 2,
      },
    ],
    timeline: [
      {
        status: "Completed",
        title: "Refund Processed",
        description:
          "Refund of $80.00 was issued back to original credit card.",
        date: "2026-08-06 11:20 AM",
      },
      {
        status: "Received",
        title: "Inspected",
        description: "Warehouse marked items as re-stockable.",
        date: "2026-08-05 03:40 PM",
      },
      {
        status: "Received",
        title: "Package Received",
        description: "Delivered to warehouse.",
        date: "2026-08-05 10:15 AM",
      },
    ],
  },
  {
    id: "RET-8610",
    orderNumber: "#1010",
    customerName: "John Doe",
    customerEmail: "john.doe@example.com",
    reason: "Worn/Used",
    status: "Rejected",
    date: "2026-07-28",
    adminNote:
      "Returned item had clear signs of mud and heavy usage. Rejected according to return policy.",
    items: [
      {
        name: "Trailblazer Sneaker - Red / 10",
        sku: "SHOE-TRL-RED-10",
        price: 110.0,
        quantity: 1,
      },
    ],
    timeline: [
      {
        status: "Rejected",
        title: "Return Rejected",
        description: "Admin rejected return. Product is heavily soiled.",
        date: "2026-07-31 01:45 PM",
      },
      {
        status: "Received",
        title: "Inspected",
        description: "Item failed quality control check.",
        date: "2026-07-30 02:00 PM",
      },
      {
        status: "Pending",
        title: "Return Requested",
        description: "Return request submitted.",
        date: "2026-07-28 09:00 AM",
      },
    ],
  },
];
// ----------------------------------------------------
// Exchanges Mock Data
// ----------------------------------------------------
export const mockExchanges = [
  {
    id: "EXC-2939",
    originalOrder: "#1039",
    customerName: "James Larson",
    customerEmail: "james.l@example.com",
    status: "Pending",
    date: "2026-08-09",
    priceDifference: 0.0,
    originalItem: {
      name: "Graphic Cotton Tee - Black / M",
      sku: "TEE-GRP-BLK-MD",
      price: 30.0,
      quantity: 1,
    },
    replacementItem: {
      name: "Graphic Cotton Tee - Black / L",
      sku: "TEE-GRP-BLK-LG",
      price: 30.0,
      quantity: 1,
    },
    timeline: [
      {
        status: "Pending",
        title: "Exchange Initiated",
        description:
          "Customer requested exchange for Graphic Cotton Tee - Black / L.",
        date: "2026-08-09 02:20 PM",
      },
    ],
  },
  {
    id: "EXC-2828",
    originalOrder: "#1028",
    customerName: "Robert Taylor",
    customerEmail: "robert.t@example.com",
    status: "Approved",
    date: "2026-08-05",
    priceDifference: 15.0,
    trackingNumber: "1Z999AA10123456784",
    courier: "UPS",
    originalItem: {
      name: "Slim Fit Chino Pants - Khaki / 32",
      sku: "PNT-SLM-KHK-32",
      price: 55.0,
      quantity: 1,
    },
    replacementItem: {
      name: "Stretch Denim Jeans - Dark Wash / 32",
      sku: "PNT-DEN-DRK-32",
      price: 70.0,
      quantity: 1,
    },
    timeline: [
      {
        status: "Approved",
        title: "Exchange Approved",
        description:
          "Merchant approved exchange. Replacement Draft Order #1028-EX generated.",
        date: "2026-08-06 09:30 AM",
      },
      {
        status: "Pending",
        title: "Exchange Initiated",
        description:
          "Exchange requested. Customer paid $15.00 price difference.",
        date: "2026-08-05 11:45 AM",
      },
    ],
  },
  {
    id: "EXC-2512",
    originalOrder: "#1015",
    customerName: "Sophia Martinez",
    customerEmail: "sophia.m@example.com",
    status: "In Transit",
    date: "2026-08-01",
    priceDifference: 0.0,
    trackingNumber: "DHL-8729182391",
    courier: "DHL Express",
    originalItem: {
      name: "Polar Fleece Hoodie - Grey / L",
      sku: "HOOD-PLR-GRY-LG",
      price: 65.0,
      quantity: 1,
    },
    replacementItem: {
      name: "Polar Fleece Hoodie - Navy / L",
      sku: "HOOD-PLR-NVY-LG",
      price: 65.0,
      quantity: 1,
    },
    timeline: [
      {
        status: "In Transit",
        title: "Original Return In Transit",
        description: "Original fleece hoodie picked up by DHL.",
        date: "2026-08-03 04:00 PM",
      },
      {
        status: "Approved",
        title: "Exchange Approved",
        description: "Exchange approved.",
        date: "2026-08-02 10:00 AM",
      },
    ],
  },
  {
    id: "EXC-2101",
    originalOrder: "#1005",
    customerName: "Alex Mercer",
    customerEmail: "alex.m@example.com",
    status: "Completed",
    date: "2026-07-22",
    priceDifference: -10.0, // Refund issued for difference
    trackingNumber: "FEDEX-9872192398",
    courier: "FedEx",
    originalItem: {
      name: "Polarized Aviator Sunglasses",
      sku: "GLS-AVT-POL-OS",
      price: 90.0,
      quantity: 1,
    },
    replacementItem: {
      name: "Classic Wayfarer Sunglasses",
      sku: "GLS-WAY-OS",
      price: 80.0,
      quantity: 1,
    },
    timeline: [
      {
        status: "Completed",
        title: "Fulfillment Completed",
        description:
          "Replacement Wayfarer Sunglasses delivered. Original returned items restocked.",
        date: "2026-07-26 11:00 AM",
      },
      {
        status: "Completed",
        title: "Replacement Shipped",
        description: "Replacement order #1005-EX dispatched via FedEx.",
        date: "2026-07-24 02:00 PM",
      },
      {
        status: "Received",
        title: "Original Received & Inspected",
        description:
          "Original Aviators returned and marked re-sellable. Refund of $10.00 difference issued.",
        date: "2026-07-23 03:00 PM",
      },
    ],
  },
];
// ----------------------------------------------------
// Orders Mock Data
// ----------------------------------------------------
export const mockOrders = [
  {
    id: "ORD-1045",
    orderNumber: "#1045",
    customerName: "Rachel Green",
    customerEmail: "rachel.g@example.com",
    orderValue: 85.0,
    returnStatus: "None",
    exchangeStatus: "None",
    date: "2026-08-10",
    items: [
      {
        name: "Minimalist Canvas Backpack - Tan",
        sku: "BAG-MIN-TAN-OS",
        price: 85.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1042",
    orderNumber: "#1042",
    customerName: "Sarah Miller",
    customerEmail: "sarah.m@example.com",
    orderValue: 120.0,
    returnStatus: "Pending",
    exchangeStatus: "None",
    date: "2026-08-10",
    items: [
      {
        name: "Premium Leather Winter Boots - Black / 7",
        sku: "BOOT-WNT-BLK-07",
        price: 120.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1039",
    orderNumber: "#1039",
    customerName: "James Larson",
    customerEmail: "james.l@example.com",
    orderValue: 30.0,
    returnStatus: "None",
    exchangeStatus: "Pending",
    date: "2026-08-09",
    items: [
      {
        name: "Graphic Cotton Tee - Black / M",
        sku: "TEE-GRP-BLK-MD",
        price: 30.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1035",
    orderNumber: "#1035",
    customerName: "Emily Watson",
    customerEmail: "emily.w@example.com",
    orderValue: 65.0,
    returnStatus: "Approved",
    exchangeStatus: "None",
    date: "2026-08-08",
    items: [
      {
        name: "Polar Fleece Hoodie - Grey / M",
        sku: "HOOD-PLR-GRY-MD",
        price: 65.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1031",
    orderNumber: "#1031",
    customerName: "David Kim",
    customerEmail: "david.k@example.com",
    orderValue: 25.0,
    returnStatus: "In Transit",
    exchangeStatus: "None",
    date: "2026-08-07",
    items: [
      {
        name: "Wool Knit Beanie - Olive",
        sku: "BEAN-WOL-OLV-OS",
        price: 25.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1028",
    orderNumber: "#1028",
    customerName: "Robert Taylor",
    customerEmail: "robert.t@example.com",
    orderValue: 55.0,
    returnStatus: "None",
    exchangeStatus: "Approved",
    date: "2026-08-05",
    items: [
      {
        name: "Slim Fit Chino Pants - Khaki / 32",
        sku: "PNT-SLM-KHK-32",
        price: 55.0,
        quantity: 1,
      },
    ],
  },
  {
    id: "ORD-1025",
    orderNumber: "#1025",
    customerName: "Michael Chang",
    customerEmail: "michael.c@example.com",
    orderValue: 85.0,
    returnStatus: "Received",
    exchangeStatus: "None",
    date: "2026-08-05",
    items: [
      {
        name: "Minimalist Canvas Backpack - Tan",
        sku: "BAG-MIN-TAN-OS",
        price: 85.0,
        quantity: 1,
      },
    ],
  },
];
// ----------------------------------------------------
// Customers Mock Data
// ----------------------------------------------------
export const mockCustomers = [
  {
    id: "CST-01",
    name: "Sarah Miller",
    email: "sarah.m@example.com",
    ordersCount: 4,
    returnsCount: 2,
    exchangesCount: 0,
    refundsCount: 1,
    returnRate: "50.0%",
    timeline: [
      {
        action: "Return Request PENDING",
        date: "2026-08-10",
        details: "Requested return for order #1042 (Size too small)",
      },
      {
        action: "Order Placed",
        date: "2026-08-10",
        details: "Bought Premium Leather Winter Boots - Black / 7",
      },
      {
        action: "Return Request COMPLETED",
        date: "2026-05-12",
        details: "Returned order #0940 (Style fit) - Refunded $60.00",
      },
    ],
  },
  {
    id: "CST-02",
    name: "James Larson",
    email: "james.l@example.com",
    ordersCount: 3,
    returnsCount: 0,
    exchangesCount: 1,
    refundsCount: 0,
    returnRate: "0.0%",
    timeline: [
      {
        action: "Exchange Request PENDING",
        date: "2026-08-09",
        details:
          "Exchange requested for order #1039 (Graphic Tee Medium -> Large)",
      },
    ],
  },
  {
    id: "CST-03",
    name: "Emily Watson",
    email: "emily.w@example.com",
    ordersCount: 6,
    returnsCount: 1,
    exchangesCount: 0,
    refundsCount: 0,
    returnRate: "16.6%",
    timeline: [
      {
        action: "Return Approved",
        date: "2026-08-08",
        details: "Return approved for order #1035 (Defective grey hoodie)",
      },
    ],
  },
  {
    id: "CST-04",
    name: "David Kim",
    email: "david.k@example.com",
    ordersCount: 2,
    returnsCount: 1,
    exchangesCount: 0,
    refundsCount: 0,
    returnRate: "50.0%",
    timeline: [
      {
        action: "Return Picked Up",
        date: "2026-08-09",
        details: "Return item for order #1031 (Wool knit beanie) is in transit",
      },
    ],
  },
  {
    id: "CST-05",
    name: "Robert Taylor",
    email: "robert.t@example.com",
    ordersCount: 8,
    returnsCount: 0,
    exchangesCount: 2,
    refundsCount: 0,
    returnRate: "0.0%",
    timeline: [
      {
        action: "Exchange Approved",
        date: "2026-08-06",
        details: "Exchange approved for order #1028 (Chino Pants)",
      },
    ],
  },
];
// ----------------------------------------------------
// Shipments Mock Data
// ----------------------------------------------------
export const mockShipments = [
  {
    id: "SHP-89101",
    orderNumber: "#1045",
    type: "Forward",
    courier: "FedEx",
    trackingNumber: "781290381023",
    status: "In Transit",
    date: "2026-08-10",
  },
  {
    id: "SHP-89100",
    orderNumber: "#1042",
    type: "Forward",
    courier: "UPS",
    trackingNumber: "1Z999AA10123009871",
    status: "Delivered",
    date: "2026-08-10",
  },
  {
    id: "SHP-R88902",
    orderNumber: "#1031",
    type: "Return",
    courier: "DHL Express",
    trackingNumber: "DHL-7819283918",
    status: "In Transit",
    date: "2026-08-09",
  },
  {
    id: "SHP-E2828",
    orderNumber: "#1028-EX",
    type: "Exchange",
    courier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    status: "Out for Delivery",
    date: "2026-08-06",
  },
  {
    id: "SHP-R8841",
    orderNumber: "#1025",
    type: "Return",
    courier: "DHL Express",
    trackingNumber: "DHL-9871238912",
    status: "Delivered",
    date: "2026-08-08",
  },
];
// ----------------------------------------------------
// Analytics Mock Data
// ----------------------------------------------------
export const mockAnalytics = {
  returnRate: "4.8%",
  exchangeRate: "2.4%",
  refundRate: "2.4%",
  revenueRetained: "$2,480.00",
  retainedPercent: "32%",
  topReturnedProducts: [
    {
      name: "Premium Leather Winter Boots",
      sku: "BOOT-WNT-BLK",
      rate: "12.4%",
      count: 42,
    },
    {
      name: "Polar Fleece Hoodie",
      sku: "HOOD-PLR-GRY",
      rate: "8.2%",
      count: 28,
    },
    {
      name: "Slim Fit Chino Pants",
      sku: "PNT-SLM-KHK",
      rate: "5.1%",
      count: 18,
    },
    { name: "Wool Knit Beanie", sku: "BEAN-WOL-OLV", rate: "3.2%", count: 11 },
  ],
  returnReasons: [
    { reason: "Size too small", count: 72, percent: "48%" },
    { reason: "Defective item", count: 30, percent: "20%" },
    { reason: "Wrong item sent", count: 24, percent: "16%" },
    { reason: "Buyer's remorse", count: 15, percent: "10%" },
    { reason: "Style fit / Other", count: 9, percent: "6%" },
  ],
  monthlyTrend: [
    { month: "Feb", returnsCount: 92, exchangesCount: 22 },
    { month: "Mar", returnsCount: 110, exchangesCount: 30 },
    { month: "Apr", returnsCount: 98, exchangesCount: 28 },
    { month: "May", returnsCount: 120, exchangesCount: 35 },
    { month: "Jun", returnsCount: 135, exchangesCount: 40 },
    { month: "Jul", returnsCount: 148, exchangesCount: 42 },
  ],
};
