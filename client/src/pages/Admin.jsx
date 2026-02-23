import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import api from "../api";

function decodeJwt() {
  const t = localStorage.getItem("token");
  if (!t) return null;
  try {
    return JSON.parse(atob(t.split(".")[1] || ""));
  } catch {
    return null;
  }
}

function mergeMetaWithJwt(data) {
  const payload = decodeJwt();
  if (!payload) return data || {};
  const me = { ...(data?.me || {}) };
  if (!me.role && payload.role) me.role = payload.role;
  if (me.division_id == null && payload.division_id != null) me.division_id = payload.division_id;
  if (!me.id && payload.id) me.id = payload.id;
  return { ...(data || {}), me };
}

function useLocalPager(list, defaultPer = 20) {
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(defaultPer);

  const total = list?.length || 0;
  const pages = Math.max(1, Math.ceil(total / per));

  useEffect(() => {
    if (page > pages) setPage(pages);
    if (page < 1) setPage(1);
  }, [page, pages]);

  const rows = useMemo(() => {
    const p = Math.max(1, Math.min(pages, page));
    const start = (p - 1) * per;
    return (list || []).slice(start, start + per);
  }, [list, page, per, pages]);

  return { page, setPage, per, setPer, pages, total, rows };
}

function PagerControls({ pager }) {
  if (!pager || pager.total <= pager.per) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button className="px-3 py-1 rounded border" disabled={pager.page <= 1} onClick={() => pager.setPage(pager.page - 1)}>
        Prev
      </button>
      <button className="px-3 py-1 rounded border" disabled={pager.page >= pager.pages} onClick={() => pager.setPage(pager.page + 1)}>
        Next
      </button>
      <div className="text-gray-600">Page {pager.page} / {pager.pages} · Total {pager.total}</div>
      <select
        className="border rounded px-2 py-1"
        value={pager.per}
        onChange={(e) => {
          pager.setPer(Number(e.target.value));
          pager.setPage(1);
        }}
      >
        {[10, 20, 50, 100].map((n) => (
          <option key={n} value={n}>
            {n} / faqe
          </option>
        ))}
      </select>
    </div>
  );
}

function toNumOrNull(v) {
  return v === "" || v == null ? null : Number(v);
}

async function safeGet(path, fallback) {
  try {
    const { data } = await api.get(path);
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

export default function Admin() {
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState("");
  const [activeModule, setActiveModule] = useState("dashboard");
  const navigate = useNavigate();
  const location = useLocation();
  const { module } = useParams();

  const validModules = useMemo(() => new Set(["dashboard", "divisions", "articles", "buyers", "sites", "users"]), []);

  const resolveModule = (value) => {
    const normalized = (value || "").toLowerCase();
    return validModules.has(normalized) ? normalized : "dashboard";
  };

  const goToModule = (nextModule) => {
    const resolved = resolveModule(nextModule);
    setActiveModule(resolved);
    localStorage.setItem("lastAdminModule", resolved);
    navigate(resolved === "dashboard" ? "/admin" : `/admin/${resolved}`);
  };

  const [divName, setDivName] = useState("");
  const [article, setArticle] = useState({ sku: "", name: "", sell_price: "" });
  const [buyer, setBuyer] = useState({ code: "", name: "" });
  const [site, setSite] = useState({ buyer_id: "", site_code: "", site_name: "" });

  const [createUser, setCreateUser] = useState({
    first_name: "",
    last_name: "",
    email: "",
    password: "",
    role: "agent",
    division_id: "",
    pda_number: "",
    team_leader_id: "",
  });
  const [editingId, setEditingId] = useState(null);
  const [editUser, setEditUser] = useState({
    first_name: "",
    last_name: "",
    email: "",
    password: "",
    role: "agent",
    division_id: "",
    pda_number: "",
    team_leader_id: "",
  });

  const [editingDivisionId, setEditingDivisionId] = useState(null);
  const [editDivision, setEditDivision] = useState({ name: "", default_team_leader_id: "" });

  const [editingArticleId, setEditingArticleId] = useState(null);
  const [editArticle, setEditArticle] = useState({ sku: "", name: "", sell_price: "", division_id: "" });

  const [editingBuyerId, setEditingBuyerId] = useState(null);
  const [editBuyer, setEditBuyer] = useState({ code: "", name: "" });

  const [editingSiteId, setEditingSiteId] = useState(null);
  const [editSite, setEditSite] = useState({ buyer_id: "", site_code: "", site_name: "" });

  const [divisions, setDivisions] = useState([]);
  const [articles, setArticles] = useState([]);
  const [buyers, setBuyers] = useState([]);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/meta");
        setMeta(mergeMetaWithJwt(data || {}));
      } catch {
        const payload = decodeJwt();
        if (payload?.role) {
          setMeta({ me: { id: payload.id, role: payload.role, division_id: payload.division_id ?? null } });
        } else {
          setMeta(null);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const reloadAll = async () => {
    try {
      const [divs, arts, bs, ss, us] = await Promise.all([
        safeGet("/admin/divisions", []),
        safeGet("/admin/articles", []),
        safeGet("/admin/buyers", []),
        safeGet("/admin/buyer-sites", []),
        safeGet("/admin/users", []),
      ]);
      setDivisions(divs);
      setArticles(arts);
      setBuyers(bs);
      setSites(ss);
      setUsers(us);
    } catch {
      setBanner("Gabim në ngarkimin e listave.");
    }
  };

  useEffect(() => {
    if (!loading && meta?.me?.role === "admin") {
      reloadAll();
    }
  }, [loading, meta]);

  const divPager = useLocalPager(divisions, 20);
  const artPager = useLocalPager(articles, 20);
  const buyerPager = useLocalPager(buyers, 20);
  const sitePager = useLocalPager(sites, 20);
  const userPager = useLocalPager(users, 20);

  const moduleCards = [
    { key: "divisions", label: "Divizione", count: divisions.length, desc: "Menaxho divizionet dhe default TL" },
    { key: "articles", label: "Artikuj", count: articles.length, desc: "Artikujt dhe çmimet/rabatet" },
    { key: "buyers", label: "Blerës", count: buyers.length, desc: "Partnerët blerës" },
    { key: "sites", label: "Objekte", count: sites.length, desc: "Objektet sipas blerësit" },
    { key: "users", label: "Përdorues", count: users.length, desc: "Llogaritë dhe rolet" },
  ];

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const requested = module || searchParams.get("module") || localStorage.getItem("lastAdminModule") || "dashboard";
    const resolved = resolveModule(requested);
    setActiveModule(resolved);

    const canonicalPath = resolved === "dashboard" ? "/admin" : `/admin/${resolved}`;
    if ((location.pathname !== canonicalPath || searchParams.get("module")) && !module) {
      navigate(canonicalPath, { replace: true });
      return;
    }

    localStorage.setItem("lastAdminModule", resolved);
  }, [module, location.pathname, location.search, navigate]);

  const startEditDivision = (d) => {
    setEditingDivisionId(d.id);
    setEditDivision({ name: d.name || "", default_team_leader_id: d.default_team_leader_id ?? "" });
  };

  const saveDivision = async () => {
    if (!editingDivisionId) return;
    try {
      await api.put(`/admin/divisions/${editingDivisionId}`, {
        name: (editDivision.name || "").trim(),
        default_team_leader_id: toNumOrNull(editDivision.default_team_leader_id),
      });
      setEditingDivisionId(null);
      setEditDivision({ name: "", default_team_leader_id: "" });
      await reloadAll();
    } catch (e) {
      setBanner(e?.response?.data?.error || "Gabim gjatë editimit të divizionit.");
    }
  };

  const deleteDivision = async (id) => {
    if (!window.confirm("A je i sigurt që dëshiron ta fshish divizionin?")) return;
    try {
      await api.delete(`/admin/divisions/${id}`);
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Nuk mund të fshihet: divizioni është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë fshirjes së divizionit.");
    }
  };

  const startEditArticle = (a) => {
    setEditingArticleId(a.id);
    setEditArticle({ sku: a.sku || "", name: a.name || "", sell_price: a.sell_price ?? "", division_id: a.division_id ?? "" });
  };

  const saveArticle = async () => {
    if (!editingArticleId) return;
    try {
      const payload = {
        sku: (editArticle.sku || "").trim(),
        name: (editArticle.name || "").trim(),
        sell_price: editArticle.sell_price === "" ? null : Number(editArticle.sell_price),
        division_id: toNumOrNull(editArticle.division_id),
      };
      await api.put(`/admin/articles/${editingArticleId}`, payload);
      setEditingArticleId(null);
      setEditArticle({ sku: "", name: "", sell_price: "", division_id: "" });
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("SKU ekziston ose artikulli është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë editimit të artikullit.");
    }
  };

  const deleteArticle = async (id) => {
    if (!window.confirm("A je i sigurt që dëshiron ta fshish artikullin?")) return;
    try {
      await api.delete(`/admin/articles/${id}`);
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Nuk mund të fshihet: artikulli është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë fshirjes së artikullit.");
    }
  };

  const startEditBuyer = (b) => {
    setEditingBuyerId(b.id);
    setEditBuyer({ code: b.code || "", name: b.name || "" });
  };

  const saveBuyer = async () => {
    if (!editingBuyerId) return;
    try {
      await api.put(`/admin/buyers/${editingBuyerId}`, { code: (editBuyer.code || "").trim(), name: (editBuyer.name || "").trim() });
      setEditingBuyerId(null);
      setEditBuyer({ code: "", name: "" });
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Kodi i blerësit ekziston ose blerësi është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë editimit të blerësit.");
    }
  };

  const deleteBuyer = async (id) => {
    if (!window.confirm("A je i sigurt që dëshiron ta fshish blerësin?")) return;
    try {
      await api.delete(`/admin/buyers/${id}`);
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Nuk mund të fshihet: blerësi është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë fshirjes së blerësit.");
    }
  };

  const startEditSite = (s) => {
    setEditingSiteId(s.id);
    setEditSite({ buyer_id: s.buyer_id ?? "", site_code: s.site_code || "", site_name: s.site_name || "" });
  };

  const saveSite = async () => {
    if (!editingSiteId) return;
    try {
      const payload = {
        buyer_id: Number(editSite.buyer_id),
        site_code: (editSite.site_code || "").trim(),
        site_name: (editSite.site_name || "").trim(),
      };
      await api.put(`/admin/buyer-sites/${editingSiteId}`, payload);
      setEditingSiteId(null);
      setEditSite({ buyer_id: "", site_code: "", site_name: "" });
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Objekti ekziston (buyer+site_code) ose është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë editimit të objektit.");
    }
  };

  const deleteSite = async (id) => {
    if (!window.confirm("A je i sigurt që dëshiron ta fshish objektin e blerësit?")) return;
    try {
      await api.delete(`/admin/buyer-sites/${id}`);
      await reloadAll();
    } catch (e) {
      const code = e?.response?.status;
      if (code === 409) setBanner("Nuk mund të fshihet: objekti është në përdorim.");
      else setBanner(e?.response?.data?.error || "Gabim gjatë fshirjes së objektit.");
    }
  };

  if (loading) return null;

  if (!meta?.me || meta.me.role !== "admin") {
    return (
      <div className="p-6">
        <h3 className="text-lg font-semibold">Admin Panel</h3>
        <p className="text-red-600 mt-1">Kjo faqe kërkon rol <b>admin</b>. Dil dhe hyr me llogari admin.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Admin Panel</h1>
          <a className="text-sm underline" href="/login" onClick={() => localStorage.clear()}>
            Dalje
          </a>
        </header>

        {banner && <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 rounded">{banner}</div>}

        <section className="bg-white p-3 rounded-2xl shadow space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={`px-3 py-2 rounded-xl text-sm ${activeModule === "dashboard" ? "bg-black text-white" : "border hover:bg-gray-50"}`}
              onClick={() => goToModule("dashboard")}
            >
              Dashboard
            </button>
            {moduleCards.map((m) => (
              <button
                key={m.key}
                className={`px-3 py-2 rounded-xl text-sm ${activeModule === m.key ? "bg-black text-white" : "border hover:bg-gray-50"}`}
                onClick={() => goToModule(m.key)}
              >
                {m.label}
              </button>
            ))}
            <button className="ml-auto text-sm underline" onClick={reloadAll}>
              Rifresko të dhënat
            </button>
          </div>
        </section>

        {activeModule === "dashboard" && (
          <section className="grid md:grid-cols-2 xl:grid-cols-5 gap-3">
            {moduleCards.map((m) => (
              <button
                key={m.key}
                onClick={() => goToModule(m.key)}
                className="text-left bg-white p-4 rounded-2xl shadow border hover:border-black/30 transition"
              >
                <div className="text-xs uppercase tracking-wide text-gray-500">{m.label}</div>
                <div className="text-3xl font-semibold mt-1">{m.count}</div>
                <div className="text-sm text-gray-600 mt-1">{m.desc}</div>
              </button>
            ))}
          </section>
        )}

        {/* ================= Divizioni ================= */}
        {activeModule === "divisions" && (
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Divizioni</h2>
            <button className="text-sm underline" onClick={reloadAll}>
              Rifresko
            </button>
          </div>

          <div className="flex gap-2">
            <input
              className="border p-2 rounded flex-1"
              placeholder="Emri i divizionit"
              value={divName}
              onChange={(e) => setDivName(e.target.value)}
            />
            <button
              className="bg-black text-white px-3 rounded"
              onClick={async () => {
                try {
                  if (!divName.trim()) return;
                  await api.post("/admin/divisions", { name: divName.trim() });
                  setDivName("");
                  await reloadAll();
                } catch {
                  alert("Nuk u ruajt divizioni.");
                }
              }}
            >
              Ruaj
            </button>
          </div>

          <PagerControls pager={divPager} />

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="text-left">
                  <th className="p-2">ID</th>
                  <th className="p-2">Emri</th>
                  <th className="p-2">Default TL</th>
                  <th className="p-2">Veprim</th>
                </tr>
              </thead>
              <tbody>
                {divPager.rows.map((d) => (
                  <tr key={d.id} className="odd:bg-gray-50">
                    <td className="p-2">{d.id}
</td>
                    <td className="p-2">
                      {editingDivisionId === d.id ? (
                        <input
                          className="border p-2 rounded w-full"
                          value={editDivision.name}
                          onChange={(e) => setEditDivision((x) => ({ ...x, name: e.target.value }))}
                        />
                      ) : (
                        d.name
                      )}
                    </td>
                    <td className="p-2">
                      {editingDivisionId === d.id ? (
                        <select
                          className="border p-2 rounded w-full"
                          value={editDivision.default_team_leader_id ?? ""}
                          onChange={(e) =>
                            setEditDivision((x) => ({ ...x, default_team_leader_id: e.target.value }))
                          }
                        >
                          <option value="">(asnjë)</option>
                          {users
                            .filter((u) => u.role === "team_lead" && u.division_id === d.id)
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.id} - {u.first_name} {u.last_name}
                              </option>
                            ))}
                        </select>
                      ) : (
                        (() => {
                          const tl = users.find((u) => u.id === d.default_team_leader_id);
                          return tl ? `${tl.id} - ${tl.first_name} ${tl.last_name}` : "";
                        })()
                      )}
                    </td>
                    <td className="p-2">
                      {editingDivisionId === d.id ? (
                        <div className="flex gap-2">
                          <button className="text-green-700" onClick={saveDivision}>
                            Ruaj
                          </button>
                          <button className="text-gray-600" onClick={() => setEditingDivisionId(null)}>
                            Anulo
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <button className="text-blue-700" onClick={() => startEditDivision(d)}>
                            Edit
                          </button>
                          <button className="text-red-700" onClick={() => deleteDivision(d.id)}>
                            Fshi
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        )}

        {/* ================= Artikull ================= */}
        {activeModule === "articles" && (
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Artikuj</h2>
            <button className="text-sm underline" onClick={reloadAll}>
              Rifresko
            </button>
          </div>

          <div className="grid md:grid-cols-4 gap-2">
            <input className="border p-2 rounded" placeholder="SKU" value={article.sku} onChange={(e) => setArticle((a) => ({ ...a, sku: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Emri" value={article.name} onChange={(e) => setArticle((a) => ({ ...a, name: e.target.value }))} />
            <input className="border p-2 rounded" placeholder={"\u00C7mimi"} value={article.sell_price} onChange={(e) => setArticle((a) => ({ ...a, sell_price: e.target.value }))} />
            <button
              className="bg-black text-white rounded"
              onClick={async () => {
                try {
                  if (!article.sku.trim() || !article.name.trim()) return alert("Shkruaj SKU dhe Emrin.");
                  await api.post("/admin/articles", {
                    sku: article.sku.trim(),
                    name: article.name.trim(),
                    sell_price: article.sell_price === "" ? null : Number(article.sell_price),
                  });
                  setArticle({ sku: "", name: "", sell_price: "" });
                  await reloadAll();
                } catch {
                  alert("Nuk u ruajt artikulli.");
                }
              }}
            >
              Ruaj
            </button>
          </div>

          <PagerControls pager={artPager} />

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="text-left">
                  <th className="p-2">ID</th>
                  <th className="p-2">SKU</th>
                  <th className="p-2">Emri</th>
<th className="p-2">Divizioni</th>
                  <th className="p-2">{"\u00C7mimi"}</th>
                  <th className="p-2">Veprim</th>
                </tr>
              </thead>
              <tbody>
                {artPager.rows.map((a) => (
                  <tr key={a.id} className="odd:bg-gray-50">
                    <td className="p-2">{a.id}</td>
                    <td className="p-2">
                      {editingArticleId === a.id ? (
                        <input className="border p-1 rounded w-full" value={editArticle.sku} onChange={(e) => setEditArticle((x) => ({ ...x, sku: e.target.value }))} />
                      ) : (
                        a.sku
                      )}
                    </td>
                    <td className="p-2">
                      {editingArticleId === a.id ? (
                        <input className="border p-1 rounded w-full" value={editArticle.name} onChange={(e) => setEditArticle((x) => ({ ...x, name: e.target.value }))} />
                      ) : (
                        a.name
                      )}
                    </td>
<td className="p-2">
  {editingArticleId === a.id ? (
    <select
      className="border p-1 rounded w-full"
      value={editArticle.division_id ?? ""}
      onChange={(e) => setEditArticle((x) => ({ ...x, division_id: e.target.value }))}
    >
      <option value="">--</option>
      {(divisions || []).map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  ) : (
    (a.division_name ?? divisions.find((d) => d.id === a.division_id)?.name ?? "")
  )}
</td>
                    <td className="p-2">
                      {editingArticleId === a.id ? (
                        <input className="border p-1 rounded w-full" value={editArticle.sell_price} onChange={(e) => setEditArticle((x) => ({ ...x, sell_price: e.target.value }))} />
                      ) : (
                        String.fromCharCode(8364) + (a.sell_price ?? "")
                      )}
                    </td>
                    <td className="p-2">
                      {editingArticleId === a.id ? (
                        <div className="flex gap-2">
                          <button className="bg-black text-white px-3 py-1 rounded" onClick={saveArticle}>
                            Ruaj
                          </button>
                          <button
                            className="text-sm underline"
                            onClick={() => {
                              setEditingArticleId(null);
                              setEditArticle({ sku: "", name: "", sell_price: "", division_id: "" });
                            }}
                          >
                            Anulo
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <button className="text-sm underline" onClick={() => startEditArticle(a)}>
                            Edit
                          </button>
                          <button className="text-sm text-red-600 underline" onClick={() => deleteArticle(a.id)}>
                            Fshi
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        )}

        {/* ================= Blerës & Objekte ================= */}
        {(activeModule === "buyers" || activeModule === "sites") && (
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{activeModule === "buyers" ? "Blerës" : "Objekte"}</h2>
            <button className="text-sm underline" onClick={reloadAll}>
              Rifresko
            </button>
          </div>

          {activeModule === "buyers" && (
          <div className="grid md:grid-cols-3 gap-2">
            <input className="border p-2 rounded" placeholder="Kodi (p.sh. 0012)" value={buyer.code} onChange={(e) => setBuyer((b) => ({ ...b, code: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Emri" value={buyer.name} onChange={(e) => setBuyer((b) => ({ ...b, name: e.target.value }))} />
            <button
              className="bg-black text-white rounded"
              onClick={async () => {
                try {
                  if (!buyer.code.trim() || !buyer.name.trim()) return alert("Shkruaj kodin dhe emrin e blerësit.");
                  await api.post("/admin/buyers", { code: buyer.code.trim(), name: buyer.name.trim() });
                  setBuyer({ code: "", name: "" });
                  await reloadAll();
                } catch {
                  alert("Nuk u ruajt blerësi.");
                }
              }}
            >
              Ruaj Blerësin
            </button>
          </div>
          )}

          {activeModule === "sites" && (
          <div className="grid md:grid-cols-4 gap-2">
            <select className="border p-2 rounded" value={site.buyer_id} onChange={(e) => setSite((s) => ({ ...s, buyer_id: e.target.value }))}>
              <option value="">Zgjedh blerësin</option>
              {buyers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} - {b.code} {b.name}
                </option>
              ))}
            </select>
            <input className="border p-2 rounded" placeholder="Kodi i objektit (p.sh. 12)" value={site.site_code} onChange={(e) => setSite((s) => ({ ...s, site_code: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Emri i objektit" value={site.site_name} onChange={(e) => setSite((s) => ({ ...s, site_name: e.target.value }))} />
            <button
              className="bg-black text-white rounded"
              onClick={async () => {
                try {
                  if (!site.buyer_id) return alert("Zgjedh blerësin për objektin.");
                  await api.post("/admin/buyer-sites", {
                    buyer_id: Number(site.buyer_id),
                    site_code: site.site_code.trim(),
                    site_name: site.site_name.trim(),
                  });
                  setSite({ buyer_id: "", site_code: "", site_name: "" });
                  await reloadAll();
                } catch {
                  alert("Nuk u ruajt objekti.");
                }
              }}
            >
              Ruaj Objektin
            </button>
          </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            {activeModule === "buyers" && (
            <div className="overflow-x-auto">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Blerësit</h3>
                <PagerControls pager={buyerPager} />
              </div>
              <table className="min-w-full text-sm mt-2">
                <thead>
                  <tr className="text-left">
                    <th className="p-2">ID</th>
                    <th className="p-2">Kodi</th>
                    <th className="p-2">Emri</th>
                    <th className="p-2">Veprim</th>
                  </tr>
                </thead>
                <tbody>
                  {buyerPager.rows.map((b) => (
                    <tr key={b.id} className="odd:bg-gray-50">
                      <td className="p-2">{b.id}</td>
                      <td className="p-2">
                        {editingBuyerId === b.id ? (
                          <input className="border p-1 rounded w-28" value={editBuyer.code} onChange={(e) => setEditBuyer((s) => ({ ...s, code: e.target.value }))} />
                        ) : (
                          b.code
                        )}
                      </td>
                      <td className="p-2">
                        {editingBuyerId === b.id ? (
                          <input className="border p-1 rounded w-64" value={editBuyer.name} onChange={(e) => setEditBuyer((s) => ({ ...s, name: e.target.value }))} />
                        ) : (
                          b.name
                        )}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {editingBuyerId === b.id ? (
                          <div className="flex gap-2">
                            <button className="text-sm underline" onClick={saveBuyer}>
                              Ruaj
                            </button>
                            <button className="text-sm underline" onClick={() => setEditingBuyerId(null)}>
                              Anulo
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-3">
                            <button className="text-sm underline" onClick={() => startEditBuyer(b)}>
                              Edit
                            </button>
                            <button className="text-sm text-red-600 underline" onClick={() => deleteBuyer(b.id)}>
                              Fshi
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}

            {activeModule === "sites" && (
            <div className="overflow-x-auto">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Objektet</h3>
                <PagerControls pager={sitePager} />
              </div>
              <table className="min-w-full text-sm mt-2">
                <thead>
                  <tr className="text-left">
                    <th className="p-2">ID</th>
                    <th className="p-2">BuyerID</th>
                    <th className="p-2">Kodi</th>
                    <th className="p-2">Emri</th>
                    <th className="p-2">Veprim</th>
                  </tr>
                </thead>
                <tbody>
                  {sitePager.rows.map((s) => (
                    <tr key={s.id} className="odd:bg-gray-50">
                      <td className="p-2">{s.id}</td>
                      <td className="p-2">
                        {editingSiteId === s.id ? (
                          <input
                            className="border rounded px-2 py-1 w-24"
                            value={editSite.buyer_id}
                            onChange={(e) => setEditSite((v) => ({ ...v, buyer_id: e.target.value }))}
                          />
                        ) : (
                          s.buyer_id
                        )}
                      </td>
                      <td className="p-2">
                        {editingSiteId === s.id ? (
                          <input
                            className="border rounded px-2 py-1 w-28"
                            value={editSite.site_code}
                            onChange={(e) => setEditSite((v) => ({ ...v, site_code: e.target.value }))}
                          />
                        ) : (
                          s.site_code
                        )}
                      </td>
                      <td className="p-2">
                        {editingSiteId === s.id ? (
                          <input
                            className="border rounded px-2 py-1 w-64"
                            value={editSite.site_name}
                            onChange={(e) => setEditSite((v) => ({ ...v, site_name: e.target.value }))}
                          />
                        ) : (
                          s.site_name
                        )}
                      </td>
                      <td className="p-2">
                        {editingSiteId === s.id ? (
                          <div className="flex gap-3">
                            <button className="text-sm underline" onClick={saveSite}>
                              Ruaj
                            </button>
                            <button
                              className="text-sm underline"
                              onClick={() => {
                                setEditingSiteId(null);
                                setEditSite({ buyer_id: "", site_code: "", site_name: "" });
                              }}
                            >
                              Anulo
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-3">
                            <button className="text-sm underline" onClick={() => startEditSite(s)}>
                              Edit
                            </button>
                            <button className="text-sm text-red-600 underline" onClick={() => deleteSite(s.id)}>
                              Fshi
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </section>
        )}

        {/* ================= Përdorues ================= */}
        {activeModule === "users" && (
        <section className="bg-white p-4 rounded-2xl shadow space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Përdorues</h2>
            <button className="text-sm underline" onClick={reloadAll}>
              Rifresko
            </button>
          </div>

          <div className="grid md:grid-cols-8 gap-2">
            <input className="border p-2 rounded" placeholder="Emri" value={createUser.first_name} onChange={(e) => setCreateUser((u) => ({ ...u, first_name: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Mbiemri" value={createUser.last_name} onChange={(e) => setCreateUser((u) => ({ ...u, last_name: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Email" value={createUser.email} onChange={(e) => setCreateUser((u) => ({ ...u, email: e.target.value }))} />
            <input className="border p-2 rounded" placeholder="Password" type="password" value={createUser.password} onChange={(e) => setCreateUser((u) => ({ ...u, password: e.target.value }))} />
            <select className="border p-2 rounded" value={createUser.role} onChange={(e) => setCreateUser((u) => ({ ...u, role: e.target.value }))}>
              {["agent", "team_lead", "division_manager", "sales_director", "admin"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <select className="border p-2 rounded" value={createUser.division_id} onChange={(e) => setCreateUser((u) => ({ ...u, division_id: e.target.value }))}>
              <option value="">Divizioni (ops.)</option>
              {divisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id} - {d.name}
                </option>
              ))}
            </select>
            {createUser.role === "agent" ? (
              <div>
                <label className="text-sm">Team Leader</label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={createUser.team_leader_id ?? ""}
                  onChange={(e) => setCreateUser((s) => ({ ...s, team_leader_id: e.target.value }))}
                >
                  <option value="">(Auto)</option>
                  {users
                    .filter((x) => x.role === "team_lead" && x.division_id === toNumOrNull(createUser.division_id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.id} - {u.first_name} {u.last_name}
                      </option>
                    ))}
                </select>
              </div>
            ) : (
              <div />
            )}
            <button
              className="bg-black text-white rounded"
              onClick={async () => {
                try {
                  if (!createUser.email.trim() || !createUser.password.trim()) return alert("Email dhe password janë të detyrueshme.");
                  await api.post("/admin/users", {
                    first_name: createUser.first_name,
                    last_name: createUser.last_name,
                    email: createUser.email.trim(),
                    password: createUser.password,
                    role: createUser.role,
                    division_id: toNumOrNull(createUser.division_id),
                    pda_number: createUser.pda_number,
                    team_leader_id: toNumOrNull(createUser.team_leader_id),
                  });
                  setCreateUser({ first_name: "", last_name: "", email: "", password: "", role: "agent", division_id: "", pda_number: "", team_leader_id: "" });
                  await reloadAll();
                } catch (e) {
                  const msg = e?.response?.data?.error || "Gabim gjatë krijimit.";
                  alert(msg);
                }
              }}
            >
              Krijo
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="font-medium">Lista e përdoruesve</div>
            <PagerControls pager={userPager} />
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm mt-2">
              <thead>
                <tr className="text-left">
                  <th className="p-2">ID</th>
                  <th className="p-2">Emri</th>
                  <th className="p-2">Mbiemri</th>
                  <th className="p-2">Email</th>
                  <th className="p-2">Roli</th>
                  <th className="p-2">Divizioni</th>
                  <th className="p-2">Team Leader</th>
                  <th className="p-2">PDA</th>
                  <th className="p-2">Krijuar</th>
                  <th className="p-2">Veprime</th>
                </tr>
              </thead>
              <tbody>
                {userPager.rows.map((u) => {
                  const isEdit = editingId === u.id;
                  const divLabel = u.division_name || divisions.find((d) => d.id === u.division_id)?.name || "";

                  return (
                    <tr key={u.id} className="odd:bg-gray-50 align-top">
                      <td className="p-2">{u.id}</td>
                      <td className="p-2">
                        {isEdit ? <input className="border p-1 rounded w-32" value={editUser.first_name} onChange={(e) => setEditUser((s) => ({ ...s, first_name: e.target.value }))} /> : u.first_name}
                      </td>
                      <td className="p-2">
                        {isEdit ? <input className="border p-1 rounded w-32" value={editUser.last_name} onChange={(e) => setEditUser((s) => ({ ...s, last_name: e.target.value }))} /> : u.last_name}
                      </td>
                      <td className="p-2">
                        {isEdit ? <input className="border p-1 rounded w-56" value={editUser.email} onChange={(e) => setEditUser((s) => ({ ...s, email: e.target.value }))} /> : u.email}
                      </td>
                      <td className="p-2">
                        {isEdit ? (
                          <select className="border p-1 rounded" value={editUser.role} onChange={(e) => setEditUser((s) => ({ ...s, role: e.target.value }))}>
                            {["agent", "team_lead", "division_manager", "sales_director", "admin"].map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          u.role
                        )}
                      </td>
                      <td className="p-2">
                        {isEdit ? (
                          <select className="border p-1 rounded" value={editUser.division_id ?? ""} onChange={(e) => setEditUser((s) => ({ ...s, division_id: e.target.value }))}>
                            <option value="">(asnjë)</option>
                            {divisions.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.id} - {d.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          u.division_id ? `${u.division_id}${divLabel ? ` - ${divLabel}` : ""}` : ""
                        )}
                      </td>
                      
<td className="p-2">
  {isEdit && editUser.role === "agent" ? (
    <select
      className="border p-1 rounded"
      value={editUser.team_leader_id ?? ""}
      onChange={(e) => setEditUser((s) => ({ ...s, team_leader_id: e.target.value }))}
    >
      <option value="">(auto/fallback)</option>
      {users
        .filter(
          (x) =>
            x.role === "team_lead" &&
            String(x.division_id ?? "") === String(editUser.division_id ?? "")
        )
        .map((x) => (
          <option key={x.id} value={x.id}>
            {x.id} - {x.first_name} {x.last_name}
          </option>
        ))}
    </select>
  ) : (
    (() => {
      const tl = users.find((x) => x.id === u.team_leader_id);
      return tl ? `${tl.first_name} ${tl.last_name}` : "";
    })()
  )}
</td>

<td className="p-2">
                        {isEdit ? <input className="border p-1 rounded w-24" value={editUser.pda_number ?? ""} onChange={(e) => setEditUser((s) => ({ ...s, pda_number: e.target.value }))} /> : (u.pda_number ?? "")}
                      </td>
                      <td className="p-2">{u.created_at ? new Date(u.created_at).toLocaleString() : ""}</td>
                      <td className="p-2">
                        {isEdit ? (
                          <div className="space-y-2">
                            <input className="border p-1 rounded w-56" type="password" placeholder="Password i ri (ops.)" value={editUser.password} onChange={(e) => setEditUser((s) => ({ ...s, password: e.target.value }))} />
                            <div className="flex gap-2">
                              <button
                                className="px-3 py-1 rounded bg-black text-white"
                                onClick={async () => {
                                  try {
                                    const payload = {
                                      first_name: editUser.first_name,
                                      last_name: editUser.last_name,
                                      email: editUser.email,
                                      role: editUser.role,
                                      division_id: toNumOrNull(editUser.division_id),
                                      pda_number: editUser.pda_number ?? "",
                                      team_leader_id: toNumOrNull(editUser.team_leader_id),
                                    };
                                    if (editUser.password?.trim()) payload.password = editUser.password.trim();
                                    await api.put(`/admin/users/${u.id}`, payload);
                                    setEditingId(null);
                                    setEditUser({ first_name: "", last_name: "", email: "", password: "", role: "agent", division_id: "", pda_number: "", team_leader_id: "" });
                                    await reloadAll();
                                  } catch (e) {
                                    const msg = e?.response?.data?.error || "Gabim gjatë ruajtjes.";
                                    alert(msg);
                                  }
                                }}
                              >
                                Ruaj
                              </button>
                              <button
                                className="px-3 py-1 rounded border"
                                onClick={() => {
                                  setEditingId(null);
                                  setEditUser({ first_name: "", last_name: "", email: "", password: "", role: "agent", division_id: "", pda_number: "", team_leader_id: "" });
                                }}
                              >
                                Anulo
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-3">
                            <button
                              className="text-blue-600 underline"
                              onClick={() => {
                                setEditingId(u.id);
                                setEditUser({
                                  first_name: u.first_name || "",
                                  last_name: u.last_name || "",
                                  email: u.email || "",
                                  password: "",
                                  role: u.role || "agent",
                                  division_id: u.division_id ? String(u.division_id) : "",
                                  pda_number: u.pda_number ?? "",
                              team_leader_id: u.team_leader_id ?? "",
                                });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-red-600 underline"
                              onClick={async () => {
                                if (!window.confirm("Fshi këtë përdorues?")) return;
                                try {
                                  await api.delete(`/admin/users/${u.id}`);
                                  await reloadAll();
                                } catch (e) {
                                  const msg = e?.response?.data?.error || "Gabim gjatë fshirjes.";
                                  alert(msg);
                                }
                              }}
                            >
                              Fshi
                            </button>
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
        )}
      </div>
    </div>
  );
}



