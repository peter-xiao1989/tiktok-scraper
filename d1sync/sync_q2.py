import json,subprocess,datetime as dt,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tbla5OIYDkHkQ2GQ'  # 新建普通表 Q2数据(D1)
ads={r['game']:r for r in json.load(open('/tmp/q2_ads.json'))[0]['results']}
rev={r['game']:r['rev'] for r in json.load(open('/tmp/q2_rev.json'))[0]['results']}
ds=json.load(open('/tmp/ds_all.json'))[0]['results']; last=dt.date(*map(int,ds[-1]['stat_date'].split('-')))
remain=max((dt.date(2026,6,30)-last).days,0)
COLS=['序号','游戏名称','项目组','Q2累计消耗','Q2累计广告总收入','营收ROI','Q2手动出价消耗','Q2自动出价消耗','补贴目标','消耗差距','本季度剩余天数','剩余天每日消耗底线']
rows=[]
for i,(game,a) in enumerate(sorted(ads.items(),key=lambda x:-(x[1]['sp'] or 0)),1):
    sp=a['sp'] or 0; rv=rev.get(game,0); t=0; gap=round(t-sp,1)
    rows.append({'序号':i,'游戏名称':game,'项目组':a['grp'] or '其他','Q2累计消耗':sp,'Q2累计广告总收入':rv,'营收ROI':round(rv/sp,4) if sp else 0,'Q2手动出价消耗':a['msp'] or 0,'Q2自动出价消耗':a['asp'] or 0,'补贴目标':t,'消耗差距':gap,'本季度剩余天数':remain,'剩余天每日消耗底线':round(gap/remain,1) if remain and gap>0 else 0})
def lc(args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
allids=[];off=0
while True:
    ids=None
    for _ in range(4):
        r=lc(['+record-list','--limit','200','--offset',str(off)])
        try: dd=json.loads(r.stdout);ids=dd['data']['record_id_list'];hm=dd['data'].get('has_more');break
        except: time.sleep(1)
    if ids is None: break
    allids+=ids
    if hm and ids: off+=200
    else: break
for i in range(0,len(allids),200):
    for _ in range(3):
        rr=lc(['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
        try:
            if json.loads(rr.stdout).get('ok'): break
        except: pass
        time.sleep(0.6)
cre=0
for i in range(0,len(rows),200):
    body=json.dumps({"fields":COLS,"rows":[[c.get(k) for k in COLS] for c in rows[i:i+200]]},ensure_ascii=False)
    for _ in range(3):
        r=lc(['+record-batch-create','--json',body])
        try:
            if json.loads(r.stdout).get('ok'):cre+=len(rows[i:i+200]);break
        except: pass
        time.sleep(0.6)
print(f'Q2(新表): 删{len(allids)} 建{cre}')
