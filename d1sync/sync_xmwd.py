import json,subprocess,datetime,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tbl1dNBPHlVCmxIs'  # 项目维度
def serial_ms(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
def pnum(v):
    if v is None: return 0
    s=str(v).replace(',','').replace('%','').strip()
    try: return float(s)
    except: return 0
def ppct(v):
    if v is None: return 0
    s=str(v); return pnum(s)/100 if '%' in s else pnum(s)
ads={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/ads_game.json'))[0]['results']}
prod={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/prod_game.json'))[0]['results']}
keys=set(ads)|set(prod)
# aggregate per (date,group)
G={}
for k in keys:
    sd,game=k.split('|',1); a=ads.get(k,{}); p=prod.get(k,{})
    pj=json.loads(p['pj']) if p.get('pj') else {}
    grp=(a.get('grp') or p.get('grp') or '其他'); gk=sd+'|'+grp
    g=G.setdefault(gk,{'sd':sd,'grp':grp,'sp':0,'rev':0,'act':0,'nu':0,'fl':0,'msp':0,'asp':0,'gross':0,
      'rnW':0,'mRnW':0,'aRnW':0,'expo':0,'req':0,'clk':0,'starts':0,'ecpmW':0,
      'd1W':0,'d7W':0,'d14W':0,'d30W':0,'lsW':0,'asW':0,'durUW':0,'durSW':0,'spd1W':0,'spd2W':0,'admW':0})
    sp=a.get('sp') or 0; roas=a.get('roas') or 0; nu=pnum(pj.get('新增用户')) or (p.get('nu') or 0)
    act=pnum(pj.get('活跃用户')) or (p.get('au') or 0); fl=a.get('fl') or 0
    expo=pnum(pj.get('广告曝光量')); starts=pnum(pj.get('总启动次数'))
    g['sp']+=sp; g['rev']+=pnum(pj.get('广告总收入')) or (p.get('rev') or 0); g['act']+=act; g['nu']+=nu; g['fl']+=fl
    g['msp']+=a.get('msp') or 0; g['asp']+=a.get('asp') or 0; g['gross']+=a.get('gross') or 0
    g['rnW']+=sp*roas; g['mRnW']+=(a.get('msp') or 0)*(a.get('mroi') or 0); g['aRnW']+=(a.get('asp') or 0)*(a.get('aroi') or 0)
    g['expo']+=expo; g['req']+=pnum(pj.get('广告请求量')); g['clk']+=pnum(pj.get('广告点击量')); g['starts']+=starts
    g['ecpmW']+=pnum(pj.get('eCPM'))*expo
    g['d1W']+=ppct(pj.get('次留'))*nu; g['d7W']+=ppct(pj.get('七日留存'))*nu; g['d14W']+=ppct(pj.get('十四日留存'))*nu; g['d30W']+=ppct(pj.get('三十日留存'))*nu
    g['lsW']+=ppct(pj.get('启动成功率'))*act; g['asW']+=ppct(pj.get('授权成功率'))*act
    g['durUW']+=pnum(pj.get('每位用户平均时长_分'))*act; g['durSW']+=pnum(pj.get('次均游戏时长_分'))*starts
    g['spd1W']+=pnum(pj.get('平均启动速度_秒'))*act; g['spd2W']+=pnum(pj.get('平均首次启动速度_秒'))*act
COLS=['统计周期','项目组','消耗','收入','广告首日ROI','手动出价消耗','手动出价ROI','自动出价消耗','自动出价ROI',
'活跃用户','新增用户','广告曝光量','广告请求量','广告点击量','广告点击率','总启动次数','次留','7日留存','14日留存','30日留存',
'eCPM','人均广告展示次数','人均进入次数','人均广告次数','每位用户平均时长(分)','次均游戏时长(分)','平均启动速度(秒)','平均首次启动速度(秒)',
'启动成功率','授权成功率','活跃度平均成本']
def div(a,b): return round(a/b,4) if b else 0
rows=[]
for gk,g in G.items():
    act=g['act']; nu=g['nu']; expo=g['expo']; starts=g['starts']; fl=g['fl']
    rows.append({'统计周期':serial_ms(g['sd']),'项目组':g['grp'],'消耗':round(g['sp'],1),'收入':round(g['rev'],1),
    '广告首日ROI':div(g['rnW'],g['sp']),'手动出价消耗':round(g['msp'],1),'手动出价ROI':div(g['mRnW'],g['msp']),
    '自动出价消耗':round(g['asp'],1),'自动出价ROI':div(g['aRnW'],g['asp']),'活跃用户':round(act),'新增用户':round(nu),
    '广告曝光量':round(expo),'广告请求量':round(g['req']),'广告点击量':round(g['clk']),'广告点击率':div(g['clk'],expo),
    '总启动次数':round(starts),'次留':div(g['d1W'],nu),'7日留存':div(g['d7W'],nu),'14日留存':div(g['d14W'],nu),'30日留存':div(g['d30W'],nu),
    'eCPM':div(g['ecpmW'],expo),'人均广告展示次数':div(expo,act),'人均进入次数':div(starts,act),'人均广告次数':div(g['gross'],fl),
    '每位用户平均时长(分)':div(g['durUW'],act),'次均游戏时长(分)':div(g['durSW'],starts),'平均启动速度(秒)':div(g['spd1W'],act),
    '平均首次启动速度(秒)':div(g['spd2W'],act),'启动成功率':div(g['lsW'],act),'授权成功率':div(g['asW'],act),'活跃度平均成本':div(g['sp'],fl)})
print('项目维度 records:',len(rows))
def lc(args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
allids=[]; off=0
while True:
    r=lc(['+record-list','--limit','200','--offset',str(off)]); d=json.loads(r.stdout)
    ids=d['data']['record_id_list']; allids+=ids
    if d['data'].get('has_more') and ids: off+=200
    else: break
print('existing:',len(allids))
for i in range(0,len(allids),200): lc(['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
cre=0;fail=0
for i in range(0,len(rows),200):
    chunk=rows[i:i+200]; body=json.dumps({"fields":COLS,"rows":[[c[k] for k in COLS] for c in chunk]},ensure_ascii=False)
    ok=False
    for _ in range(3):
        r=lc(['+record-batch-create','--json',body])
        try:
            if json.loads(r.stdout).get('ok'): ok=True;break
        except: pass
        time.sleep(0.6)
    cre+=len(chunk) if ok else 0; fail+=0 if ok else len(chunk)
print(f'项目维度 重建: 创建{cre} 失败{fail}')
