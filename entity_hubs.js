// SEO hub configuration for the /contractors, /neighborhoods, /projects and
// /addresses listing pages.
//
// This object lives outside worker.js because the Workers runtime rejects any
// named export of the entry module that is not a function or an
// ExportedHandler -- exporting it from worker.js broke `wrangler dev` at
// startup.

import { countedValueSql } from "./value_counting.js";

// ---------------------------------------------------------------------------
// Indexing policy. One place decides which entity URLs are published: the page
// templates in worker.js (robots/canonical/redirect), the sitemaps, the hubs
// and the listings all read these, so a URL is never sitemapped or listed
// while its own page says noindex or redirects. tests/indexing_policy.test.js
// checks each SQL predicate against its JS twin.
// ---------------------------------------------------------------------------

// Projects with at most this many permits, all at one address that has more
// permits than the project, are a strict subset of that address page: same
// permit rows, plus a generated "Prefix at Street" name. They stay reachable
// but noindex, and are not listed.
export const PROJECT_SUBSET_NOINDEX_MAX_PERMITS = 2;

// Real (joined) permits in project `pr`. A project_permits row whose permit is
// gone must not count, or the SQL and the page (which joins permits) disagree.
const PROJECT_PERMIT_COUNT_SQL =
  "(SELECT COUNT(*) FROM project_permits mpp JOIN permits mp ON mp.id = mpp.permit_id WHERE mpp.project_id = pr.id)";

// A cluster of one permit is not a project: it repeats the record its address
// page already publishes. Nor is a cluster that holds every permit at its
// address and nothing else: its page lists exactly what the address page lists,
// and Google picks the address page as canonical over it. Nor a small strict
// subset of one address (PROJECT_SUBSET_NOINDEX_MAX_PERMITS). Only clusters
// that are none of these are listed, linked, and advertised as projects; the
// duplicates redirect to the address page or are noindex (projectPagePolicy).
// `pr` is the projects alias in every query using this.
export const MULTI_PERMIT_PROJECT_SQL =
  `(${PROJECT_PERMIT_COUNT_SQL} > 1 AND NOT (pr.address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_permits dpp JOIN permits dp ON dp.id = dpp.permit_id WHERE dpp.project_id = pr.id AND dp.address_id IS NOT pr.address_id) AND ((SELECT COUNT(*) FROM permits ap WHERE ap.address_id = pr.address_id) = ${PROJECT_PERMIT_COUNT_SQL} OR ${PROJECT_PERMIT_COUNT_SQL} <= ${PROJECT_SUBSET_NOINDEX_MAX_PERMITS})))`;

function sameId(a, b) {
  return a != null && b != null && Number(a) === Number(b);
}

// True when every permit of the project sits at the project's own address, so
// the address page lists all of them. Decides whether the address permit count
// is needed at all.
export function projectIsWithinAddress(permits, addressId) {
  return addressId != null && permits.length > 0 && permits.every((permit) => sameId(permit.address_id, addressId));
}

// The JS twin of MULTI_PERMIT_PROJECT_SQL for one project page.
//   permits: the project's permits (joined rows; dangling links already dropped)
//   addressId / addressSlug: the project's address
//   addressPermitCount: permits at that address (only read when
//     projectIsWithinAddress; null otherwise)
// Returns { action: "redirect" | "noindex" | "index", canonical: "self" | "address" }.
// Only { action: "index", canonical: "self" } is a listed, sitemapped page.
export function projectPagePolicy({ permits, addressId, addressSlug, addressPermitCount = null }) {
  const count = permits.length;
  const within = projectIsWithinAddress(permits, addressId);
  if (count <= 1) {
    if (within && addressSlug) return { action: "redirect", canonical: "address" };
    // Kept as a page (its permit is linked elsewhere), canonical to the address.
    if (addressSlug) return { action: "index", canonical: "address" };
    return { action: "noindex", canonical: "self" };
  }
  if (within) {
    if (Number(addressPermitCount) === count) {
      return addressSlug ? { action: "redirect", canonical: "address" } : { action: "noindex", canonical: "self" };
    }
    if (count <= PROJECT_SUBSET_NOINDEX_MAX_PERMITS) return { action: "noindex", canonical: "self" };
  }
  return { action: "index", canonical: "self" };
}

// An address page earns a place in the index when it says more than its one
// permit page already does. Single-permit addresses stay reachable for users
// but are noindex,follow and left out of the sitemap and the /addresses hub.
export const ADDRESS_MIN_INDEXABLE_PERMITS = 2;

// Feed rows with no street ("Seattle, WA") normalize to a city-only address
// such as /address/seattle-seattle-wa that lumps unrelated permits together.
const PLACEHOLDER_STREETS = ["", "SEATTLE", "UNKNOWN LOCATION"];

function streetOf(normalized) {
  const text = String(normalized || "").toUpperCase();
  const comma = text.indexOf(",");
  return (comma === -1 ? text : text.slice(0, comma)).trim();
}

export function isPlaceholderAddress(address) {
  const street = streetOf(address?.normalized_address || address?.display_address);
  const city = String(address?.city || "Seattle").trim().toUpperCase();
  return PLACEHOLDER_STREETS.includes(street) || street === city;
}

// SQL twin of !isPlaceholderAddress for addresses alias `alias`.
export function realAddressSql(alias = "a") {
  const normalized = `upper(COALESCE(${alias}.normalized_address, ''))`;
  const street = `trim(CASE WHEN instr(${normalized}, ',') > 0 THEN substr(${normalized}, 1, instr(${normalized}, ',') - 1) ELSE ${normalized} END)`;
  const list = PLACEHOLDER_STREETS.map((value) => `'${value}'`).join(", ");
  return `(${street} NOT IN (${list}) AND ${street} != upper(trim(COALESCE(${alias}.city, 'Seattle'))))`;
}

export function addressIsIndexable(address, permitCount) {
  return Number(permitCount) >= ADDRESS_MIN_INDEXABLE_PERMITS && !isPlaceholderAddress(address);
}

// Geocoder fallbacks, not places: "Other Seattle" and "Other" collect permits
// the neighborhood boxes could not place.
const PLACEHOLDER_NEIGHBORHOODS = ["", "other", "other seattle", "seattle", "unknown"];

export function isPlaceholderNeighborhood(name) {
  return PLACEHOLDER_NEIGHBORHOODS.includes(String(name ?? "").trim().toLowerCase());
}

// SQL twin of !isPlaceholderNeighborhood for a name expression.
export function realNeighborhoodSql(nameExpr) {
  const list = PLACEHOLDER_NEIGHBORHOODS.map((value) => `'${value}'`).join(", ");
  return `lower(trim(COALESCE(${nameExpr}, ''))) NOT IN (${list})`;
}

// people_orgs pages are published for the trade roles only. Owners and
// applicants are often private individuals, so their pages stay reachable but
// noindex and out of the sitemap.
export const INDEXABLE_ORG_ROLES = ["contractor", "architect"];

// For people_orgs alias `alias`: has a real permit in a trade role.
export function orgHasIndexableRoleSql(alias = "o") {
  const roles = INDEXABLE_ORG_ROLES.map((role) => `'${role}'`).join(", ");
  return `EXISTS (SELECT 1 FROM permit_participants rp JOIN permits rpp ON rpp.id = rp.permit_id WHERE rp.people_org_id = ${alias}.id AND rp.role IN (${roles}))`;
}

// The curated contractors row (with permits) that publishes the same company
// under another slug; the org page then points its canonical there.
export function curatedDuplicateSlugSql(alias = "o") {
  return `(SELECT dc.slug FROM contractors dc WHERE upper(trim(dc.name)) = ${alias}.normalized_name AND dc.slug != ${alias}.slug AND EXISTS (SELECT 1 FROM permits dcp WHERE dcp.contractor_id = dc.id) ORDER BY dc.id LIMIT 1)`;
}

// The people_orgs rows the sitemap publishes as their own URL: a slug the
// curated table does not own (the curated page would win the route), a
// trade-role permit, and no curated contractor with permits under the same
// name (curatedDuplicateSlugSql). Judged once per org: the twin check is a join
// on the curated names, not a scan of contractors per row. Defines the CTE
// `published_orgs (id, slug, updated_at)`.
export const PUBLISHED_ORGS_CTE = `published_orgs AS (
  SELECT o.id, o.slug, o.updated_at
  FROM people_orgs o
  LEFT JOIN (
    SELECT DISTINCT upper(trim(dc.name)) AS name_key
    FROM contractors dc
    WHERE EXISTS (SELECT 1 FROM permits dcp WHERE dcp.contractor_id = dc.id)
  ) twin ON twin.name_key = o.normalized_name
  WHERE twin.name_key IS NULL
    AND NOT EXISTS (SELECT 1 FROM contractors sc WHERE sc.slug = o.slug)
    AND ${orgHasIndexableRoleSql("o")}
)`;

// Read by renderOrgContractorPage; one row with has_role and curated_slug.
export const ORG_INDEX_POLICY_SQL = `SELECT ${orgHasIndexableRoleSql("o")} AS has_role, ${curatedDuplicateSlugSql("o")} AS curated_slug FROM people_orgs o WHERE o.id = ?`;

export const ENTITY_HUBS = {
  contractors: {
    title: "Seattle Contractors by Permit Activity",
    description: "Explore Seattle contractors ranked by public construction permit activity, project value, specialties, and active work.",
    intro: "Find contractors connected to Seattle construction permits and compare their recent public project activity.",
    itemLabel: "contractors",
    pathPrefix: "/contractor/",
    selectSql: `/* seo-hub:contractors */
      SELECT o.slug, o.name AS label, COALESCE(NULLIF(o.type_guess, 'unknown'), 'Contractor') AS detail,
             COUNT(DISTINCT pp.permit_id) AS permit_count, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM people_orgs o
      JOIN permit_participants pp ON pp.people_org_id = o.id AND pp.role = 'contractor'
      JOIN permits p ON p.id = pp.permit_id`,
    groupSql: "GROUP BY o.id, o.slug, o.name, o.type_guess",
    tiebreakSql: "o.slug",
    sortOptions: { permits: "permit_count DESC, total_value DESC", value: "total_value DESC, permit_count DESC", recent: "latest_activity DESC, permit_count DESC" },
    defaultSort: "permits",
  },
  neighborhoods: {
    title: "Seattle Neighborhood Construction Permits",
    description: "Compare Seattle neighborhoods by construction permit count, declared project value, housing activity, and current development.",
    intro: "Browse neighborhood-level construction activity and follow the properties, projects, and permits shaping Seattle.",
    itemLabel: "neighborhoods",
    pathPrefix: "/neighborhood/",
    selectSql: `/* seo-hub:neighborhoods */
      SELECT n.slug, n.name AS label, 'Seattle neighborhood' AS detail,
             COUNT(DISTINCT p.id) AS permit_count, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM neighborhoods n
      JOIN address_neighborhoods an ON an.neighborhood_id = n.id
      JOIN permits p ON p.address_id = an.address_id`,
    baseWhereSql: realNeighborhoodSql("n.name"),
    groupSql: "GROUP BY n.id, n.slug, n.name",
    tiebreakSql: "n.slug",
    sortOptions: { permits: "permit_count DESC, total_value DESC", value: "total_value DESC, permit_count DESC", recent: "latest_activity DESC, permit_count DESC" },
    defaultSort: "permits",
  },
  projects: {
    title: "Seattle Construction Projects by Permit Activity",
    description: "Explore Seattle construction projects ranked by public building permit activity and declared project value.",
    intro: "See related permits grouped into Seattle construction projects, with total value and permit activity in one place.",
    itemLabel: "projects",
    pathPrefix: "/project/",
    selectSql: `/* seo-hub:projects */
      SELECT pr.slug, pr.name AS label, COALESCE(a.display_address, 'Seattle project') AS detail,
             COUNT(DISTINCT pp.permit_id) AS permit_count, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM projects pr
      JOIN project_permits pp ON pp.project_id = pr.id
      JOIN permits p ON p.id = pp.permit_id
      LEFT JOIN addresses a ON a.id = pr.address_id`,
    groupSql: "GROUP BY pr.id, pr.slug, pr.name, a.display_address",
    baseHavingSql: MULTI_PERMIT_PROJECT_SQL,
    tiebreakSql: "pr.slug",
    sortOptions: { value: "total_value DESC, permit_count DESC", permits: "permit_count DESC, total_value DESC", recent: "latest_activity DESC, total_value DESC" },
    defaultSort: "value",
  },
  addresses: {
    title: "Seattle Properties with Construction Activity",
    description: "Discover high-activity Seattle addresses ranked by public building permit count and declared construction value.",
    intro: "Explore Seattle properties with notable permit histories, from active developments to frequently renovated buildings.",
    itemLabel: "addresses",
    pathPrefix: "/address/",
    selectSql: `/* seo-hub:addresses */
      SELECT a.slug, a.display_address AS label, 'Seattle property' AS detail,
             COUNT(DISTINCT p.id) AS permit_count, COALESCE(SUM(${countedValueSql("p")}), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM addresses a
      JOIN permits p ON p.address_id = a.id`,
    baseWhereSql: realAddressSql("a"),
    groupSql: "GROUP BY a.id, a.slug, a.display_address",
    baseHavingSql: `COUNT(DISTINCT p.id) >= ${ADDRESS_MIN_INDEXABLE_PERMITS}`,
    tiebreakSql: "a.slug",
    sortOptions: { permits: "permit_count DESC, total_value DESC", recent: "latest_activity DESC, permit_count DESC", value: "total_value DESC, permit_count DESC" },
    defaultSort: "permits",
  },
};
