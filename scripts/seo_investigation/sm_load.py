import re,glob,csv,sys,os
S=sys.argv[1]
rows=[]
for f in sorted(glob.glob(S+'/sm/*.xml')):
    t=open(f).read()
    for loc,lm in re.findall(r'<loc>([^<]+)</loc>\s*(?:<lastmod>([^<]*)</lastmod>)?',t):
        p=re.sub(r'^https?://[^/]+','',loc)
        rows.append((p,lm,os.path.basename(f)))
w=csv.writer(open(S+'/sitemap_urls.csv','w'));w.writerow(['p','lastmod','sm']);w.writerows(rows)
print(len(rows),len(set(r[0] for r in rows)))
