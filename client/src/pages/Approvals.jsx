import { useEffect, useMemo, useState } from "react";
import api from "../api";

const PER = 10;

function euro(n) {
  const v = Number(n || 0);
  return `€${v.toFixed(2)}`;
}

async function fetchPdf(id) {
  return api.get(`/requests/${id}/pdf`, { responseType: "arraybuffer" });
}

async function fetchPhotos(id) {
  return api.get(`/requests/${id}/photos`);
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

function paginate(list, page, per) {
  const p = Math.max(1, Number(page || 1));
  const start = (p - 1) * per;
  return list.slice(start, start + per);
}

function pagesOf(total, per) {
  return Math.max(1, Math.ceil((total || 0) / per));
}

function normalizeUrls(val) {
  if (!val) return [];
  if (typeof val === "string") {
    try {
      const j = JSON.parse(val);
      return normalizeUrls(j);
    } catch {
      return [];
    }
  }
  if (Array.isArray(val)) return val.map((x) => (typeof x === "string" ? x : x?.url)).filter(Boolean);
  if (typeof val === "object") {
    if (Array.isArray(val.urls)) return normalizeUrls(val.urls);
    if (Array.isArray(val.photos)) return normalizeUrls(val.photos);
  }
  return [];
}

export default function Approvals() {
  const role = (localStorage.getItem("role") || "").trim();

  const showTeamleadHistory = role === "division_manager";
  const showAllHistory = role === "sales_director";

  const API_BASE = (api?.defaults?.baseURL || import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const absUrl = (u) => {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (!API_BASE) return u;
    return `${API_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
  };

  const [tab, setTab] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [pending, setPending] = useState([]);
  const [myHistory, setMyHistory] = useState([]);
  const [teamleadHistory, setTeamleadHistory] = useState([]);
  const [allHistory, setAllHistory] = useState([]);

  const [page, setPage] = useState({ pending: 1, my: 1, teamlead: 1, all: 1 });
  const [commentById, setCommentById] = useState({});

  const [gallery, setGallery] = useState({ open: false, urls: [], idx: 0 });
  const closeGallery = () => setGallery({ open: false, urls: [], idx: 0 });

  const tabs = useMemo(() => {
    const t = [
      { k: "pending", label: `Në pritje (${pending.length})` },
      { k: "my", label: `Historiku im (${myHistory.length})` },
    ];
    if (showTeamleadHistory) t.push({ k: "teamlead", label: `Historiku i TeamLead (${teamleadHistory.length})` });
    if (showAllHistory) t.push({ k: "all", label: `Historiku i të gjithëve (${allHistory.length})` });
    return t;
  }, [pending.length, myHistory.length, teamleadHistory.length, allHistory.length, showTeamleadHistory, showAllHistory]);

  useEffect(() => {
    if (tabs.length && !tabs.some((x) => x.k === tab)) setTab(tabs[0].k);
  }, [tabs, tab]);

  const loadAll = async () => {
    setLoading(true);
    setErr("");
    try {
      const reqs = [api.get("/approvals/pending"), api.get("/approvals/my-history")];
      if (showTeamleadHistory) reqs.push(api.get("/approvals/teamlead-history"));
      if (showAllHistory) reqs.push(api.get("/approvals/all-history"));

      const res = await Promise.all(reqs);

      setPending(Array.isArray(res[0].data) ? res[0].data : []);
      setMyHistory(Array.isArray(res[1].data) ? res[1].data : []);

      let idx = 2;
      if (showTeamleadHistory) {
        setTeamleadHistory(Array.isArray(res[idx].data) ? res[idx].data : []);
        idx += 1;
      } else {
        setTeamleadHistory([]);
      }

      if (showAllHistory) {
        setAllHistory(Array.isArray(res[idx].data) ? res[idx].data : []);
      } else {
        setAllHistory([]);
      }
    } catch (e) {
      const st = e?.response?.status;
      if (st === 401) {
        localStorage.clear();
        location.href = "/login";
        return;
      }
      setErr(e?.response?.data?.error || e?.message || "Gabim gjatë ngarkimit.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const current = useMemo(() => {
    if (tab === "pending") return pending;
    if (tab === "my") return myHistory;
    if (tab === "teamlead") return teamleadHistory;
    return allHistory;
  }, [tab, pending, myHistory, teamleadHistory, allHistory]);

  const curPage = page[tab] || 1;
  const totalPages = pagesOf(current.length, PER);
  const pageRows = useMemo(() => paginate(current, curPage, PER), [current, curPage]);

  const setCurPage = (p) => setPage((s) => ({ ...s, [tab]: Math.max(1, Math.min(totalPages, p)) }));

  const viewPdf = async (id) => {
    const { data } = await fetchPdf(id);
    openBlob(data, `kerkes-${id}.pdf`, false);
  };

  const act = async (id, action) => {
    try {
      await api.post("/approvals/act", { id, action, comment: commentById[id] || "" });
      setCommentById((s) => {
        const n = { ...s };
        delete n[id];
        return n;
      });
      await loadAll();
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || "Gabim gjatë veprimit.";
      alert(msg);
    }
  };

  const openGalleryForRow = async (row) => {
    const id = row?.id;
    let urls = normalizeUrls(row?.photos).map(absUrl);

    if (!urls.length && id) {
      try {
        const r = await fetchPhotos(id);
        urls = normalizeUrls(r.data).map(absUrl);
      } catch {}
    }

    if (!urls.length) return alert("Kjo kërkesë nuk ka foto.");
    setGallery({ open: true, urls, idx: 0 });
  };

  if (loading) return <div className="p-6">Duke ngarkuar…</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Aprovime</h1>
          <a className="text-sm underline" href="/login" onClick={() => localStorage.clear()}>
            Dalje
          </a>
        </header>

        {err && <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded">{err}</div>}

        <div className="bg-white p-2 rounded-2xl shadow flex gap-2 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.k}
              className={`px-3 py-2 rounded-xl text-sm ${tab === t.k ? "bg-black text-white" : "hover:bg-gray-100"}`}
              onClick={() => setTab(t.k)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <section className="bg-white p-4 rounded-2xl shadow">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-gray-600">
              Faqja <b>{curPage}</b> / {totalPages} · {current.length} rreshta
            </div>
            <div className="flex items-center gap-2">
              <button className="px-3 py-1 rounded border" disabled={curPage <= 1} onClick={() => setCurPage(curPage - 1)}>
                Prev
              </button>
              <button className="px-3 py-1 rounded border" disabled={curPage >= totalPages} onClick={() => setCurPage(curPage + 1)}>
                Next
              </button>
            </div>
          </div>

          <div className="overflow-x-auto mt-3">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="p-2">ID</th>
                  <th className="p-2">Data</th>
                  <th className="p-2">Agjent</th>
                  <th className="p-2">Blerësi</th>
                  <th className="p-2">Objekti</th>
                  <th className="p-2">Totali</th>
                  <th className="p-2">Foto</th>
                  <th className="p-2">Veprime</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const id = r.id;
                  const created = r.created_at || r.acted_at;
                  const agent = r.agent_first ? `${r.agent_first} ${r.agent_last || ""}`.trim() : `${r.first_name || ""} ${r.last_name || ""}`.trim();
                  const buyer = r.buyer_code ? `${r.buyer_code} ${r.buyer_name || ""}`.trim() : `${r.buyer_code || ""}`;
                  const site = r.site_name || "-";
                  const photoCount = Number.isFinite(Number(r.photo_count))
                    ? Number(r.photo_count)
                    : normalizeUrls(r.photos).length;

                  return (
                    <tr key={`${tab}-${id}-${created || ""}`} className="odd:bg-gray-50 align-top">
                      <td className="p-2 font-medium">#{id}</td>
                      <td className="p-2">{created ? new Date(created).toLocaleString() : "-"}</td>
                      <td className="p-2">{agent || "-"}</td>
                      <td className="p-2">{buyer || "-"}</td>
                      <td className="p-2">{site}</td>
                      <td className="p-2">{euro(r.amount)}</td>

                      <td className="p-2">
                        <button className="underline" onClick={() => openGalleryForRow(r)}>
                          Shiko ({photoCount})
                        </button>
                      </td>

                      <td className="p-2 space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <button className="px-3 py-1 rounded border" onClick={() => viewPdf(id)}>
                            PDF
                          </button>

                          {tab === "pending" ? (
                            <>
                              <button className="px-3 py-1 rounded bg-black text-white" onClick={() => act(id, "approved")}>
                                Aprovo
                              </button>
                              <button className="px-3 py-1 rounded border" onClick={() => act(id, "rejected")}>
                                Refuzo
                              </button>
                            </>
                          ) : null}
                        </div>

                        {tab === "pending" ? (
                          <textarea
                            className="border p-2 rounded w-72 max-w-full"
                            rows={2}
                            placeholder="Koment (opsional)"
                            value={commentById[id] || ""}
                            onChange={(e) => setCommentById((s) => ({ ...s, [id]: e.target.value }))}
                          />
                        ) : (
                          <div className="text-xs text-gray-600">
                            {r.approver_first ? `Aprovues: ${r.approver_first} ${r.approver_last || ""}`.trim() : ""}
                            {r.approver_role ? ` · Roli: ${r.approver_role}` : ""}
                            {r.action ? ` · Veprimi: ${r.action}` : ""}
                            {r.comment ? ` · ${r.comment}` : ""}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {gallery.open && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4" onClick={closeGallery}>
            <div className="bg-white rounded-2xl p-3 max-w-5xl w-full max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  Foto {gallery.idx + 1} / {gallery.urls.length}
                </div>
                <button className="px-3 py-1 rounded border" onClick={closeGallery}>
                  Mbyll
                </button>
              </div>

              <div className="mt-3 grid grid-cols-[auto,1fr,auto] items-center gap-2">
                <button
                  className="px-3 py-1 rounded border"
                  disabled={gallery.idx <= 0}
                  onClick={() => setGallery((g) => ({ ...g, idx: Math.max(0, g.idx - 1) }))}
                >
                  Prev
                </button>

                <div className="h-[75vh] w-full overflow-hidden rounded-xl bg-gray-50 flex items-center justify-center">
                  <img className="max-h-full max-w-full object-contain" src={gallery.urls[gallery.idx]} alt="foto" />
                </div>

                <button
                  className="px-3 py-1 rounded border"
                  disabled={gallery.idx >= gallery.urls.length - 1}
                  onClick={() => setGallery((g) => ({ ...g, idx: Math.min(g.urls.length - 1, g.idx + 1) }))}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
