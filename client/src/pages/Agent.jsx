import { useEffect, useMemo, useRef, useState } from "react";
import api from "../api";

/* ----------------------------- helpers ---------------------------------- */
function euro(n) {
  const v = Number(n || 0);
  return `€${v.toFixed(2)}`;
}
function roleForAmount(total) {
  if (total <= 99) return "team_lead";
  if (total <= 199) return "division_manager";
  return "sales_director";
}
async function fetchPdf(id) {
  return api.get(`/requests/${id}/pdf`, { responseType: "arraybuffer" });
}
function openBlob(data, filename, download = false, mime = "application/pdf") {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ================================ COMPONENT ============================= */
export default function Agent() {
  const [meta, setMeta] = useState(null);

  // buyer
  const [buyerCode, setBuyerCode] = useState("");
  const [buyerId, setBuyerId] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [siteId, setSiteId] = useState("");

  // item entry
  const [query, setQuery] = useState("");
  const [pickedArticle, setPickedArticle] = useState(null);
  const [qty, setQty] = useState(1);
  const [discount, setDiscount] = useState(0);

  // items table
  const [items, setItems] = useState([]);

  // other
  const [invoiceRef, setInvoiceRef] = useState("");
  const [reason, setReason] = useState("");

  // photos (multi)
  const [photos, setPhotos] = useState([]); // File[]
  const [photoErr, setPhotoErr] = useState("");

  // camera-only capture
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [cameraErr, setCameraErr] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const streamRef = useRef(null);

  // ===== History state (with filters & pagination) =====
  const [history, setHistory] = useState([]);
  const [page, setPage] = useState(1);
  const per = 10;
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Filters (single date only)
  const [fltStatus, setFltStatus] = useState(""); // "", "pending", "approved", "rejected"
  const [fltLeader, setFltLeader] = useState(""); // "", "team_lead", "division_manager", "sales_director"
  const [fltDate, setFltDate] = useState(""); // YYYY-MM-DD

  const [submitting, setSubmitting] = useState(false);

  // ===== Gallery state (view all photos) =====
  const API_BASE = (api?.defaults?.baseURL || import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const [gallery, setGallery] = useState({ open: false, urls: [], idx: 0 });
  const closeGallery = () => setGallery({ open: false, urls: [], idx: 0 });

  const normalizeUrls = (arr) =>
    (arr || [])
      .map((u) => (typeof u === "string" ? u : u?.url))
      .filter(Boolean);

  const openGalleryForRow = async (row) => {
    let urls = [];

    if (Array.isArray(row.photos) && row.photos.length) {
      urls = normalizeUrls(row.photos);
    } else if (Array.isArray(row.photo_urls) && row.photo_urls.length) {
      urls = normalizeUrls(row.photo_urls);
    } else if (row.photo_count > 0) {
      try {
        const { data } = await api.get(`/requests/${row.id}/photos`);
        urls = normalizeUrls(data);
      } catch {
        urls = [];
      }
    }

    if (!urls.length) {
      alert("Kjo kërkesë nuk ka foto.");
      return;
    }
    setGallery({ open: true, urls, idx: 0 });
  };

  /* ============================== DATA LOAD ============================== */
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/meta");
        setMeta(data);
        await reloadHistory(1); // start at page 1
      } catch (e) {
        if (e?.response?.status === 401) {
          localStorage.clear();
          location.href = "/login";
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildQuery = (p = 1) => {
    const params = new URLSearchParams();
    params.set("page", String(p));
    params.set("per", String(per));
    if (fltStatus) params.set("status", fltStatus);
    if (fltLeader) params.set("leader", fltLeader);
    if (fltDate) params.set("date", fltDate);
    return params.toString();
  };

  const reloadHistory = async (p = page) => {
    const qs = buildQuery(p);
    const { data } = await api.get(`/requests/my?${qs}`);
    // API i ri kthen: { ok, rows, page, per, total, pages } — ruaj fallback nëse vjen lista direkt
    const rows = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
    setHistory(rows);
    setPage(Number(data?.page || p || 1));
    setPages(Number(data?.pages || 1));
    setTotal(Number(data?.total || rows.length || 0));
  };

  // rifresko kur ndryshojnë filtrat (vetëm këto 3)
  useEffect(() => {
    reloadHistory(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fltStatus, fltLeader, fltDate]);

  /* ============================= DERIVED LISTS =========================== */
  const buyersByCode = useMemo(() => {
    const m = new Map();
    (meta?.buyers || []).forEach((b) => m.set(b.code, b));
    return m;
  }, [meta]);

  const buyerSites = useMemo(() => {
    if (!meta || !buyerId) return [];
    return meta.sites.filter((s) => s.buyer_id === Number(buyerId));
  }, [meta, buyerId]);

  const allArticles = useMemo(() => meta?.articles ?? [], [meta]);

  // auto fill buyer
  useEffect(() => {
    if (!buyerCode) {
      setBuyerId("");
      setBuyerName("");
      setSiteId("");
      return;
    }
    const b = buyersByCode.get(buyerCode);
    if (b) {
      setBuyerId(String(b.id));
      setBuyerName(b.name);
    } else {
      setBuyerId("");
      setBuyerName("");
    }
    setSiteId("");
  }, [buyerCode, buyersByCode]);

  /* ============================ ARTICLE SEARCH =========================== */
  const searchArticles = (q) => {
    const s = (q || "").toLowerCase().trim();
    if (!s) return allArticles.slice(0, 10);
    return allArticles
      .filter((a) => a.sku.toLowerCase().includes(s) || a.name.toLowerCase().includes(s))
      .slice(0, 12);
  };
  const suggestions = useMemo(() => searchArticles(query), [query, allArticles]);
  const pickArticle = (a) => {
    setPickedArticle(a);
    setQuery(`${a.sku} — ${a.name}`);
  };

  /* ============================ LINE CALCULATIONS ======================== */
  const unitPrice = pickedArticle ? Number(pickedArticle.sell_price || 0) : 0;
  const lineTotal = (() => {
    const q = Number(qty || 0);
    const d = Number(discount || 0);
    const base = unitPrice * q;
    const res = base * (1 - d / 100);
    return Number.isFinite(res) ? res : 0;
  })();

  /* ================================ ITEMS ================================ */
  const addItem = () => {
    if (!pickedArticle) return alert("Zgjidh një artikull.");
    if (!qty || Number(qty) <= 0) return alert("Sasia > 0.");
    const row = {
      article_id: pickedArticle.id,
      sku: pickedArticle.sku,
      name: pickedArticle.name,
      price: unitPrice,
      quantity: Number(qty),
      discount: Number(discount || 0),
      line_amount: Number(lineTotal.toFixed(2)),
    };
    setItems((p) => [...p, row]);
    setQuery("");
    setPickedArticle(null);
    setQty(1);
    setDiscount(0);
  };
  const removeItem = (idx) => setItems((p) => p.filter((_, i) => i !== idx));

  const totalAmount = items.reduce((s, it) => s + Number(it.line_amount || 0), 0);
  const requiredRole = roleForAmount(totalAmount);

  /* ================================ PHOTOS =============================== */
  const removePhoto = (i) => setPhotos((p) => p.filter((_, idx) => idx !== i));

  const stopCamera = () => {
    try {
      const s = streamRef.current;
      if (s) {
        s.getTracks().forEach((t) => t.stop());
      }
    } catch {
      // ignore
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
    streamRef.current = null;
    setCameraOn(false);
  };

  const startCamera = async () => {
    setCameraErr("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraErr("Kjo pajisje/shfletues nuk e mbështet kamerën. Përdor Chrome/Edge në telefon.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
    } catch (e) {
      setCameraErr("S'u lejua aksesimi i kamerës. Kontrollo permissions dhe provo prapë.");
      console.error("CAMERA_ERR", e);
      stopCamera();
    }
  };

  useEffect(() => {
    if (!cameraOn) return;
    const v = videoRef.current;
    const s = streamRef.current;
    if (!v || !s) return;
    v.srcObject = s;
    v.play().catch(() => {
      // some browsers require user gesture; capture button will still work after play
    });
  }, [cameraOn]);

  const capturePhoto = async () => {
    setPhotoErr("");
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;

    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);

    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      setPhotoErr("Nuk u arrit të merret foto.");
      return;
    }
    if (blob.size > 5 * 1024 * 1024) {
      setPhotoErr("Foto është më e madhe se 5MB. Afrohu pak ose ul rezolucionin e kamerës.");
      return;
    }

    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `photo-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.jpg`;
    const file = new File([blob], name, { type: "image/jpeg" });
    setPhotos((p) => [...p, file]);
  };

  useEffect(() => {
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ================================= SUBMIT ============================== */
  const submit = async () => {
    if (!buyerId) return alert("Zgjedh blerësin.");
    if (!items.length) return alert("Shto të paktën një artikull.");
    if (photoErr) return alert(photoErr);

    setSubmitting(true);
    try {
      if (photos.length) {
        const fd = new FormData();
        fd.append("buyer_id", String(buyerId));
        if (siteId) fd.append("site_id", String(siteId));
        fd.append("invoice_ref", invoiceRef || "");
        fd.append("reason", reason || "");
        fd.append(
          "items",
          JSON.stringify(
            items.map((r) => ({
              article_id: r.article_id,
              quantity: r.quantity,
              discount_percent: Number(r.discount || 0),
              line_amount: r.line_amount, // legacy (server will ignore if it recalculates)
            }))
          )
        );
        photos.forEach((f) => fd.append("photos", f)); // multi
        await api.post("/requests", fd);
      } else {
        await api.post("/requests", {
          buyer_id: Number(buyerId),
          site_id: siteId ? Number(siteId) : null,
          invoice_ref: invoiceRef || null,
          reason: reason || null,
          items: items.map((r) => ({
              article_id: r.article_id,
              quantity: r.quantity,
              discount_percent: Number(r.discount || 0),
              line_amount: r.line_amount, // legacy (server will ignore if it recalculates)
            })),
        });
      }

      // reset forma
      setInvoiceRef("");
      setReason("");
      setPhotos([]);
      setItems([]);
      setQuery("");
      setPickedArticle(null);
      setQty(1);
      setDiscount(0);

      // rifresko historikun në faqen 1 me filtrat aktualë
      await reloadHistory(1);
      alert("Kërkesa u dërgua.");
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.detail || e?.message || "Gabim";
      alert("Dështoi dërgimi: " + msg);
      console.error("SUBMIT_ERR", e);
    } finally {
      setSubmitting(false);
    }
  };

  if (!meta) return null;

  /* ================================ RENDER =============================== */
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex justify-between">
          <div>
            <h1 className="text-xl font-semibold">Kërkesë Lejim Financiar</h1>
            <p className="text-xs opacity-70">
              {meta.me.first_name} {meta.me.last_name} · PDA: {meta.me.pda_number || "-"} · Divizioni:{" "}
              {meta.me.division_name || "-"}
            </p>
          </div>
          <a className="text-sm underline" href="/login" onClick={() => localStorage.clear()}>
            Dalje
          </a>
        </header>

        {/* ===== Buyer ===== */}
        <section className="bg-white p-4 rounded-2xl shadow space-y-2">
          <h2 className="font-medium">Blerësi</h2>
          <div className="grid md:grid-cols-3 gap-2">
            <input
              className="border p-2 rounded"
              placeholder="Kodi i blerësit (p.sh. 0012)"
              value={buyerCode}
              onChange={(e) => setBuyerCode(e.target.value)}
              list="buyer-codes"
            />
            <datalist id="buyer-codes">
              {meta.buyers.map((b) => (
                <option key={b.id} value={b.code}>
                  {b.name}
                </option>
              ))}
            </datalist>
            <input className="border p-2 rounded" value={buyerName} readOnly placeholder="Emri i blerësit (auto)" />
            <select className="border p-2 rounded" value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!buyerId}>
              <option value="">(pa objekt)</option>
              {buyerSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.site_code} — {s.site_name}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* ===== Items ===== */}
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Artikujt</h2>
          </div>

          <div className="grid md:grid-cols-12 gap-2 items-start relative">
            <div className="md:col-span-5 relative">
              <input
                className="border p-2 rounded w-full"
                placeholder="Kërko me SKU ose emër (p.sh. jam)"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPickedArticle(null);
                }}
              />
              {query && suggestions.length > 0 && !pickedArticle && (
                <div className="absolute z-10 bg-white border rounded mt-1 w-full max-h-56 overflow-auto">
                  {suggestions.map((s) => (
                    <div key={s.id} className="px-2 py-1 hover:bg-gray-100 cursor-pointer" onClick={() => pickArticle(s)}>
                      {s.sku} — {s.name} · {euro(s.sell_price)}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <input className="border p-2 rounded md:col-span-2 bg-gray-50" value={pickedArticle ? unitPrice : ""} readOnly placeholder="Çm. shitës" />
            <input
              className="border p-2 rounded md:col-span-2"
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value || 1)))}
              placeholder="Sasia"
            />
            <input
              className="border p-2 rounded md:col-span-1"
              type="number"
              min="0"
              max="100"
              value={discount}
              onChange={(e) => setDiscount(Math.max(0, Math.min(100, Number(e.target.value || 0))))}
              placeholder="%"
            />
            <input className="border p-2 rounded md:col-span-2 bg-gray-50" value={lineTotal ? lineTotal.toFixed(2) : ""} readOnly placeholder="Shuma rreshti (€)" />
            <div className="md:col-span-12">
              <button className="text-sm underline" onClick={addItem} disabled={!pickedArticle}>
                Shto
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="p-2">Artikulli</th>
                  <th className="p-2">Çmimi</th>
                  <th className="p-2">Sasia</th>
                  <th className="p-2">Lejimi %</th>
                  <th className="p-2">Shuma</th>
                  <th className="p-2">Veprim</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, idx) => (
                  <tr key={idx} className="odd:bg-gray-50">
                    <td className="p-2">
                      {r.sku} — {r.name}
                    </td>
                    <td className="p-2">{euro(r.price)}</td>
                    <td className="p-2">{r.quantity}</td>
                    <td className="p-2">{r.discount}</td>
                    <td className="p-2">{euro(r.line_amount)}</td>
                    <td className="p-2">
                      <button className="text-red-600" onClick={() => removeItem(idx)}>
                        Fshi
                      </button>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td className="p-2 text-gray-500" colSpan={6}>
                      Nuk ka artikuj të shtuar ende.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Invoice/Reason */}
          <div className="grid md:grid-cols-2 gap-2">
            <input className="border p-2 rounded" placeholder="Nr. ndërlidhës i faturës" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} />
            <textarea className="border p-2 rounded" rows={1} placeholder="Arsyeja (koment)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          {/* Photos */}
          <div className="space-y-2">
            <label className="text-sm block">
              Foto (opsionale, ≤ 5MB secila) — vetëm kamera (pa zgjedhje nga storage). Fotot shihen vetëm në platformë.
            </label>

            {cameraErr && <div className="text-xs text-red-600">{cameraErr}</div>}

            <div className="flex flex-wrap gap-2 items-center">
              {!cameraOn ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 border rounded px-3 py-2 bg-white"
                  onClick={startCamera}
                >
                  📷 Aktivizo kamerën
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 border rounded px-3 py-2 bg-white"
                    onClick={capturePhoto}
                  >
                    📸 Shkrepe
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 border rounded px-3 py-2 bg-white"
                    onClick={stopCamera}
                  >
                    ⛔ Ndalo kamerën
                  </button>
                </>
              )}

              {!!photos.length && <span className="text-xs text-gray-600">{photos.length} foto të shtuar</span>}
            </div>

            {cameraOn && (
              <div className="border rounded p-2 bg-gray-50 max-w-xl">
                <video ref={videoRef} className="w-full rounded" playsInline muted />
                <canvas ref={canvasRef} className="hidden" />
                <div className="text-xs text-gray-600 mt-2">Kliko “Shkrepe” për të shtuar foto. Mund të shtosh disa.</div>
              </div>
            )}

            {!!photos.length && (
              <ul className="text-xs text-gray-700 list-disc ml-5">
                {photos.map((f, i) => (
                  <li key={i}>
                    {f.name} • {(f.size / (1024 * 1024)).toFixed(2)} MB
                    <button className="ml-2 underline" onClick={() => removePhoto(i)}>
                      Fshi
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {photoErr && <div className="text-xs text-red-600">{photoErr}</div>}
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Shkon për aprovim te: <b>{requiredRole.replace("_", " ")}</b>
            </div>
            <div className="text-right font-semibold">Totali: {euro(totalAmount)}</div>
          </div>

          <button className="bg-black text-white rounded w-full py-2" onClick={submit} disabled={submitting || !items.length || !buyerId}>
            {submitting ? "Duke dërguar..." : "Dërgo Kërkesën"}
          </button>
        </section>

        {/* ===== Historiku im ===== */}
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Historiku im</h2>
          </div>

          {/* Filters: status, leader, single date */}
          <div className="grid md:grid-cols-3 gap-2">
            <select className="border p-2 rounded" value={fltStatus} onChange={(e) => setFltStatus(e.target.value)}>
              <option value="">(Status — të gjithë)</option>
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </select>

            <select className="border p-2 rounded" value={fltLeader} onChange={(e) => setFltLeader(e.target.value)}>
              <option value="">(Leader — të gjithë)</option>
              <option value="team_lead">team_lead</option>
              <option value="division_manager">division_manager</option>
              <option value="sales_director">sales_director</option>
            </select>

            <input type="date" className="border p-2 rounded" value={fltDate} onChange={(e) => setFltDate(e.target.value)} />
          </div>

          <div className="flex gap-2">
            <button
              className="text-sm underline"
              onClick={() => {
                setFltStatus("");
                setFltLeader("");
                setFltDate("");
              }}
            >
              Pastro filtrat
            </button>
            <div className="text-sm text-gray-600">{total ? `Gjithsej: ${total}` : ""}</div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="p-2">ID</th>
                  <th className="p-2">Blerësi</th>
                  <th className="p-2">Objekti</th>
                  <th className="p-2">Artikulli/Items</th>
                  <th className="p-2">Shuma</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Kërkohet nga</th>
                  <th className="p-2">Dokumente</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => {
                  const count =
                    (Array.isArray(r.photos) && r.photos.length) ||
                    (Array.isArray(r.photo_urls) && r.photo_urls.length) ||
                    r.photo_count ||
                    0;
                  return (
                    <tr key={r.id} className="odd:bg-gray-50">
                      <td className="p-2">{r.id}</td>
                      <td className="p-2">
                        {r.buyer_code} {r.buyer_name}
                      </td>
                      <td className="p-2">{r.site_name || "-"}</td>
                      <td className="p-2">
                        {r.items && r.items.length
                          ? r.items.map((it) => `${it.sku} x${it.quantity}`).join(", ")
                          : r.article_summary || "-"}
                      </td>
                      <td className="p-2">{euro(Number(r.amount))}</td>
                      <td className="p-2">{r.status}</td>
                      <td className="p-2">{r.required_role}</td>
                      <td className="p-2 space-x-3 whitespace-nowrap">
                        <button
                          className="underline"
                          onClick={async () => {
                            const { data } = await fetchPdf(r.id);
                            openBlob(data, `kerkes-${r.id}.pdf`, false);
                          }}
                        >
                          Shiko PDF
                        </button>
                        <button
                          className="underline"
                          onClick={async () => {
                            const { data } = await fetchPdf(r.id);
                            openBlob(data, `kerkes-${r.id}.pdf`, true);
                          }}
                        >
                          Shkarko
                        </button>
                        {count ? (
                          <button className="underline" onClick={() => openGalleryForRow(r)} title="Shiko fotot">
                            Foto ({count})
                          </button>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!history.length && (
                  <tr>
                    <td className="p-2 text-gray-500" colSpan={8}>
                      S’ka rezultate për këto filtra.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between pt-3">
            <div className="text-sm text-gray-600">
              Faqja {page} nga {pages}
            </div>
            <div className="flex gap-2">
              <button
                className="border px-3 py-1 rounded disabled:opacity-50"
                onClick={() => {
                  const p = Math.max(1, page - 1);
                  setPage(p);
                  reloadHistory(p);
                }}
                disabled={page <= 1}
              >
                ‹ Prev
              </button>
              <button
                className="border px-3 py-1 rounded disabled:opacity-50"
                onClick={() => {
                  const p = Math.min(pages, page + 1);
                  setPage(p);
                  reloadHistory(p);
                }}
                disabled={page >= pages}
              >
                Next ›
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------------------- GALLERY MODAL --------------------------- */}
      {gallery.open && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center">
          <button className="absolute top-4 right-4 text-white text-xl" onClick={closeGallery} aria-label="Mbyll">
            ?
          </button>

          <div className="flex items-center gap-4 px-4 w-full justify-center">
            <button
              className="text-white text-3xl disabled:opacity-30"
              onClick={() => setGallery((s) => ({ ...s, idx: Math.max(0, s.idx - 1) }))}
              disabled={gallery.idx === 0}
              aria-label="Prev"
            >
              ‹
            </button>

            <img src={`${API_BASE}${gallery.urls[gallery.idx]}`} alt="" className="max-h-[90vh] max-w-[90vw] rounded" />

            <button
              className="text-white text-3xl disabled:opacity-30"
              onClick={() => setGallery((s) => ({ ...s, idx: Math.min(s.urls.length - 1, s.idx + 1) }))}
              disabled={gallery.idx === gallery.urls.length - 1}
              aria-label="Next"
            >
              ›
            </button>
          </div>

          <div className="absolute bottom-6 left-0 right-0 text-center text-white">
            {gallery.idx + 1} / {gallery.urls.length}
          </div>
        </div>
      )}
    </div>
  );
}
