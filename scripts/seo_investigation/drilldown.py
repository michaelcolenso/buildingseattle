"""Per-URL Coverage drilldown analysis (Search Console 'Pages -> reason -> Export' zips).
Inputs in SEO_DATA (default .seo_data):
  dd/<any>/{Metadata.csv,Table.csv,Chart.csv}   one directory per extracted drilldown zip
  permits_all.json   (pull_permits.py)   graph_expected.json (graph_dump.mjs)   gsc_url.csv (gsc_queries.sql)
  sm_tagged.csv      (recon.py; only for neighborhood slugs)
Needs: pip install -r requirements.txt (pandas, numpy; not part of the product's uv environment).
Run: python3 -I drilldown.py

Caveat: cohort A below is "URL has >=1 impression in the 140-day export", a PROXY for indexed. It is contaminated by
currently-crawled-not-indexed URLs that fall outside the 1,000-row export cap; the script prints an estimate of that
fraction and a sensitivity of the true AUC to it (not a bound: contamination is unknown; report section 3c, "Proxy caveat").
"""
import glob, json, os, re
import numpy as np, pandas as pd

S = os.environ.get("SEO_DATA", ".seo_data")
B, TOT = {}, {}
for d in sorted(glob.glob(f"{S}/dd/*/")):
    issue = open(f"{d}/Metadata.csv").read().split("Issue,")[-1].strip()
    key = {"Excluded by ‘noindex’ tag": "noindex", "Crawled - currently not indexed": "cni", "Not found (404)": "nf404",
           "Discovered - currently not indexed": "discovered", "Alternate page with proper canonical tag": "altcanon"}.get(issue)
    if key and key not in B:
        TOT[key] = int(pd.read_csv(f"{d}/Chart.csv").iloc[-1, 1])
        t = pd.read_csv(f"{d}/Table.csv")
        t["p"] = t.URL.str.replace(r"^https?://[^/]+", "", regex=True)
        t["tpl"] = t.p.str.extract(r"^/([^/?#]*)")[0].fillna("(home)")
        t["lc"] = pd.to_datetime(t["Last crawled"], errors="coerce")
        B[key] = t

permits = pd.DataFrame(json.load(open(f"{S}/permits_all.json")))
permits["path"] = "/permits/" + permits.permit_number
permits["cr"] = pd.to_datetime(permits.created_at)
e = pd.DataFrame(json.load(open(f"{S}/graph_expected.json"))).merge(permits[["id", "cr"]], on="id")
addr = e.groupby("addr_slug").agg(n=("id", "size"), first_permit=("cr", "min")).reset_index()
addr["p"] = "/address/" + addr.addr_slug
A_OK, P_OK = set(addr.p), set("/project/" + e.proj_slug.dropna())
_pm = e.dropna(subset=["proj_slug"]).groupby("proj_slug").size()
MULTI = set("/project/" + _pm[_pm > 1].index)  # only multi-permit projects are self-canonical and sitemapped (#77)
PERM_OK = set(permits.path)
sm = pd.read_csv(f"{S}/sm_tagged.csv")
NB_OK = set(sm[sm.tpl == "neighborhood"].p)

def valid(p):
    for pre, ok in (("/address/", A_OK), ("/project/", P_OK), ("/permits/", PERM_OK), ("/neighborhood/", NB_OK)):
        if p.startswith(pre):
            return p in ok
    return None

print("== bucket composition, validity today, last-crawl months")
for k, t in B.items():
    t["valid"] = t.p.map(valid)
    g = t.groupby("tpl").agg(n=("p", "size"), valid=("valid", lambda s: int(s.fillna(False).sum())))
    print(f"\n{k}: {len(t)} listed | templates {t.tpl.value_counts().to_dict()}")
    print(" valid today by template:", g.valid.to_dict(), "| crawl months:", t.lc.dt.to_period("M").value_counts().sort_index().astype(int).to_dict())

nx = B["noindex"][B["noindex"].tpl == "address"].merge(addr, on="p", how="inner")
print("\n== noindex addresses valid today:", len(nx), "| permit already in DB at last crawl:", int((nx.first_permit <= nx.lc + pd.Timedelta(days=1)).sum()),
      "| crawled 06-19/20:", int(nx.lc.between("2026-06-19", "2026-06-20 23:59").sum()))
pp = B["nf404"][B["nf404"].tpl == "permits"].merge(permits[["path", "cr"]], left_on="p", right_on="path", how="left")
print("== 404 permits:", len(pp), "| exist now:", int(pp.cr.notna().sum()), "| DB row created BEFORE last crawl:", int((pp.cr <= pp.lc + pd.Timedelta(days=1)).sum()),
      "| DB created_at range:", pp.cr.min(), pp.cr.max())
ad = B["nf404"][B["nf404"].tpl == "address"].merge(addr, on="p", how="left")
print("== 404 addresses:", len(ad), "| valid now:", int(ad.n.notna().sum()), "| crawl months (valid):", ad[ad.n.notna()].lc.dt.to_period("M").value_counts().sort_index().astype(int).to_dict())
n404 = B["nf404"]; tot = len(n404); ok = int(n404.valid.fillna(False).sum())
print(f"== 404 bucket valid today: {ok}/{tot} = {ok/tot:.1%}")

# ---- permit cohorts: A = URL has impressions (BigQuery), B = CNI list, C = discovered list
g = pd.read_csv(f"{S}/gsc_url.csv"); A = set(g.p[g.p.str.startswith("/permits/")])
Bs = set(B["cni"][B["cni"].tpl == "permits"].p); Cs = set(B["discovered"][B["discovered"].tpl == "permits"].p)
d = permits.copy()
d["coh"] = np.where(d.path.isin(Bs) & ~d.path.isin(A), "B_cni", np.where(d.path.isin(Cs), "C_disc", np.where(d.path.isin(A) & ~d.path.isin(Bs), "A_impr", "")))
_listed = len(Bs); _ov = len(A & Bs); _rate = _ov / _listed
_unl = max(TOT["cni"] * (_listed / len(B["cni"])) - _listed, 0)
c_est = (_ov + _rate * _unl) / len(A)
print(f"\n== proxy contamination: {_ov}/{_listed} listed CNI permits have impressions ({_rate:.1%}); unlisted CNI permits ~{_unl:.0f}; "
      f"estimated share of A that is currently CNI c={c_est:.2f} (assumes the capped list is representative)")
for obs in (0.60, 0.65):  # sensitivity scenarios, not bounds
    print(f"   observed AUC {obs:.2f} -> true AUC " + ", ".join(f"{(obs - 0.5 * c) / (1 - c):.3f} at c={c:.2f}" for c in (c_est, 0.30, 0.50)))
print("\n== permit cohorts (A&B overlap, previously indexed then CNI:", len(A & Bs), "):", d.coh[d.coh != ""].value_counts().to_dict())
d = d[d.coh != ""].copy()
d["pnum"] = d.permit_number.str.extract(r"^(\d+)")[0].astype(float)
d["applied_ord"] = pd.to_datetime(d.applied_date, errors="coerce").map(lambda x: x.toordinal() if pd.notna(x) else np.nan)
d["issued_ord"] = pd.to_datetime(d.issued_date, errors="coerce").map(lambda x: x.toordinal() if pd.notna(x) else np.nan)
d["logval"] = np.log1p(d.value.fillna(0)); d["desc_len"] = d.description.fillna("").str.len(); d["ddesc_len"] = d.detailed_description.fillna("").str.len()
d["has_contractor"] = d.contractor_id.notna(); d["enriched"] = d.last_enriched_at.notna(); d["status_active"] = d.status.str.lower().isin(["active", "pending", "new"])
feat = ["pnum", "applied_ord", "issued_ord", "logval", "desc_len", "ddesc_len", "has_contractor", "enriched", "status_active"]

def auc(y, x):
    m = x.notna(); y = y[m]; x = x[m]
    if y.sum() == 0 or (~y).sum() == 0: return np.nan
    r = x.rank(); n1 = y.sum(); return (r[y].sum() - n1 * (n1 + 1) / 2) / (n1 * (len(y) - n1))

d["stratum"] = pd.qcut(d.pnum.rank(method="first"), 10, labels=False)
for c1, c0 in [("A_impr", "B_cni"), ("A_impr", "C_disc"), ("B_cni", "C_disc")]:
    s = d[d.coh.isin([c1, c0])]
    raw = {f: round(auc(s.coh == c1, s[f].astype(float)), 3) for f in feat}
    matched = {}
    for f in feat:
        num = den = 0.0
        for _, st in s.groupby("stratum"):
            x, y = st[f].astype(float), st.coh == c1
            m = x.notna(); n1, n0 = int((y & m).sum()), int((~y & m).sum())
            if n1 >= 15 and n0 >= 15:  # per-feature non-null counts, so missing values do not inflate a stratum's weight
                num += n1 * n0 * auc(y[m], x[m]); den += n1 * n0
        matched[f] = round(num / den, 3) if den else float("nan")
    print(f"\n{c1} vs {c0}\n  raw AUC:    {raw}\n  matched AUC (permit-number deciles; per feature, strata with >=15 non-null in both classes): {matched}")
print("\nmedians:", d.groupby("coh")[["pnum", "logval", "desc_len", "ddesc_len"]].median().round(1).to_dict("index"))
print("share enriched / has_contractor / status_active:", d.groupby("coh")[["enriched", "has_contractor", "status_active"]].mean().round(3).to_dict("index"))

# ---- recoverable cohort: URLs that are valid today but sit in the noindex or 404 bucket (listed URLs only)
import hashlib
rec = pd.concat([B["noindex"].assign(bucket="noindex"), B["nf404"].assign(bucket="nf404")])
_valid = rec[rec.valid.fillna(False)]
_canon = _valid.p.str.startswith("/project/") & ~_valid.p.isin(MULTI)
print(f"\n== valid-today but excluded from the recovery cohort because single-permit projects are canonicalized and not sitemapped: {int(_canon.sum())} (of {int(_valid.p.str.startswith('/project/').sum())} valid project rows)")
rec = _valid[~_canon].reset_index(drop=True)
rec["h"] = rec.p.map(lambda s: int(hashlib.sha256(("bs-recrawl-2026-10|" + s).encode()).hexdigest(), 16))
rec["stratum"] = rec.bucket + "|" + rec.tpl
rec = rec.sort_values(["stratum", "h"]); rec["rank"] = rec.groupby("stratum").cumcount()
rec["arm"] = np.where(rec["rank"] % 2 == 0, "nudge", "natural")
print("\n== recoverable cohort (valid today, in noindex/404 bucket):", len(rec), rec.arm.value_counts().to_dict())
print(pd.crosstab(rec.stratum, rec.arm).to_string())
print("last-crawl year-month by arm:\n", pd.crosstab(rec.lc.dt.to_period("M"), rec.arm).to_string())
rec[["p", "bucket", "tpl", "arm", "Last crawled"]].to_csv(f"{S}/recrawl_cohort.csv", index=False)
