import json,subprocess,datetime,time,re
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tblaO8qaOwuHrOcD'  # 包体
def serial_ms(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
def pnum(v):
    if v is None: return 0
    s=str(v).replace(',','').replace('%','').strip()
    try: return float(s)
    except: return 0
def ppct(v):
    if v is None: return 0
    s=str(v)
    return pnum(s)/100 if '%' in s else pnum(s)
ads={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/ads_game.json'))[0]['results']}
prod={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/prod_game.json'))[0]['results']}
keys=set(ads)|set(prod)
COLS=['统计周期','项目组','游戏名称','消耗','广告首日ROI','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI',
'广告总收入','活跃用户','新增用户','广告新增','广告新增成本','运营新增成本','次留','7日留存','14日留存','30日留存',
'eCPM','广告点击率','总启动次数','人均进入次数','每位用户平均时长(分)','次均游戏时长(分)','平均启动速度(秒)',
'平均首次启动速度(秒)','启动成功率','授权成功率','人均广告展示次数','人均广告次数','点击率（目标页面）']
rows=[]
for k in keys:
    sd,game=k.split('|',1); a=ads.get(k,{}); p=prod.get(k,{})
    pj=json.loads(p['pj']) if p.get('pj') else {}
    grp=(a.get('grp') or p.get('grp') or '其他')
    sp=a.get('sp') or 0; fl=a.get('fl') or 0; nu=pnum(pj.get('新增用户')) or (p.get('nu') or 0)
    rec={'统计周期':serial_ms(sd),'项目组':grp,'游戏名称':game,'消耗':sp,'广告首日ROI':a.get('roas') or 0,
    '手动出价消耗':a.get('msp') or 0,'手动出价ROI':a.get('mroi') or 0,'自动出价消耗':a.get('asp') or 0,'自动出价ROI':a.get('aroi') or 0,
    '广告总收入':pnum(pj.get('广告总收入')) or (p.get('rev') or 0),'活跃用户':pnum(pj.get('活跃用户')) or (p.get('au') or 0),'新增用户':nu,
    '广告新增':fl,'广告新增成本':round(sp/fl,2) if fl else 0,'运营新增成本':round(sp/nu,2) if nu else 0,
    '次留':ppct(pj.get('次留')),'7日留存':ppct(pj.get('七日留存')),'14日留存':ppct(pj.get('十四日留存')),'30日留存':ppct(pj.get('三十日留存')),
    'eCPM':pnum(pj.get('eCPM')),'广告点击率':ppct(pj.get('广告点击率')),'总启动次数':pnum(pj.get('总启动次数')),'人均进入次数':pnum(pj.get('人均进入次数')),
    '每位用户平均时长(分)':pnum(pj.get('每位用户平均时长_分')),'次均游戏时长(分)':pnum(pj.get('次均游戏时长_分')),
    '平均启动速度(秒)':pnum(pj.get('平均启动速度_秒')),'平均首次启动速度(秒)':pnum(pj.get('平均首次启动速度_秒')),
    '启动成功率':ppct(pj.get('启动成功率')),'授权成功率':ppct(pj.get('授权成功率')),'人均广告展示次数':pnum(pj.get('人均广告展示次数')),
    '人均广告次数':round((a.get('gross') or 0)/fl,3) if fl else 0,'点击率（目标页面）':round((a.get('clk') or 0)/(a.get('imp') or 1),4) if a.get('imp') else 0}
    rows.append(rec)
print('包体 records:',len(rows))
# clear existing records
def lc(args):
    return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
allids=[]; off=0
while True:
    r=lc(['+record-list','--limit','200','--offset',str(off)]); d=json.loads(r.stdout)
    ids=d['data']['record_id_list']; allids+=ids
    if d['data'].get('has_more') and ids: off+=200
    else: break
print('existing:',len(allids))
for i in range(0,len(allids),200):
    lc(['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
# batch create
cre=0;fail=0
for i in range(0,len(rows),200):
    chunk=rows[i:i+200]
    body=json.dumps({"fields":COLS,"rows":[[c[k] for k in COLS] for c in chunk]},ensure_ascii=False)
    ok=False
    for _ in range(3):
        r=lc(['+record-batch-create','--json',body])
        try:
            if json.loads(r.stdout).get('ok'): ok=True;break
        except: pass
        time.sleep(0.6)
    cre+=len(chunk) if ok else 0; fail+=0 if ok else len(chunk)
print(f'包体 重建: 创建{cre} 失败{fail}')
