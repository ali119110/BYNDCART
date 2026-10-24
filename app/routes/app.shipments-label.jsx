import prisma from "../db.server";
import { requireTenantContext } from "../services/tenant.server";
import { getDecryptedCourierCredentials } from "../services/courier.server";

/**
 * Authenticated proxy for the PostEx Airway Bill API. The carrier requires its token header,
 * so the browser must not receive or store that token. The tracking number must belong to the
 * currently authenticated Shopify tenant before the PDF is fetched.
 */
export async function loader({ request }) {
  const { shopifyStoreId } = await requireTenantContext(request);
  const url = new URL(request.url);
  const trackingNumber = String(
    url.searchParams.get("trackingNumber") || "",
  ).trim();
  const documentType = String(url.searchParams.get("documentType") || "")
    .trim()
    .toUpperCase();

  if (!trackingNumber)
    return new Response("Tracking number is required.", { status: 400 });

  if (documentType === "LABEL") {
    const shipment = await prisma.shipmentTrack.findFirst({
      where: { shopifyStoreId, trackingNumber },
      select: { id: true, courier: true, orderNumber: true },
    });

    if (!shipment)
      return new Response("Shipment not found for this store.", {
        status: 404,
      });
    const document = await prisma.shipmentDocument.findFirst({
      where: {
        shopifyStoreId,
        shipmentTrackId: shipment.id,
        documentType: "LABEL",
      },
      select: { fileName: true, mimeType: true, contentBase64: true },
    });

    if (!document)
      return new Response(
        "No stored carrier label was found for this shipment. Refresh the shipment details or contact support.",
        { status: 404 },
      );
    let body;

    try {
      const decoded = Buffer.from(document.contentBase64, "base64");

      body = new ArrayBuffer(decoded.byteLength);
      new Uint8Array(body).set(decoded);
    } catch {
      return new Response("The stored carrier label could not be decoded.", {
        status: 500,
      });
    }

    if (!body.byteLength)
      return new Response("The stored carrier label is empty.", {
        status: 500,
      });
    const mimeType = [
      "application/pdf",
      "image/png",
      "application/octet-stream",
    ].includes(document.mimeType)
      ? document.mimeType
      : "application/pdf";
    const safeFileName = String(
      document.fileName || `${shipment.courier}-${trackingNumber}.pdf`,
    )
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${safeFileName}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const shipment = await prisma.shipmentTrack.findFirst({
    where: { shopifyStoreId, trackingNumber, courier: "POSTEX" },
    select: { trackingNumber: true, orderNumber: true },
  });

  if (!shipment)
    return new Response("PostEx shipment not found for this store.", {
      status: 404,
    });
  const credentials = await getDecryptedCourierCredentials(
    shopifyStoreId,
    "POSTEX",
  );
  const token = String(
    credentials?.apiToken || credentials?.credentials?.apiToken || "",
  ).trim();

  if (!token || credentials?.isLive !== true)
    return new Response(
      "PostEx credentials are missing, disabled, or unverified.",
      { status: 409 },
    );
  const endpoint = `https://api.postex.pk/services/integration/api/order/v1/get-invoice?trackingNumbers=${encodeURIComponent(shipment.trackingNumber)}`;
  let upstream;

  try {
    upstream = await fetch(endpoint, {
      method: "GET",
      headers: { token, Accept: "application/pdf" },
    });
  } catch {
    return new Response("PostEx could not be reached. Try again later.", {
      status: 502,
    });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");

    return new Response(
      detail || `PostEx invoice request failed with HTTP ${upstream.status}.`,
      {
        status:
          upstream.status >= 400 && upstream.status < 600
            ? upstream.status
            : 502,
      },
    );
  }

  const bytes = await upstream.arrayBuffer();
  const contentType = (
    upstream.headers.get("content-type") || ""
  ).toLowerCase();
  const signature = new TextDecoder().decode(bytes.slice(0, 4));

  if (signature !== "%PDF") {
    const detail = new TextDecoder().decode(bytes.slice(0, 1000)).trim();

    return new Response(
      detail ||
        "PostEx returned an unexpected response instead of a PDF invoice.",
      { status: 502 },
    );
  }

  const safeOrder =
    shipment.orderNumber.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50) ||
    "shipment";

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType.includes("octet-stream")
        ? "application/pdf"
        : upstream.headers.get("content-type") || "application/pdf",
      "Content-Disposition": `attachment; filename="PostEx-${safeOrder}.pdf"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
