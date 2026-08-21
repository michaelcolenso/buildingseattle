// SEO hub configuration for the /contractors, /neighborhoods, /projects and
// /addresses listing pages.
//
// This object lives outside worker.js because the Workers runtime rejects any
// named export of the entry module that is not a function or an
// ExportedHandler -- exporting it from worker.js broke `wrangler dev` at
// startup.

export const ENTITY_HUBS = {
  contractors: {
    title: "Seattle Contractors by Permit Activity",
    description: "Explore Seattle contractors ranked by public construction permit activity, project value, specialties, and active work.",
    intro: "Find contractors connected to Seattle construction permits and compare their recent public project activity.",
    itemLabel: "contractors",
    pathPrefix: "/contractor/",
    selectSql: `/* seo-hub:contractors */
      SELECT o.slug, o.name AS label, COALESCE(NULLIF(o.type_guess, 'unknown'), 'Contractor') AS detail,
             COUNT(DISTINCT pp.permit_id) AS permit_count, COALESCE(SUM(p.value), 0) AS total_value,
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
             COUNT(DISTINCT p.id) AS permit_count, COALESCE(SUM(p.value), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM neighborhoods n
      JOIN address_neighborhoods an ON an.neighborhood_id = n.id
      JOIN permits p ON p.address_id = an.address_id`,
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
             COUNT(DISTINCT pp.permit_id) AS permit_count, COALESCE(SUM(p.value), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM projects pr
      JOIN project_permits pp ON pp.project_id = pr.id
      JOIN permits p ON p.id = pp.permit_id
      LEFT JOIN addresses a ON a.id = pr.address_id`,
    groupSql: "GROUP BY pr.id, pr.slug, pr.name, a.display_address",
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
             COUNT(DISTINCT p.id) AS permit_count, COALESCE(SUM(p.value), 0) AS total_value,
             MAX(COALESCE(p.issued_date, p.applied_date, p.created_at)) AS latest_activity
      FROM addresses a
      JOIN permits p ON p.address_id = a.id`,
    groupSql: "GROUP BY a.id, a.slug, a.display_address",
    tiebreakSql: "a.slug",
    sortOptions: { permits: "permit_count DESC, total_value DESC", recent: "latest_activity DESC, permit_count DESC", value: "total_value DESC, permit_count DESC" },
    defaultSort: "permits",
  },
};
