import json,subprocess,datetime,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tblu2eicxf07xgBz'  # 投放日报-素材(近30天)
def sm(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
data=json.load(open('/tmp/ads_mat.json'))[0]['results']
def d2(a,b): return round(a/b,2) if b else 0
def d3(a,b): return round(a/b,3) if b else 0
def d4(a,b): return round(a/b,4) if b else 0
COLS=['按天','项目组','创意素材名称','消耗','广告收入 ROAS (TikTok)','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI','点击率（目标页面）','活跃度平均成本','展示量','千次展示成本 (CPM)','人均广告次数']
rows=[]
for a in data:
    sp=a['sp'] or 0; imp=a['imp'] or 0; fl=a['fl'] or 0
    rows.append({'按天':sm(a['sd']),'项目组':a['grp'] or '其他','创意素材名称':a['mat'],'消耗':sp,'广告收入 ROAS (TikTok)':a['roas'] or 0,
    '手动出价消耗':a['msp'] or 0,'手动出价ROI':a['mroi'] or 0,'自动出价消耗':a['asp'] or 0,'自动出价ROI':a['aroi'] or 0,
    '点击率（目标页面）':d4(a['clk'] or 0,imp),'活跃度平均成本':d2(sp,fl),'展示量':round(imp),'千次展示成本 (CPM)':d2(sp/imp*1000 if imp else 0,1),'人均广告次数':d3(a['gross'] or 0,fl)})
print('素材 records:',len(rows))
def lc(args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
allids=[];off=0
while True:
    ids=None
    for _ in range(4):
        r=lc(['+record-list','--limit','200','--offset',str(off)])
        try: dd=json.loads(r.stdout); ids=dd['data']['record_id_list']; hm=dd['data'].get('has_more'); break
        except: time.sleep(1)
    if ids is None: break
    allids+=ids
    if hm and ids: off+=200
    else: break
print('existing:',len(allids))
for i in range(0,len(allids),200):
    for _ in range(3):
        rr=lc(['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
        try:
            if json.loads(rr.stdout).get('ok'): break
        except: pass
        time.sleep(0.8)
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
print(f'素材 重建: 创建{cre} 失败{fail}')
