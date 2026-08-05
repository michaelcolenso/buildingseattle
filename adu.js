// ADU/DADU classification rules, shared by the Worker and the test suite.
//
// These live outside worker.js because the Workers runtime rejects any named
// export of the entry module that is not a function or an ExportedHandler --
// exporting the version number and the SQL fragments from worker.js broke
// `wrangler dev` at startup.

export const ADU_CLASSIFICATION_VERSION = 2;

export function classifyAduPermit(permit) {
  const searchText = [
    permit?.detailed_description,
    permit?.description,
    permit?.primary_property_use,
    permit?.dwelling_unit_type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!searchText) return null;

  // "adu"/"adus" only match on a word boundary so that the attached form
  // ("aadu") never satisfies the detached rules below.
  const isDadu =
    /\bdadus?(?:\s*\d+)?\b/.test(searchText) ||
    /\bdetached\b.*?\baccessory\s+dwellings?\b/.test(searchText) ||
    /\bdetached\b.*?\badus?(?:\s*\d+)?\b/.test(searchText) ||
    /\bbackyard\s+cottage\b/.test(searchText);
  if (isDadu) return "DADU";

  const isAdu =
    /\ba?adus?(?:\s*\d+)?\b/.test(searchText) ||
    /\baccessory\s+dwellings?\b/.test(searchText);
  return isAdu ? "ADU" : null;
}

// SDCI descriptions bracket and quote the ADU markers ("[DADU]", "DADU?"), so
// every non-alphanumeric separator is flattened to a space before matching.
// Tabs and newlines are flattened too: the token rules below are space-delimited
// and would otherwise miss a marker that begins a new line.
export const ADU_NORMALIZED_TEXT_SQL = `
  lower(
    replace(replace(replace(
      replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(
      COALESCE(detailed_description, '') || ' ' ||
      COALESCE(description, '') || ' ' ||
      COALESCE(primary_property_use, '') || ' ' ||
      COALESCE(dwelling_unit_type, ''),
      '#', ' '), '+', ' '), '&', ' '), ':', ' '), ';', ' '),
      '/', ' '), '-', ' '), ',', ' '), '.', ' '), '(', ' '),
      ')', ' '), '[', ' '), ']', ' '), '?', ' '), '"', ' '),
      char(9), ' '), char(10), ' '), char(13), ' ')
  )
`;

// Bare "adu"/"adus" tokens, space-delimited so that the attached form ("aadu")
// never matches -- an AADU is attached by definition and must not read as DADU.
const ADU_BARE_TOKEN_SQL = `
  instr(' ' || adu_search_text || ' ', ' adu ') > 0
  OR instr(' ' || adu_search_text || ' ', ' adus ') > 0
  OR (' ' || adu_search_text || ' ') GLOB '* adu[0-9]*'
`;

const ADU_ATTACHED_TOKEN_SQL = `
  instr(' ' || adu_search_text || ' ', ' aadu ') > 0
  OR instr(' ' || adu_search_text || ' ', ' aadus ') > 0
  OR (' ' || adu_search_text || ' ') GLOB '* aadu[0-9]*'
`;

export const ADU_DADU_SQL = `
  instr(' ' || adu_search_text || ' ', ' dadu ') > 0
  OR instr(' ' || adu_search_text || ' ', ' dadus ') > 0
  OR (' ' || adu_search_text || ' ') GLOB '* dadu[0-9]*'
  OR adu_search_text LIKE '%detached%accessory dwelling%'
  OR (' ' || adu_search_text || ' ') LIKE '%detached% adu %'
  OR (' ' || adu_search_text || ' ') LIKE '%detached% adus %'
  OR (' ' || adu_search_text || ' ') GLOB '*detached* adu[0-9]*'
  OR adu_search_text LIKE '%backyard cottage%'
`;

export const ADU_MATCH_SQL = `
  ${ADU_DADU_SQL}
  OR ${ADU_ATTACHED_TOKEN_SQL}
  OR ${ADU_BARE_TOKEN_SQL}
  OR adu_search_text LIKE '%accessory dwelling%'
`;
