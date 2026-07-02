import json,subprocess,datetime,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'
def sm(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
def chg(cur,prev): return round((cur-prev)/prev,4) if prev else None
def lc(tbl,args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',tbl,'--format','json'],capture_output=True,text=True)
def replace(tbl,cols,rows):
    allids=[];off=0
    while True:
        r=lc(tbl,['+record-list','--limit','200','--offset',str(off)]);d=json.loads(r.stdout);ids=d['data']['record_id_list'];allids+=ids
        if d['data'].get('has_more') and ids: off+=200
        else: break
    for i in range(0,len(allids),200): lc(tbl,['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
    body=json.dumps({"fields":cols,"rows":[[c.get(k) for k in cols] for c in rows]},ensure_ascii=False)
    for _ in range(3):
        r=lc(tbl,['+record-batch-create','--json',body])
        try:
            if json.loads(r.stdout).get('ok'): return True
        except: pass
        time.sleep(0.6)
    return False

tot=json.load(open('/tmp/ye_total.json'))[0]['results']
proj=json.load(open('/tmp/ye_proj.json'))[0]['results']
game=json.load(open('/tmp/ye_game.json'))[0]['results']
prodrev=json.load(open('/tmp/ye_prodrev.json'))[0]['results']
days=sorted(set(r['sd'] for r in tot)); L=days[-1]; P=days[-2] if len(days)>1 else None; W=days[-8] if len(days)>=8 else None
def d2(a,b): return round(a/b,2) if b else 0
prodNu={ (r['sd'],r['game']):(r['nu'] or 0) for r in prodrev }
prodNuDay={}
for r in prodrev: prodNuDay[r['sd']]=prodNuDay.get(r['sd'],0)+(r['nu'] or 0)

# 昨日总览(最新日1行)
tm={r['sd']:r for r in tot}
projByDay={}
for r in proj: projByDay.setdefault(r['sd'],[]).append(r)
def tot_ma(day):
    rs=projByDay.get(day,[]); msp=sum(r['msp'] or 0 for r in rs); asp=sum(r['asp'] or 0 for r in rs)
    mrn=sum((r['msp'] or 0)*(r['mroi'] or 0) for r in rs); arn=sum((r['asp'] or 0)*(r['aroi'] or 0) for r in rs)
    return msp,asp,(mrn/msp if msp else 0),(arn/asp if asp else 0)
cur=tm[L]; msp,asp,mroi,aroi=tot_ma(L)
COLT=['日期','消耗','收入','广告首日ROI','累计ROI','活跃度','活跃度平均成本','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI','新增用户','消耗环比','收入环比','消耗环比上周同天','收入环比上周同天','收入状态','是否昨日']
rowT=[{'日期':sm(L),'消耗':cur['sp'],'收入':cur['rev'],'广告首日ROI':cur['adroi'],'累计ROI':cur['croi'],'活跃度':cur['nu'],
'活跃度平均成本':d2(cur['sp'],cur['nu']),'手动出价消耗':round(msp,1),'手动出价ROI':round(mroi,4),'自动出价消耗':round(asp,1),'自动出价ROI':round(aroi,4),
'新增用户':prodNuDay.get(L,0),'消耗环比':chg(cur['sp'],tm[P]['sp']) if P else None,'收入环比':chg(cur['rev'],tm[P]['rev']) if P else None,
'消耗环比上周同天':chg(cur['sp'],tm[W]['sp']) if W else None,'收入环比上周同天':chg(cur['rev'],tm[W]['rev']) if W else None,
'收入状态':'待结算' if cur['pending'] else '已结算','是否昨日':'是'}]
print('昨日总览:', replace('tblRlqUxiXkMd70k',COLT,rowT))

# 昨日项目(最新日 per group)
pm={(r['sd'],r['grp']):r for r in proj}
COLP=['项目组','日期','消耗','收入','广告首日ROI','累计ROI','活跃度','活跃度平均成本','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI','消耗环比','是否昨日']
rowP=[]
for r in [x for x in proj if x['sd']==L]:
    pr=pm.get((P,r['grp'])) if P else None
    rowP.append({'项目组':r['grp'],'日期':sm(L),'消耗':r['sp'],'收入':r['rev'],'广告首日ROI':r['adroi'],'累计ROI':r['croi'],
    '活跃度':r['nu'],'活跃度平均成本':d2(r['sp'],r['nu']),'手动出价消耗':r['msp'],'手动出价ROI':r['mroi'],'自动出价消耗':r['asp'],'自动出价ROI':r['aroi'],
    '消耗环比':chg(r['sp'],pr['sp']) if pr else None,'是否昨日':'是'})
print('昨日项目:', replace('tblYs9A7GV69x8yr',COLP,rowP))

# 昨日包体(最新日 per game)
gm={(r['sd'],r['game']):r for r in game}
COLG=['游戏名称','项目组','日期','消耗','收入','广告首日ROI','广告新增','广告新增成本','活跃度','活跃度平均成本','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI','消耗环比','是否昨日']
rowG=[]
for r in [x for x in game if x['sd']==L]:
    pr=gm.get((P,r['game'])) if P else None; fl=r['fl'] or 0
    rowG.append({'游戏名称':r['game'],'项目组':r['grp'] or '其他','日期':sm(L),'消耗':r['sp'],'收入':prodrev and next((p['rev'] for p in prodrev if p['sd']==L and p['game']==r['game']),0),
    '广告首日ROI':r['roas'],'广告新增':round(fl),'广告新增成本':d2(r['sp'],fl),'活跃度':round(fl),'活跃度平均成本':d2(r['sp'],fl),
    '手动出价消耗':r['msp'],'手动出价ROI':r['mroi'],'自动出价消耗':r['asp'],'自动出价ROI':r['aroi'],'消耗环比':chg(r['sp'],pr['sp']) if pr else None,'是否昨日':'是'})
print('昨日包体:', replace('tblER3t7OCp2Za7i',COLG,rowG))
