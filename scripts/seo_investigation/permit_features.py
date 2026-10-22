"""Permit-level feature effect sizes (AUC) and the link-boundary comparison.
Inputs (in SEO_DATA, default .seo_data): permits_all.json, gsc_url.csv
Run: python3 -I permit_features.py"""
import json, os, numpy as np, pandas as pd
S = os.environ.get("SEO_DATA", ".seo_data")
p = pd.DataFrame(json.load(open(f"{S}/permits_all.json"))).sort_values("id").reset_index(drop=True)
g = pd.read_csv(f"{S}/gsc_url.csv").set_index("p")
p["A"] = ("/permits/" + p.permit_number).map(g.i).fillna(0) > 0
p["linked"] = p.address_id.notna()
p["cr"] = pd.to_datetime(p.created_at)
p["issued"] = pd.to_datetime(p.issued_date, errors="coerce")
p["applied"] = pd.to_datetime(p.applied_date, errors="coerce")

def auc(y, x):
    m = x.notna(); y = y[m]; r = x[m].rank(); n1 = y.sum(); n0 = len(y) - n1
    return (r[y].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)

f = pd.DataFrame({
    "desc_len": p.description.fillna("").str.len(), "ddesc_len": p.detailed_description.fillna("").str.len(),
    "has_contractor": p.contractor_id.notna(), "logval": np.log1p(p.value.fillna(0)),
    "has_parcel": p.parcel_number.notna(), "enriched": p.last_enriched_at.notna(),
    "age_issued": (pd.Timestamp("2026-10-19") - p.issued).dt.days, "linked": p.linked,
    "status_active": p.status.str.lower().isin(["active", "pending", "new"]),
}).astype(float)
print("permits", len(p), "with impressions", int(p.A.sum()))
print(pd.Series({c: round(auc(p.A, f[c]), 3) for c in f}).sort_values(key=lambda s: (s - .5).abs(), ascending=False).to_string())
b = p.index[p.linked].max()
for w in (250, 500, 1000):
    lo, hi = p.iloc[b - w + 1:b + 1], p.iloc[b + 1:b + 1 + w]
    print(f"boundary +/-{w}: linked {lo.A.mean():.1%} vs unlinked {hi.A.mean():.1%}")
