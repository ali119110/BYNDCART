import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { CodVerificationResult } from "../services/codVerification.server";


interface VerifyPayload {
  ok: boolean;
  intent: "VERIFY";
  message?: string;
  mode?: string;
  totalPending?: number | null;
  hasNextPage?: boolean;
  nextCursor?: string | null;
  results?: CodVerificationResult[];
  relevant?: number;
}

interface MarkPayload {
  ok: boolean;
  intent: "MARK";
  message?: string;
  marked?: Array<{ orderId: string; orderName: string }>;
  failed?: Array<{ orderId: string; message: string }>;
}

function isDeliveredUnpaid(item: CodVerificationResult) {
  return !item.ignored && !item.returned && item.delivered === true && item.paymentStatus === "Payment Not Confirmed";
}

function isSafe(item: CodVerificationResult) {
  return item.delivered && item.paymentReceived && item.matched && !item.returned && !item.ignored && !item.cancelled && !item.unassigned && item.relevant;
}

function summaryAmount(item: CodVerificationResult) {
  return item.courierAmount > 0 ? item.courierAmount : item.shopifyAmount;
}

function money(value: number) {
  return `PKR ${Math.round(value).toLocaleString("en-PK")}`;
}

export function CodPaymentCheck({ taxPercent = 4, deliveryCharge = 280 }: { taxPercent?: number; deliveryCharge?: number }) {
  const verifyFetcher = useFetcher<VerifyPayload>();
  const markFetcher = useFetcher<MarkPayload>();
  const [rows, setRows] = useState<CodVerificationResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [batch, setBatch] = useState(0);
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
  const [status, setStatus] = useState("Check the first 20 fulfilled orders that Shopify still shows as unpaid.");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [paidIds, setPaidIds] = useState<string[]>([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const stopAuto = useRef(false);
  const verifyWait = useRef<((data: VerifyPayload) => void) | null>(null);
  const markWait = useRef<((data: MarkPayload) => void) | null>(null);

  useEffect(() => {
    const data = verifyFetcher.data;
    if (verifyFetcher.state !== "idle" || !data || !verifyWait.current) return;
    const resolve = verifyWait.current;
    verifyWait.current = null;
    resolve(data);
  }, [verifyFetcher.state, verifyFetcher.data]);

  useEffect(() => {
    const data = markFetcher.data;
    if (markFetcher.state !== "idle" || !data || data.intent !== "MARK" || !markWait.current) return;
    const resolve = markWait.current;
    markWait.current = null;
    resolve(data);
  }, [markFetcher.state, markFetcher.data]);

  function applyBatch(data: VerifyPayload, append: boolean) {
    const nextRows = data.results || [];
    setRows((current) => append ? [...current, ...nextRows] : nextRows);
    setCursor(data.nextCursor || null);
    setHasNext(data.hasNextPage === true);
    setBatch((current) => append ? current + 1 : 1);
    if (typeof data.totalPending === "number") setPendingTotal(data.totalPending);
    if (!append) {
      setSelected([]);
      setSearch("");
      setUnpaidOnly(false);
      setShowIgnored(false);
    }
    if (!data.ok) setError(data.message || "The courier check failed.");
    else setError("");
  }

  function submitVerify(nextCursor: string | null, mode: "replace" | "append") {
    return new Promise<VerifyPayload>((resolve, reject) => {
      if (verifyWait.current) {
        reject(new Error("A courier check is already running."));
        return;
      }
      verifyWait.current = resolve;
      verifyFetcher.submit(
        { intent: "VERIFY", cursor: nextCursor || "", mode },
        { method: "post" },
      );
    });
  }

  async function verify(append: boolean) {
    setError("");
    setStatus(append ? `Checking batch ${batch + 1}…` : "Checking the first 20 orders…");
    const data = await submitVerify(append ? cursor : null, append ? "append" : "replace");
    applyBatch(data, append);
    const loaded = append ? rows.length + (data.results?.length || 0) : data.results?.length || 0;
    setStatus(data.ok
      ? `Batch ${append ? batch + 1 : 1}: ${data.results?.length || 0} orders checked. ${loaded} loaded${pendingTotal ? ` of ${pendingTotal}` : ""}.`
      : data.message || "The courier check failed.");
    return data;
  }

  async function autoVerify() {
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
      let page = 1;
      let next = data.nextCursor || null;
      let more = data.hasNextPage === true;
      setStatus(`Batch 1 complete. ${loaded} orders loaded.`);
      while (more && next && !stopAuto.current) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (stopAuto.current) break;
        page += 1;
        setStatus(`Checking batch ${page}…`);
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
        setStatus(`Batch ${page} complete. ${loaded} orders loaded.`);
      }
      if (stopAuto.current) setStatus(`Stopped. ${loaded} orders stay on screen.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto verify stopped.");
    } finally {
      setAutoRunning(false);
      stopAuto.current = false;
    }
  }

  const totals = useMemo(() => {
    let unpaidCount = 0;
    let unpaidAmount = 0;
    let receivedCount = 0;
    let receivedAmount = 0;
    let charges = 0;
    let matched = 0;
    for (const item of rows) {
      if (item.relevant && item.matched) matched += 1;
      if (isDeliveredUnpaid(item)) {
        unpaidCount += 1;
        unpaidAmount += item.shopifyAmount;
      }
      if (item.delivered && item.paymentReceived && !item.returned && !item.ignored && !item.cancelled && !item.unassigned) {
        receivedCount += 1;
        receivedAmount += summaryAmount(item);
        charges += item.deliveryCharges || 0;
      }
    }
    return { unpaidCount, unpaidAmount, receivedCount, receivedAmount, charges, matched };
  }, [rows]);

  const visible = rows.filter((item) => {
    const shown = item.relevant || (showIgnored && item.ignored);
    if (!shown) return false;
    if (unpaidOnly && !isDeliveredUnpaid(item)) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return item.orderName.toLowerCase().includes(query) || item.tracking.toLowerCase().includes(query);
  });

  const visibleUnpaid = visible.filter(isDeliveredUnpaid).length;
  const taxRate = Math.min(100, Math.max(0, Number(taxPercent) || 0)) / 100;
  const chargeEach = Math.max(0, Number(deliveryCharge) || 0);
  const expectedTax = Math.round(totals.unpaidAmount * taxRate);
  const expectedCharges = visibleUnpaid * chargeEach;
  const expectedNet = totals.unpaidAmount - expectedTax - expectedCharges;
  const checking = verifyFetcher.state !== "idle" || autoRunning;
  const marking = markFetcher.state !== "idle";

  function toggle(orderId: string) {
    setSelected((current) => current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId]);
  }

  function selectMatched() {
    setSelected(visible.filter(isSafe).filter((item) => !paidIds.includes(item.orderId)).map((item) => item.orderId));
  }

  function submitMark(orderIds: string[]) {
    return new Promise<MarkPayload>((resolve, reject) => {
      if (markWait.current) {
        reject(new Error("Orders are already being marked paid."));
        return;
      }
      markWait.current = resolve;
      markFetcher.submit({ intent: "MARK", orderIds: orderIds.join(",") }, { method: "post" });
    });
  }

  async function mark(orderIds: string[]) {
    if (!orderIds.length) return;
    if (!window.confirm(`Mark ${orderIds.length} delivered and settled order${orderIds.length === 1 ? "" : "s"} as paid in Shopify?`)) return;
    setError("");
    let markedCount = 0;
    try {
      for (let index = 0; index < orderIds.length; index += 20) {
        const data = await submitMark(orderIds.slice(index, index + 20));
        const marked = data.marked || [];
        markedCount += marked.length;
        if (marked.length) {
          setPaidIds((current) => [...new Set([...current, ...marked.map((row) => row.orderId)])]);
          setSelected((current) => current.filter((id) => !marked.some((row) => row.orderId === id)));
        }
        if (!data.ok) {
          setError(data.message || "Shopify did not mark every order paid.");
          break;
        }
        if (index + 20 < orderIds.length) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStatus(`Marked ${markedCount} of ${orderIds.length} orders paid in Shopify.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Shopify did not mark the orders paid.");
    }
  }

  return (
    <section className="bc-card bc-stack">
      <div>
        <p className="bc-kicker">COURIER SETTLEMENT</p>
        <h2 className="bc-title">Check PostEx and Leopards before marking COD paid</h2>
        <p className="bc-muted">This reads fulfilled Shopify orders that are still unpaid, asks the courier whether the parcel was delivered and settled, and marks an order paid only after that check passes.</p>
      </div>
      <div className="bc-actions">
        <button type="button" className="bc-btn primary" disabled={checking || marking} onClick={() => verify(false)}>Check first 20</button>
        <button type="button" className="bc-btn" disabled={checking || marking || !hasNext} onClick={() => verify(true)}>Next 20</button>
        <button type="button" className="bc-btn" disabled={marking} onClick={autoVerify}>{autoRunning ? "Stop" : "Check all"}</button>
        <button type="button" className="bc-btn" disabled={checking || marking || rows.length === 0} onClick={selectMatched}>Select settled</button>
        <button type="button" className="bc-btn" disabled={checking || marking || selected.length === 0} onClick={() => mark(selected)}>Mark selected paid</button>
        <button type="button" className={`bc-btn ${unpaidOnly ? "primary" : ""}`} onClick={() => setUnpaidOnly((value) => !value)}>Delivered and unpaid</button>
        <button type="button" className={`bc-btn ${showIgnored ? "primary" : ""}`} onClick={() => setShowIgnored((value) => !value)}>Show ignored</button>
      </div>
      <label className="bc-field-label" htmlFor="cod-search">Search loaded orders
        <input id="cod-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order number or tracking number" />
      </label>
      <div className="bc-grid">
        <article className="bc-card"><p className="bc-kicker">Loaded</p><span className="bc-metric">{rows.length}{pendingTotal ? ` / ${pendingTotal}` : ""}</span></article>
        <article className="bc-card"><p className="bc-kicker">Settled</p><span className="bc-metric">{rows.length ? totals.matched : "—"}</span></article>
        <article className="bc-card"><p className="bc-kicker">Payment received</p><span className="bc-metric">{rows.length ? money(totals.receivedAmount) : "—"}</span><p className="bc-muted">{totals.receivedCount} orders</p></article>
        <article className="bc-card"><p className="bc-kicker">Unpaid delivered</p><span className="bc-metric">{rows.length ? visibleUnpaid : "—"}</span></article>
        <article className="bc-card"><p className="bc-kicker">All unpaid COD</p><span className="bc-metric">{rows.length ? money(totals.unpaidAmount) : "—"}</span><p className="bc-muted">{totals.unpaidCount} orders</p></article>
        <article className="bc-card"><p className="bc-kicker">Expected tax {taxPercent}%</p><span className="bc-metric">{rows.length ? money(expectedTax) : "—"}</span></article>
        <article className="bc-card"><p className="bc-kicker">Expected delivery</p><span className="bc-metric">{rows.length ? money(expectedCharges) : "—"}</span><p className="bc-muted">PKR {chargeEach} each</p></article>
        <article className="bc-card"><p className="bc-kicker">Expected net</p><span className="bc-metric">{rows.length ? money(expectedNet) : "—"}</span></article>
        <article className="bc-card"><p className="bc-kicker">Courier charges</p><span className="bc-metric">{rows.length ? money(totals.charges) : "—"}</span></article>
        <article className="bc-card"><p className="bc-kicker">Courier tax {taxPercent}%</p><span className="bc-metric">{rows.length ? money(Math.round(totals.receivedAmount * taxRate)) : "—"}</span></article>
      </div>
      <p className="bc-muted">{status}{batch > 0 ? ` Batch ${batch}.` : ""}</p>
      {error && <p className="bc-note bad">{error}</p>}
      <div className="bc-table-wrap">
        <table className="bc-table">
          <thead>
            <tr>
              <th>Select</th><th>Order</th><th>Tracking</th><th>Courier</th><th>Amount</th><th>Status</th><th>Payment</th><th>Match</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={9}>{rows.length === 0 ? "No orders checked yet." : "No orders match this view."}</td></tr>}
            {visible.map((item) => {
              const safe = isSafe(item);
              const paid = paidIds.includes(item.orderId);
              const rowClass = isDeliveredUnpaid(item) ? "bc-cod-row-unpaid" : item.ignored ? "bc-cod-row-ignored" : undefined;
              return (
                <tr key={item.orderId} className={rowClass}>
                  <td>{safe && !paid ? <input type="checkbox" checked={selected.includes(item.orderId)} onChange={() => toggle(item.orderId)} aria-label={`Select ${item.orderName}`} /> : "—"}</td>
                  <td>{item.orderName}</td>
                  <td>{item.tracking || "—"}</td>
                  <td>{item.courier}</td>
                  <td>Shopify {money(item.shopifyAmount)}<br />Courier {money(item.courierAmount)}{!item.amountMatched && item.courierAmount > 0 ? <><br />Amount differs</> : null}</td>
                  <td>{item.courierStatus}</td>
                  <td><span className={item.paymentReceived ? "bc-badge ok" : item.ignored ? "bc-badge" : item.returned ? "bc-badge bad" : "bc-badge warn"}>{item.paymentStatus}</span><br />{item.paymentDate}</td>
                  <td><span className={item.matched && item.amountMatched ? "bc-badge ok" : "bc-badge bad"}>{item.matched && item.amountMatched ? "Matched" : item.matched ? "Amount differs" : "Not matched"}</span></td>
                  <td>{safe && (paid ? "Paid" : <button type="button" className="bc-btn" disabled={marking || checking} onClick={() => mark([item.orderId])}>Mark paid</button>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
