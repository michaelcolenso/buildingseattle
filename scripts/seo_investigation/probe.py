import csv,sys,re,urllib.request,urllib.error,concurrent.futures as cf,random,time
S=sys.argv[1]; inp=sys.argv[2]; out=sys.argv[3]
paths=[l.strip() for l in open(inp) if l.strip()]
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
op=urllib.request.build_opener(NoRedir)
def get(p):
    req=urllib.request.Request('https://buildingseattle.com'+p,headers={'User-Agent':'Mozilla/5.0 (compatible; bs-seo-probe/1.0)'})
    for attempt in range(3):
        try:
            try: r=op.open(req,timeout=25); code=r.status; h=r.headers; body=r.read(400000).decode('utf8','ignore')
            except urllib.error.HTTPError as e: code=e.code; h=e.headers; body=e.read(400000).decode('utf8','ignore')
            can=re.search(r'<link[^>]+rel=["\']canonical["\'][^>]*href=["\']([^"\']+)',body)
            rob=re.search(r'<meta[^>]+name=["\']robots["\'][^>]*content=["\']([^"\']+)',body)
            ti=re.search(r'<title>([^<]*)',body)
            return [p,code,h.get('Location',''),can.group(1) if can else '',rob.group(1) if rob else '',h.get('X-Robots-Tag',''),ti.group(1)[:90] if ti else '',len(body),body.count('application/ld+json')]
        except Exception as e:
            time.sleep(1+attempt)
    return [p,'ERR','','','','','',0,0]
with cf.ThreadPoolExecutor(8) as ex: res=list(ex.map(get,paths))
w=csv.writer(open(out,'w'));w.writerow(['p','status','location','canonical','robots','xrobots','title','len','ldjson']);w.writerows(res)
from collections import Counter; print(Counter(r[1] for r in res))
