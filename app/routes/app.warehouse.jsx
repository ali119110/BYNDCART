import React from "react";
import { useLoaderData, useFetcher } from "react-router";
import { requireTenantContext } from "../utils/tenant.server";
import {
  lookupInboundShipmentByAwb,
  processWarehouseIntake,
  getWarehouseIntakes,
} from "../services/warehouse.server";

// ===== LOADER =====
export async function loader({ request }) {
  const { shopifyStoreId } = await requireTenantContext(request);

  try {
    const recentIntakes = await getWarehouseIntakes(shopifyStoreId, 10);

    return { recentIntakes };
  } catch (error) {
    console.error("[Warehouse] Failed to load recent intakes:", error);

    return { recentIntakes: [] };
  }
}

// ===== ACTION =====
export async function action({ request }) {
  if (request.method !== "POST") {
    return { error: "Method not allowed" };
  }

  const { shopifyStoreId, admin, session } =
    await requireTenantContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "lookup") {
      const scannedAwb = formData.get("scannedAwb") || "";
      const lookupResult = await lookupInboundShipmentByAwb(
        shopifyStoreId,
        scannedAwb,
      );

      return { lookupResult, scannedAwb };
    }

    if (intent === "intake") {
      const returnRequestId = formData.get("returnRequestId");
      const shipmentTrackId = formData.get("shipmentTrackId") || undefined;
      const scannedAwb = formData.get("scannedAwb");
      const notes = formData.get("notes") || undefined;
      const inspectionsJson = formData.get("inspectionsJson");
      const inspections = JSON.parse(inspectionsJson || "[]");
      const intakeResult = await processWarehouseIntake({
        shopifyStoreId,
        returnRequestId,
        shipmentTrackId,
        scannedAwb,
        receivedByUserId: session.id,
        notes,
        admin,
        inspections,
      });

      return { intakeSuccess: true, intakeResult };
    }

    return { error: "Unknown action intent" };
  } catch (error) {
    console.error("[Warehouse Action Error]:", error);

    return { error: error?.message || String(error) };
  }
}

// ===== COMPONENT =====
export default function Warehouse() {
  const { recentIntakes } = useLoaderData();
  const fetcher = useFetcher();
  const [awbInput, setAwbInput] = React.useState("");
  const [inspectionState, setInspectionState] = React.useState({});
  const actionData = fetcher.data;
  const lookupResult = actionData?.lookupResult;
  const isLookingUp =
    fetcher.state === "submitting" &&
    fetcher.formData?.get("intent") === "lookup";
  const isSubmittingIntake =
    fetcher.state === "submitting" &&
    fetcher.formData?.get("intent") === "intake";

  // Initialize inspection input state whenever a valid return request is found
  React.useEffect(() => {
    if (lookupResult?.returnRequest?.items) {
      const initial = {};

      for (const item of lookupResult.returnRequest.items) {
        initial[item.shopifyLineItemId] = {
          receivedQuantity: item.expectedQuantity,
          condition: "RESTOCKABLE",
          notes: "",
        };
      }

      setInspectionState(initial);
    }
  }, [lookupResult]);

  const handleLookupSubmit = (e) => {
    e.preventDefault();
    if (!awbInput.trim()) return;
    fetcher.submit(
      { intent: "lookup", scannedAwb: awbInput.trim() },
      { method: "POST" },
    );
  };

  const handleCompleteIntake = () => {
    if (!lookupResult?.returnRequest) return;
    const items = lookupResult.returnRequest.items;
    const inspectionsPayload = items.map((item) => {
      const state = inspectionState[item.shopifyLineItemId] || {
        receivedQuantity: item.expectedQuantity,
        condition: "RESTOCKABLE",
        notes: "",
      };

      return {
        returnItemId: item.id,
        shopifyLineItemId: item.shopifyLineItemId,
        title: item.title,
        sku: item.sku,
        expectedQuantity: item.expectedQuantity,
        receivedQuantity: Number(state.receivedQuantity),
        condition: state.condition,
        inspectionNotes: state.notes,
      };
    });

    fetcher.submit(
      {
        intent: "intake",
        returnRequestId: lookupResult.returnRequest.id,
        shipmentTrackId: lookupResult.shipment?.id,
        scannedAwb: actionData?.scannedAwb || awbInput.trim(),
        notes: "Intake verified via Warehouse Receiving System",
        inspectionsJson: JSON.stringify(inspectionsPayload),
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Warehouse Receiving & Inspection System">
      {/* Search Bar / AWB Barcode Scanner */}
      <s-section heading="Package Intake Scanner">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Scan or enter the Inbound Courier AWB tracking number (e.g.{" "}
              <code>771234567890</code>, <code>LEO-79138694-PK</code>) or order
              number.
            </s-paragraph>

            <form
              onSubmit={handleLookupSubmit}
              style={{ display: "flex", gap: "12px", maxWidth: "600px" }}
            >
              <input
                type="text"
                value={awbInput}
                onChange={(e) => setAwbInput(e.target.value)}
                placeholder="Scan AWB barcode or enter Order #..."
                style={{
                  flex: 1,
                  padding: "10px 14px",
                  fontSize: "14px",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  fontFamily: "monospace",
                }}
              />
              <s-button
                variant="primary"
                type="submit"
                disabled={isLookingUp || !awbInput.trim()}
              >
                {isLookingUp ? "Searching..." : "Find Inbound Package"}
              </s-button>
            </form>

            {fetcher.data?.error && (
              <s-text tone="critical">{fetcher.data.error}</s-text>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Success Notification */}
      {actionData?.intakeSuccess && (
        <s-section heading="Receiving Complete">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-text tone="success">
                ✅ Package intake & item inspection saved successfully! Return
                status updated to <strong>COMPLETED</strong>.
              </s-text>
              {actionData.intakeResult?.inventoryRestocked && (
                <s-text tone="info">
                  📦 Restockable items have been synchronized with active
                  Shopify inventory.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-section>
      )}

      {/* Inbound Shipment Lookup Result Card */}
      {lookupResult && (
        <s-section heading="Inbound Package Verification">
          {!lookupResult.found ? (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-text tone="caution">
                ⚠️ No inbound return shipment found matching AWB '
                <strong>{actionData?.scannedAwb}</strong>'. Please check
                tracking number or search by Order number.
              </s-text>
            </s-box>
          ) : lookupResult.alreadyReceived ? (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small">
                <s-text tone="warning">
                  ℹ️ Package was already received and inspected! Intake ID:{" "}
                  <strong>{lookupResult.existingIntakeId}</strong>.
                </s-text>
                <s-paragraph>
                  Order:{" "}
                  <strong>{lookupResult.returnRequest?.orderNumber}</strong> (
                  {lookupResult.returnRequest?.customerEmail})
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="base">
              {/* Package Summary Meta */}
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "16px",
                  }}
                >
                  <div>
                    <s-text tone="neutral">Order Number</s-text>
                    <div>
                      <strong>{lookupResult.returnRequest.orderNumber}</strong>
                    </div>
                  </div>
                  <div>
                    <s-text tone="neutral">Customer</s-text>
                    <div>
                      <strong>{lookupResult.returnRequest.customerName}</strong>
                    </div>
                  </div>
                  <div>
                    <s-text tone="neutral">Courier & AWB</s-text>
                    <div>
                      <strong>{lookupResult.shipment.courier}</strong> (
                      {lookupResult.shipment.trackingNumber})
                    </div>
                  </div>
                  <div>
                    <s-text tone="neutral">Return Reason</s-text>
                    <div>
                      <strong>{lookupResult.returnRequest.reason}</strong>
                    </div>
                  </div>
                </div>
              </s-box>

              {/* Inspection Form Table */}
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-heading>
                    Item Condition & Quality Control Grading
                  </s-heading>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      textAlign: "left",
                    }}
                  >
                    <thead>
                      <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                        <th style={{ padding: "10px 8px" }}>Item / SKU</th>
                        <th style={{ padding: "10px 8px", width: "90px" }}>
                          Expected
                        </th>
                        <th style={{ padding: "10px 8px", width: "100px" }}>
                          Received Qty
                        </th>
                        <th style={{ padding: "10px 8px", width: "160px" }}>
                          Condition
                        </th>
                        <th style={{ padding: "10px 8px" }}>
                          Inspection Notes
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {lookupResult.returnRequest.items.map((item) => {
                        const state = inspectionState[
                          item.shopifyLineItemId
                        ] || {
                          receivedQuantity: item.expectedQuantity,
                          condition: "RESTOCKABLE",
                          notes: "",
                        };

                        return (
                          <tr
                            key={item.id}
                            style={{ borderBottom: "1px solid #f1f2f3" }}
                          >
                            <td style={{ padding: "10px 8px" }}>
                              <div>
                                <strong>{item.title}</strong>
                              </div>
                              <s-text tone="neutral">SKU: {item.sku}</s-text>
                            </td>
                            <td style={{ padding: "10px 8px" }}>
                              <strong>{item.expectedQuantity}</strong>
                            </td>
                            <td style={{ padding: "10px 8px" }}>
                              <input
                                type="number"
                                min={0}
                                max={item.expectedQuantity * 2}
                                value={state.receivedQuantity}
                                onChange={(e) =>
                                  setInspectionState({
                                    ...inspectionState,
                                    [item.shopifyLineItemId]: {
                                      ...state,
                                      receivedQuantity: Number(e.target.value),
                                    },
                                  })
                                }
                                style={{
                                  width: "70px",
                                  padding: "6px 8px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "4px",
                                }}
                              />
                            </td>
                            <td style={{ padding: "10px 8px" }}>
                              <select
                                value={state.condition}
                                onChange={(e) =>
                                  setInspectionState({
                                    ...inspectionState,
                                    [item.shopifyLineItemId]: {
                                      ...state,
                                      condition: e.target.value,
                                    },
                                  })
                                }
                                style={{
                                  width: "150px",
                                  padding: "6px 8px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "4px",
                                }}
                              >
                                <option value="RESTOCKABLE">
                                  RESTOCKABLE (Restock)
                                </option>
                                <option value="DAMAGED">
                                  DAMAGED (Write off)
                                </option>
                                <option value="DEFECTIVE">
                                  DEFECTIVE (Vendor return)
                                </option>
                                <option value="WRONG_ITEM">WRONG ITEM</option>
                                <option value="MISSING_ITEM">
                                  MISSING ITEM
                                </option>
                                <option value="DISCARD">DISCARD</option>
                              </select>
                            </td>
                            <td style={{ padding: "10px 8px" }}>
                              <input
                                type="text"
                                placeholder="Add condition notes..."
                                value={state.notes}
                                onChange={(e) =>
                                  setInspectionState({
                                    ...inspectionState,
                                    [item.shopifyLineItemId]: {
                                      ...state,
                                      notes: e.target.value,
                                    },
                                  })
                                }
                                style={{
                                  width: "100%",
                                  padding: "6px 8px",
                                  border: "1px solid #c9cccf",
                                  borderRadius: "4px",
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div
                    style={{
                      marginTop: "16px",
                      display: "flex",
                      justifyContent: "flex-end",
                    }}
                  >
                    <s-button
                      variant="primary"
                      onClick={handleCompleteIntake}
                      disabled={isSubmittingIntake}
                    >
                      {isSubmittingIntake
                        ? "Processing Intake..."
                        : "Complete Package Intake & Inspection"}
                    </s-button>
                  </div>
                </s-stack>
              </s-box>
            </s-stack>
          )}
        </s-section>
      )}

      {/* Historical Intake Audit Trail */}
      <s-section heading="Recent Package Receiving Log">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            {recentIntakes.length === 0 ? (
              <s-text tone="neutral">
                No warehouse package intakes recorded yet.
              </s-text>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  textAlign: "left",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                    <th style={{ padding: "8px 0" }}>
                      <s-text tone="neutral">AWB / Order</s-text>
                    </th>
                    <th style={{ padding: "8px 0" }}>
                      <s-text tone="neutral">Customer Email</s-text>
                    </th>
                    <th style={{ padding: "8px 0" }}>
                      <s-text tone="neutral">Inspected Items</s-text>
                    </th>
                    <th style={{ padding: "8px 0" }}>
                      <s-text tone="neutral">Status</s-text>
                    </th>
                    <th style={{ padding: "8px 0" }}>
                      <s-text tone="neutral">Received Date</s-text>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentIntakes.map((intake) => (
                    <tr
                      key={intake.id}
                      style={{ borderBottom: "1px solid #f1f2f3" }}
                    >
                      <td style={{ padding: "8px 0" }}>
                        <div>
                          <strong>{intake.returnRequest?.orderNumber}</strong>
                        </div>
                        <s-text tone="neutral">AWB: {intake.scannedAwb}</s-text>
                      </td>
                      <td style={{ padding: "8px 0" }}>
                        {intake.returnRequest?.customerEmail}
                      </td>
                      <td style={{ padding: "8px 0" }}>
                        <strong>{intake.inspections?.length || 0} items</strong>
                      </td>
                      <td style={{ padding: "8px 0" }}>
                        <s-badge tone="success">{intake.status}</s-badge>
                      </td>
                      <td style={{ padding: "8px 0" }}>
                        {new Date(intake.receivedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}
