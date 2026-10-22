import pandas as pd,re
S='.seo_data'
g=pd.read_csv(S+'/gsc_url.csv'); s=pd.read_csv(S+'/sitemap_urls.csv')
def tpl(p):
    m=re.match(r'^/([^/?#]*)',p); return m.group(1) or '(home)'
g['tpl']=g.p.map(tpl); s['tpl']=s.p.map(tpl)
g['in_sm']=g.p.isin(set(s.p)); s['in_gsc']=s.p.isin(set(g.p))
print('GSC urls',len(g),'in sitemap',g.in_sm.sum(), 'sitemap urls',len(s),'with any impression',s.in_gsc.sum())
t=g.groupby('tpl').agg(gsc_urls=('p','size'),in_sm=('in_sm','sum'),impr=('i','sum'),clicks=('c','sum'))
t['not_in_sm']=t.gsc_urls-t.in_sm
t['sm_urls']=s.groupby('tpl').size(); t['sm_with_impr']=s.groupby('tpl').in_gsc.sum()
t['sm_impr_rate']=(t.sm_with_impr/t.sm_urls).round(3)
print(t.fillna(0).astype({'sm_urls':int,'sm_with_impr':int}).to_string())
print('\nGSC urls NOT in sitemap, by tpl: impressions/clicks')
x=g[~g.in_sm].groupby('tpl').agg(n=('p','size'),impr=('i','sum'),clicks=('c','sum')); print(x.to_string())
g.to_csv(S+'/gsc_tagged.csv',index=False); s.to_csv(S+'/sm_tagged.csv',index=False)
