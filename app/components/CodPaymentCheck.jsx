import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

function isDeliveredUnpaid(item) {
  return (
    !item.ignored &&
    !item.returned &&
    item.delivered === true &&
    item.paymentStatus === "Payment Not Confirmed"
  );
}

function isSafe(item) {
  return (
    item.delivered &&
    item.paymentReceived &&
    item.matched &&
    !item.returned &&
    !item.ignored &&
    !item.cancelled &&
    !item.unassigned &&
    item.relevant
  );
}

function hasDiscrepancy(item) {
  return item.courierAmount > 0 && !item.amountMatched;
}

function summaryAmount(item) {
  return item.courierAmount > 0 ? item.courierAmount : item.shopifyAmount;
}

function money(value) {
  return `PKR ${Math.round(value).toLocaleString("en-PK")}`;
}

export function CodPaymentCheck({ taxPercent = 4, deliveryCharge = 280 }) {
  const verifyFetcher = useFetcher();
  const markFetcher = useFetcher();
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [batch, setBatch] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(null);
  const [status, setStatus] = useState(
    "Use Verify & reconcile all to check every matching page and reconcile all safely matched settlements in one operation.",
  );
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [courierFilter, setCourierFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [selected, setSelected] = useState([]);
  const [paidIds, setPaidIds] = useState([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [autoReconcileOnVerify, setAutoReconcileOnVerify] = useState(false);
  const stopAuto = useRef(false);
  const verifyWait = useRef(null);
  const markWait = useRef(null);

  useEffect(() => {
    const data = verifyFetcher.data;

    if (verifyFetcher.state !== "idle" || !data || !verifyWait.current) return;
    const resolve = verifyWait.current;

    verifyWait.current = null;
    resolve(data);
  }, [verifyFetcher.state, verifyFetcher.data]);
  useEffect(() => {
    const data = markFetcher.data;

    if (
      markFetcher.state !== "idle" ||
      !data ||
      data.intent !== "MARK" ||
      !markWait.current
    )
      return;
    const resolve = markWait.current;

    markWait.current = null;
    resolve(data);
  }, [markFetcher.state, markFetcher.data]);

  function applyBatch(data, append) {
    const nextRows = data.results || [];

    setRows((current) => (append ? [...current, ...nextRows] : nextRows));
    setCursor(data.nextCursor || null);
    setHasNext(data.hasNextPage === true);
    setBatch((current) => (append ? current + 1 : 1));
    if (typeof data.totalPending === "number")
      setPendingTotal(data.totalPending);

    if (!append) {
      setSelected([]);
    }

    if (!data.ok)
      setError(data.message || "Courier verification check failed.");
    else setError("");
  }

  function submitVerify(nextCursor, mode) {
    return new Promise((resolve, reject) => {
      if (verifyWait.current) {
        reject(new Error("A courier verification check is already running."));

        return;
      }

      verifyWait.current = resolve;
      verifyFetcher.submit(
        { intent: "VERIFY", cursor: nextCursor || "", mode },
        { method: "post" },
      );
    });
  }

  async function verify(append) {
    setError("");
    setStatus(append ? `Verifying batch ${batch + 1}…` : "Verifying orders…");
    const data = await submitVerify(
      append ? cursor : null,
      append ? "append" : "replace",
    );

    applyBatch(data, append);
    const loaded = append
      ? rows.length + (data.results?.length || 0)
      : data.results?.length || 0;

    setStatus(
      data.ok
        ? `Batch ${append ? batch + 1 : 1}: ${data.results?.length || 0} orders verified. ${loaded} loaded${pendingTotal ? ` of ${pendingTotal}` : ""}.`
        : data.message || "Courier check failed.",
    );

    // If auto-reconcile on verify is enabled, reconcile safely matched orders
    if (autoReconcileOnVerify && data.ok && data.results?.length) {
      const safeIds = data.results.filter(isSafe).map((r) => r.orderId);

      if (safeIds.length > 0) {
        await executeReconciliation(safeIds, false);
      }
    }

    return data;
  }

  async function autoVerify(reconcileAll = false) {
    if (autoRunning) {
      stopAuto.current = true;

      return;
    }

    stopAuto.current = false;
    setAutoRunning(true);
    setError("");

    try {
      let data = await submitVerify(null, "replace");

      applyBatch(data, false);
      let loaded = data.results?.length || 0;
      const allVerifiedRows = [...(data.results || [])];
      let page = 1;
      let next = data.nextCursor || null;
      let more = data.hasNextPage === true;

      setStatus(`Batch 1 verified. ${loaded} orders loaded.`);

      if (
        !reconcileAll &&
        autoReconcileOnVerify &&
        data.ok &&
        data.results?.length
      ) {
        const safeIds = data.results.filter(isSafe).map((r) => r.orderId);

        if (safeIds.length > 0) await executeReconciliation(safeIds, false);
      }

      while (more && next && !stopAuto.current) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (stopAuto.current) break;
        page += 1;
        setStatus(`Verifying batch ${page}…`);
        data = await submitVerify(next, "append");

        if (!data.ok) {
          setError(data.message || `Batch ${page} failed.`);
          break;
        }

        const count = data.results?.length || 0;

        loaded += count;
        setRows((current) => [...current, ...(data.results || [])]);
        next = data.nextCursor || null;
        more = data.hasNextPage === true;
        setCursor(next);
        setHasNext(more);
        setBatch(page);
        setStatus(`Batch ${page} verified. ${loaded} orders loaded.`);
        allVerifiedRows.push(...(data.results || []));

        if (
          !reconcileAll &&
          autoReconcileOnVerify &&
          data.ok &&
          data.results?.length
        ) {
          const safeIds = data.results.filter(isSafe).map((r) => r.orderId);

          if (safeIds.length > 0) await executeReconciliation(safeIds, false);
        }
      }

      if (stopAuto.current) {
        setStatus(
          `Verification stopped. ${loaded} orders loaded. No full reconciliation was started.`,
        );
      } else if (reconcileAll) {
        const safeIds = Array.from(
          new Set(allVerifiedRows.filter(isSafe).map((item) => item.orderId)),
        );

        if (!safeIds.length) {
          setStatus(
            `Checked all ${loaded} orders. No order currently meets the strict delivered, payment-received and amount-matched checks for automatic reconciliation.`,
          );
        } else {
          setStatus(
            `Checked all ${loaded} orders. Reconciling ${safeIds.length} safely matched orders in one operation…`,
          );
          await executeReconciliation(safeIds, false);
        }
      } else {
        setStatus(
          `All ${loaded} pending fulfilled orders verified against couriers.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Auto-verification stopped.",
      );
    } finally {
      setAutoRunning(false);
      stopAuto.current = false;
    }
  }

  function submitMark(orderIds) {
    return new Promise((resolve, reject) => {
      if (markWait.current) {
        reject(new Error("Orders are already being reconciled."));

        return;
      }

      markWait.current = resolve;
      markFetcher.submit(
        { intent: "MARK", orderIds: orderIds.join(",") },
        { method: "post" },
      );
    });
  }

  async function executeReconciliation(orderIds, confirmWithUser = true) {
    if (!orderIds.length) return;
    const count = orderIds.length;

    if (confirmWithUser) {
      const confirmed = window.confirm(
        `Auto-reconcile ${count} delivered and settled order${count === 1 ? "" : "s"}? This will mark them paid in Shopify and automatically log confirmed settlement records in your ledger.`,
      );

      if (!confirmed) return;
    }

    setError("");
    setReconciling(true);

    try {
      // One server action handles the entire safely selected set. The server records
      // individual successes/failures so a partial failure does not hide completed work.
      const data = await submitMark(orderIds);
      const marked = data.marked || [];

      if (marked.length) {
        setPaidIds((current) => [
          ...new Set([...current, ...marked.map((row) => row.orderId)]),
        ]);
        setSelected((current) =>
          current.filter((id) => !marked.some((row) => row.orderId === id)),
        );
      }

      if (!data.ok)
        setError(
          data.message || "Some orders could not be marked paid in Shopify.",
        );
      setStatus(
        data.message ||
          `Successfully reconciled ${marked.length} of ${orderIds.length} orders into Shopify and the settlement ledger.`,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Auto-reconciliation encountered an issue.",
      );
    } finally {
      setReconciling(false);
    }
  }

  // Detect available couriers and counts
  const courierCounts = useMemo(() => {
    let postex = 0;
    let leopard = 0;

    for (const r of rows) {
      if (r.courier.toUpperCase().includes("POSTEX")) postex += 1;
      else if (r.courier.toUpperCase().includes("LEOPARD")) leopard += 1;
    }

    return { postex, leopard };
  }, [rows]);
  // Compute financial totals per courier or overall
  const totals = useMemo(() => {
    const targetRows =
      courierFilter === "ALL"
        ? rows
        : rows.filter((r) =>
            courierFilter === "POSTEX"
              ? r.courier.toUpperCase().includes("POSTEX")
              : r.courier.toUpperCase().includes("LEOPARD"),
          );
    let count = targetRows.length;
    let unpaidCount = 0;
    let unpaidAmount = 0;
    let receivedCount = 0;
    let receivedAmount = 0;
    let charges = 0;
    let matched = 0;
    let discrepanciesCount = 0;
    let discrepanciesAmount = 0;

    for (const item of targetRows) {
      if (item.relevant && item.matched) matched += 1;

      if (hasDiscrepancy(item)) {
        discrepanciesCount += 1;
        discrepanciesAmount += Math.abs(
          item.courierAmount - item.shopifyAmount,
        );
      }

      if (isDeliveredUnpaid(item)) {
        unpaidCount += 1;
        unpaidAmount += item.shopifyAmount;
      }

      if (
        item.delivered &&
        item.paymentReceived &&
        !item.returned &&
        !item.ignored &&
        !item.cancelled &&
        !item.unassigned
      ) {
        receivedCount += 1;
        receivedAmount += summaryAmount(item);
        charges += item.deliveryCharges || 0;
      }
    }

    const rate = Math.min(100, Math.max(0, Number(taxPercent) || 0)) / 100;
    const tax = Math.round(receivedAmount * rate);
    const expectedNet = receivedAmount - tax - charges;

    return {
      count,
      unpaidCount,
      unpaidAmount,
      receivedCount,
      receivedAmount,
      charges,
      matched,
      tax,
      expectedNet,
      discrepanciesCount,
      discrepanciesAmount,
    };
  }, [rows, courierFilter, taxPercent]);
  // Filter rows based on courier, status, and search query
  const visible = useMemo(() => {
    return rows.filter((item) => {
      // Courier filter
      if (
        courierFilter === "POSTEX" &&
        !item.courier.toUpperCase().includes("POSTEX")
      )
        return false;
      if (
        courierFilter === "LEOPARD" &&
        !item.courier.toUpperCase().includes("LEOPARD")
      )
        return false;
      // Status filter
      if (statusFilter === "SETTLED" && !isSafe(item)) return false;
      if (statusFilter === "UNPAID_DELIVERED" && !isDeliveredUnpaid(item))
        return false;
      if (statusFilter === "DISCREPANCY" && !hasDiscrepancy(item)) return false;
      if (statusFilter === "RETURNED" && !item.returned) return false;
      if (statusFilter === "IGNORED" && !item.ignored) return false;
      if (statusFilter === "ALL" && item.ignored) return false;
      // Search query
      const query = search.trim().toLowerCase();

      if (!query) return true;

      return (
        item.orderName.toLowerCase().includes(query) ||
        item.tracking.toLowerCase().includes(query)
      );
    });
  }, [rows, courierFilter, statusFilter, search]);
  const safeVisibleUnreconciled = useMemo(() => {
    return visible
      .filter(isSafe)
      .filter((item) => !paidIds.includes(item.orderId));
  }, [visible, paidIds]);

  function toggle(orderId) {
    setSelected((current) =>
      current.includes(orderId)
        ? current.filter((id) => id !== orderId)
        : [...current, orderId],
    );
  }

  function toggleSelectAll() {
    if (
      selected.length === safeVisibleUnreconciled.length &&
      safeVisibleUnreconciled.length > 0
    ) {
      setSelected([]);
    } else {
      setSelected(safeVisibleUnreconciled.map((r) => r.orderId));
    }
  }

  const checking = verifyFetcher.state !== "idle" || autoRunning;
  const busy = checking || reconciling || markFetcher.state !== "idle";

  return (
    <section className="bc-card bc-stack">
      <div>
        <p className="bc-kicker">AUTOMATED RECONCILIATION</p>
        <h2 className="bc-title">
          Verify courier settlements and auto-reconcile COD
        </h2>
        <p className="bc-muted">
          Queries PostEx and Leopards courier APIs to verify parcel delivery,
          payment collection, and deductions, then automatically reconciles
          settled orders in Shopify and your ledger.
        </p>
      </div>

      {/* Main verification & auto-reconcile toolbar */}
      <div className="bc-actions">
        <button
          type="button"
          className="bc-btn"
          disabled={busy}
          onClick={() => autoVerify(false)}
        >
          {autoRunning ? "Stop verification" : "Verify all"}
        </button>

        <button
          type="button"
          className="bc-btn primary"
          disabled={busy}
          onClick={() => autoVerify(true)}
        >
          {reconciling
            ? "Reconciling all orders…"
            : autoRunning
              ? "Checking all orders…"
              : "Verify & reconcile all"}
        </button>

        <button
          type="button"
          className="bc-btn primary"
          disabled={busy || safeVisibleUnreconciled.length === 0}
          onClick={() =>
            executeReconciliation(safeVisibleUnreconciled.map((r) => r.orderId))
          }
        >
          {courierFilter === "ALL"
            ? `Auto-reconcile matched (${safeVisibleUnreconciled.length})`
            : `Auto-reconcile ${courierFilter === "POSTEX" ? "PostEx" : "Leopards"} (${safeVisibleUnreconciled.length})`}
        </button>

        {selected.length > 0 && (
          <button
            type="button"
            className="bc-btn"
            disabled={busy}
            onClick={() => executeReconciliation(selected)}
          >
            Reconcile selected ({selected.length})
          </button>
        )}

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "12px",
            color: "var(--bc-ink)",
            cursor: "pointer",
            marginLeft: "auto",
          }}
        >
          <input
            type="checkbox"
            checked={autoReconcileOnVerify}
            onChange={(e) => setAutoReconcileOnVerify(e.target.checked)}
          />
          Auto-reconcile settled orders on verify
        </label>
      </div>

      {/* Courier Filter Switcher */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          borderTop: "1px solid var(--bc-line)",
          borderBottom: "1px solid var(--bc-line)",
          padding: "10px 0",
        }}
      >
        <div
          style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
        >
          <span
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--bc-muted)",
            }}
          >
            Courier filter:
          </span>
          <div
            className="bc-range-filter"
            role="group"
            aria-label="Filter orders by courier"
          >
            <button
              type="button"
              className={`bc-range-btn ${courierFilter === "ALL" ? "active" : ""}`}
              onClick={() => setCourierFilter("ALL")}
            >
              All Couriers ({rows.length})
            </button>
            <button
              type="button"
              className={`bc-range-btn ${courierFilter === "POSTEX" ? "active" : ""}`}
              onClick={() => setCourierFilter("POSTEX")}
            >
              PostEx ({courierCounts.postex})
            </button>
            <button
              type="button"
              className={`bc-range-btn ${courierFilter === "LEOPARD" ? "active" : ""}`}
              onClick={() => setCourierFilter("LEOPARD")}
            >
              Leopards ({courierCounts.leopard})
            </button>
          </div>
        </div>

        {/* Status Filter */}
        <div
          style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
        >
          <span
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--bc-muted)",
            }}
          >
            View:
          </span>
          <div
            className="bc-range-filter"
            role="group"
            aria-label="Filter orders by status"
          >
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "ALL" ? "active" : ""}`}
              onClick={() => setStatusFilter("ALL")}
            >
              All
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "SETTLED" ? "active" : ""}`}
              onClick={() => setStatusFilter("SETTLED")}
            >
              Settled
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "UNPAID_DELIVERED" ? "active" : ""}`}
              onClick={() => setStatusFilter("UNPAID_DELIVERED")}
            >
              Delivered unpaid
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "DISCREPANCY" ? "active" : ""}`}
              onClick={() => setStatusFilter("DISCREPANCY")}
            >
              Discrepancies
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "RETURNED" ? "active" : ""}`}
              onClick={() => setStatusFilter("RETURNED")}
            >
              Returned
            </button>
            <button
              type="button"
              className={`bc-range-btn ${statusFilter === "IGNORED" ? "active" : ""}`}
              onClick={() => setStatusFilter("IGNORED")}
            >
              Ignored
            </button>
          </div>
        </div>
      </div>

      {/* Dynamic Courier & Reconciliation Metrics Grid */}
      <div className="bc-grid">
        <article className="bc-card">
          <p className="bc-kicker">
            {courierFilter === "ALL" ? "Loaded" : `${courierFilter} Orders`}
          </p>
          <span className="bc-metric">
            {totals.count}
            {courierFilter === "ALL" && pendingTotal
              ? ` / ${pendingTotal}`
              : ""}
          </span>
          <p className="bc-muted">{totals.matched} ready to reconcile</p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Courier Collected</p>
          <span className="bc-metric">
            {rows.length ? money(totals.receivedAmount) : "—"}
          </span>
          <p className="bc-muted">{totals.receivedCount} parcels settled</p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Courier Charges</p>
          <span className="bc-metric">
            {rows.length ? money(totals.charges) : "—"}
          </span>
          <p className="bc-muted">Delivery & service fees</p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Estimated Tax {taxPercent}%</p>
          <span className="bc-metric">
            {rows.length ? money(totals.tax) : "—"}
          </span>
          <p className="bc-muted">GST deduction</p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Net Remittance</p>
          <span className="bc-metric">
            {rows.length ? money(totals.expectedNet) : "—"}
          </span>
          <p className="bc-muted">Collected minus deductions</p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Delivered Unpaid</p>
          <span className="bc-metric">
            {rows.length ? totals.unpaidCount : "—"}
          </span>
          <p className="bc-muted">
            {rows.length ? money(totals.unpaidAmount) : "—"}
          </p>
        </article>

        <article className="bc-card">
          <p className="bc-kicker">Discrepancies</p>
          <span className="bc-metric">
            {rows.length ? totals.discrepanciesCount : "—"}
          </span>
          <p className="bc-muted">
            {rows.length ? money(totals.discrepanciesAmount) : "—"}
          </p>
        </article>
      </div>

      {/* Search Bar */}
      <label className="bc-field-label" htmlFor="cod-search">
        Search loaded orders
        <input
          id="cod-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Order number (#1001) or tracking number"
        />
      </label>

      {/* Status banner */}
      <p className="bc-muted">
        {status}
        {batch > 0 ? ` Batch ${batch}.` : ""}
      </p>
      {error && <p className="bc-note bad">{error}</p>}

      {/* Orders Table */}
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead>
            <tr>
              <th style={{ width: "40px" }}>
                <input
                  type="checkbox"
                  checked={
                    safeVisibleUnreconciled.length > 0 &&
                    selected.length === safeVisibleUnreconciled.length
                  }
                  disabled={safeVisibleUnreconciled.length === 0}
                  onChange={toggleSelectAll}
                  aria-label="Select all reconcileable orders"
                />
              </th>
              <th>Order</th>
              <th>Tracking</th>
              <th>Courier</th>
              <th>Amounts</th>
              <th>Courier status</th>
              <th>Payment settlement</th>
              <th>Match</th>
              <th>Reconciliation</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={9}>
                  {rows.length === 0
                    ? "No orders verified yet. Use Verify all or Verify & reconcile all above."
                    : "No orders match the current filter."}
                </td>
              </tr>
            )}
            {visible.map((item) => {
              const safe = isSafe(item);
              const paid = paidIds.includes(item.orderId);
              const diff = item.courierAmount - item.shopifyAmount;
              const hasDiff = item.courierAmount > 0 && !item.amountMatched;
              const rowClass = isDeliveredUnpaid(item)
                ? "bc-cod-row-unpaid"
                : item.ignored
                  ? "bc-cod-row-ignored"
                  : undefined;

              return (
                <tr key={item.orderId} className={rowClass}>
                  <td>
                    {safe && !paid ? (
                      <input
                        type="checkbox"
                        checked={selected.includes(item.orderId)}
                        onChange={() => toggle(item.orderId)}
                        aria-label={`Select ${item.orderName}`}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <strong>{item.orderName}</strong>
                  </td>
                  <td>{item.tracking || "—"}</td>
                  <td>
                    <span className="bc-badge">{item.courier}</span>
                  </td>
                  <td>
                    <div>Shopify: {money(item.shopifyAmount)}</div>
                    <div>Courier: {money(item.courierAmount)}</div>
                    {hasDiff && (
                      <span
                        className="bc-badge bad"
                        style={{ marginTop: "3px", display: "inline-block" }}
                      >
                        {diff > 0
                          ? `+${money(diff)}`
                          : `-${money(Math.abs(diff))}`}{" "}
                        discrepancy
                      </span>
                    )}
                  </td>
                  <td>{item.courierStatus}</td>
                  <td>
                    <span
                      className={
                        item.paymentReceived
                          ? "bc-badge ok"
                          : item.ignored
                            ? "bc-badge"
                            : item.returned
                              ? "bc-badge bad"
                              : "bc-badge warn"
                      }
                    >
                      {item.paymentStatus}
                    </span>
                    {item.paymentDate && item.paymentDate !== "-" && (
                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--bc-muted)",
                          marginTop: "2px",
                        }}
                      >
                        {item.paymentDate}
                      </div>
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        item.matched && item.amountMatched
                          ? "bc-badge ok"
                          : item.matched
                            ? "bc-badge warn"
                            : "bc-badge bad"
                      }
                    >
                      {item.matched && item.amountMatched
                        ? "Matched"
                        : item.matched
                          ? "Amount differs"
                          : "Not matched"}
                    </span>
                  </td>
                  <td>
                    {paid ? (
                      <span className="bc-badge ok">Reconciled</span>
                    ) : safe ? (
                      <button
                        type="button"
                        className="bc-btn"
                        disabled={busy}
                        onClick={() => executeReconciliation([item.orderId])}
                      >
                        Reconcile
                      </button>
                    ) : (
                      <span
                        style={{ color: "var(--bc-muted)", fontSize: "12px" }}
                      >
                        Pending settlement
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
