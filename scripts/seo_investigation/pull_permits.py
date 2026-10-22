import json,urllib.request,concurrent.futures as cf,sys,time
S=sys.argv[1]
def pg(n):
    for a in range(4):
        try:
            r=urllib.request.urlopen(urllib.request.Request(f'https://buildingseattle.com/api/permits?per_page=100&page={n}',headers={'User-Agent':'bs-seo-probe/1.0'}),timeout=40)
            return json.load(r)['results']
        except Exception as e: time.sleep(1+a)
    return None
with cf.ThreadPoolExecutor(6) as ex: pages=list(ex.map(pg,range(1,155)))
bad=[i+1 for i,p in enumerate(pages) if p is None]; print('failed pages',bad)
rows=[r for p in pages if p for r in p]
json.dump(rows,open(S+'/permits_all.json','w')); print(len(rows),len({r['permit_number'] for r in rows}))
print(sorted(rows[0].keys()))
