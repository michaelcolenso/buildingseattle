# Paid Gumroad dataset in git history (audit F1 / B10)

**Status:** the paid files are no longer tracked on this branch. Git history
still holds them, so they stay downloadable from GitHub until the owner acts.

## What changed in the repo

- `gumroad/buildingseattle_permits.csv` (full 38-column export) and
  `gumroad/contractors.csv` were removed from the index with
  `git rm --cached`. `.gitignore` now ignores `gumroad/*.csv` and
  `gumroad/*.zip`, except the free `gumroad/buildingseattle_sample.csv`.
- `gumroad/build_dataset.py` writes the paid CSVs and both release ZIPs to the
  gitignored `gumroad/dist/` only. The sample, `data-dictionary.md`,
  `VERSION.txt` and `CHANGELOG.md` are still regenerated in `gumroad/` and
  tracked. `tests/test_build_dataset.py` asserts both the layout and the
  ignore rules.
- `gumroad/refresh.py` stays in the public repo. It is stdlib-only code that
  pages through the public `https://buildingseattle.com/api/permits` and
  `/api/stats` endpoints, and it embeds no token, key, account ID or private
  URL. Publishing it gives away nothing the public API does not already
  serve. The Pro tier's value is the curated snapshot, the contractor file and
  the refresh guarantee, not the script.

## What the owner still has to decide (not done here)

Rewriting history is destructive and needs the owner's explicit yes. Assume
every copy that was ever public is already out; a rewrite only stops new
downloads. Pick one:

1. **Make the repo private** (GitHub Settings → General → Danger Zone →
   Change visibility). Simplest; history stays intact.
2. **Purge the files from history and force-push.** With
   [`git filter-repo`](https://github.com/newren/git-filter-repo) on a fresh
   mirror clone, after merging or rebasing open branches:

   ```bash
   git clone --mirror https://github.com/michaelcolenso/buildingseattle.git bs-purge.git
   cd bs-purge.git
   git filter-repo --invert-paths \
     --path gumroad/buildingseattle_permits.csv \
     --path gumroad/contractors.csv \
     --path buildingseattle_permits.csv \
     --path buildingseattle_full_export.jsonl \
     --path sdci_enrichment_20260705.jsonl \
     --path sdci_permit_enrichments.jsonl \
     --path sdci_detail_probe_results.jsonl
   # Optional, also covers the bulk exports on stale branches (audit B9):
   # git filter-repo --strip-blobs-bigger-than 5M
   git push --force --mirror
   ```

   Then delete stale remote branches (they keep the old blobs reachable), ask
   every collaborator to re-clone, and ask GitHub Support to purge cached
   views of the removed objects. Forks keep their own copies.
