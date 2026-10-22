-- Run against the Search Console bulk export: overlorded.searchconsole_buildingseattle
-- 1) per-URL aggregate (result saved as gsc_url.csv: p,i,c,pos,d0,d1,nd)
SELECT REGEXP_REPLACE(url, r'^https?://[^/]+', '') p, SUM(impressions) i, SUM(clicks) c,
  ROUND(SUM(sum_position)/NULLIF(SUM(impressions),0)+1,1) pos, MIN(data_date) d0, MAX(data_date) d1, COUNT(DISTINCT data_date) nd
FROM `overlorded.searchconsole_buildingseattle.searchdata_url_impression` GROUP BY p;
-- 2) per-URL per-week (gsc_url_week.csv: p,wk,i,c)
SELECT REGEXP_REPLACE(url, r'^https?://[^/]+', '') p, FORMAT_DATE('%m-%d', DATE_TRUNC(data_date, WEEK(MONDAY))) wk, SUM(impressions) i, SUM(clicks) c
FROM `overlorded.searchconsole_buildingseattle.searchdata_url_impression` GROUP BY p, wk;
-- 3) sibling-property control: same query over searchconsole_nobodynamed / _nursinghomegrade / _recalledrides
-- NOTE: the MCP tool caps results at 3,000 rows; split with WHERE MOD(ABS(FARM_FINGERPRINT(p)),N)=k.
-- NOTE: position = SUM(sum_position)/SUM(impressions)+1 on the URL table. The site table's sum_top_position is a different metric.
