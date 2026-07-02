import json,subprocess,datetime,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tbltOcIoJzVqOfP2'  # 投放日报-产品
def sm(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
ads=json.load(open('/tmp/ads_game.json'))[0]['results']
rev={r['sd']+'|'+r['game']:r['rev'] for r in json.load(open('/tmp/prod_rev.json'))[0]['results']}
COLS=['按天','项目组','游戏名称','消耗','活跃度','活跃度平均成本','人均广告次数','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI','广告收入 ROAS (TikTok)','广告总收入']
def d2(a,b): return round(a/b,2) if b else 0
def d3(a,b): return round(a/b,3) if b else 0
rows=[]
for a in ads:
    sp=a['sp'] or 0; fl=a['fl'] or 0
    rows.append({'按天':sm(a['sd']),'项目组':a['grp'] or '其他','游戏名称':a['game'],'消耗':sp,'活跃度':round(fl),
    '活跃度平均成本':d2(sp,fl),'人均广告次数':d3(a['gross'] or 0,fl),'手动出价消耗':a['msp'] or 0,'手动出价ROI':a['mroi'] or 0,
    '自动出价消耗':a['asp'] or 0,'自动出价ROI':a['aroi'] or 0,'广告收入 ROAS (TikTok)':a['roas'] or 0,'广告总收入':rev.get(a['sd']+'|'+a['game'],0)})
print('投放日报-产品 records:',len(rows))
def lc(args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
allids=[];off=0
while True:
    r=lc(['+record-list','--limit','200','--offset',str(off)]);d=json.loads(r.stdout);ids=d['data']['record_id_list'];allids+=ids
    if d['data'].get('has_more') and ids: off+=200
    else: break
print('existing:',len(allids))
for i in range(0,len(allids),200): lc(['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
cre=fail=0
for i in range(0,len(rows),200):
    chunk=rows[i:i+200];body=json.dumps({"fields":COLS,"rows":[[c[k] for k in COLS] for c in chunk]},ensure_ascii=False)
    ok=False
    for _ in range(3):
        r=lc(['+record-batch-create','--json',body])
        try:
            if json.loads(r.stdout).get('ok'):ok=True;break
        except:pass
        time.sleep(0.6)
    cre+=len(chunk) if ok else 0;fail+=0 if ok else len(chunk)
print(f'投放日报-产品 重建: 创建{cre} 失败{fail}')
