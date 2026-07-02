import json,subprocess,datetime,time
# 独立库:每组 经营日报(项目维度,去手动/自动) + 包体日报。近30天。
BASES={
 '枪战':{'base':'X89dbn5DZaYhMqsjcE1cZv3snD4','jy':'tbltRQEoNxf0iF7J','bt':'tblGZQa0TT3sD7E5'},
 '战车':{'base':'WzfObSESya7fo0sKO9Hc8zernBh','jy':'tblFpr4xd7t9BTFJ','bt':'tblfYMyu7MEUNPDz'},
 '齿轮':{'base':'WzfObSESya7fo0sKO9Hc8zernBh','jy':'tblAVPZUTXP5zIwq','bt':'tblKY3uYhVloFKmT'},
 '监狱':{'base':'WzfObSESya7fo0sKO9Hc8zernBh','jy':'tblf9rTUc2RSOaY5','bt':'tblw0AoypXbc8xIj'},
}
def sm(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
def pnum(v):
    if v is None: return 0
    s=str(v).replace(',','').replace('%','').strip()
    try: return float(s)
    except: return 0
def ppct(v):
    s=str(v) if v is not None else ''; return pnum(s)/100 if '%' in s else pnum(s)
def d2(a,b): return round(a/b,2) if b else 0
def d3(a,b): return round(a/b,3) if b else 0
def d4(a,b): return round(a/b,4) if b else 0
ads={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/ads_game.json'))[0]['results']}
prod={r['sd']+'|'+r['game']:r for r in json.load(open('/tmp/prod_game.json'))[0]['results']}
keys=set(ads)|set(prod)
alldates=sorted(set(k.split('|',1)[0] for k in keys))
cutoff=alldates[-30] if len(alldates)>=30 else alldates[0]; L=alldates[-1]
# per-game records (for 包体日报) + collect for per-group agg
PG={}  # group -> list of game-day dict
GD={}  # group -> {date -> agg}
for k in keys:
    sd,game=k.split('|',1)
    if sd<cutoff: continue
    a=ads.get(k,{}); p=prod.get(k,{}); pj=json.loads(p['pj']) if p.get('pj') else {}
    grp=(a.get('grp') or p.get('grp') or '其他')
    if grp not in BASES: continue
    sp=a.get('sp') or 0; fl=a.get('fl') or 0; nu=pnum(pj.get('新增用户')) or (p.get('nu') or 0); act=pnum(pj.get('活跃用户')) or (p.get('au') or 0)
    rev=pnum(pj.get('广告总收入')) or (p.get('rev') or 0); expo=pnum(pj.get('广告曝光量')); starts=pnum(pj.get('总启动次数'))
    roas=a.get('roas') or 0
    # 包体日报行
    PG.setdefault(grp,[]).append({'游戏名称':game,'项目组':grp,'统计周期':sm(sd),'月份':sd[:7],'是否昨日':'是' if sd==L else '否',
      '消耗':sp,'收入':rev,'广告首日ROI':roas,'广告新增':round(fl),'广告新增成本':d2(sp,fl),'运营新增成本':d2(sp,nu),
      '活跃用户':round(act),'新增用户':round(nu),'次留':ppct(pj.get('次留')),'7日留存':ppct(pj.get('七日留存')),'14日留存':ppct(pj.get('十四日留存')),'30日留存':ppct(pj.get('三十日留存')),
      'eCPM':pnum(pj.get('eCPM')),'广告点击率':ppct(pj.get('广告点击率')),'点击率（目标页面）':d4(a.get('clk') or 0,a.get('imp') or 0) if a.get('imp') else 0,
      '总启动次数':round(starts),'人均进入次数':pnum(pj.get('人均进入次数')),'每位用户平均时长(分)':pnum(pj.get('每位用户平均时长_分')),'次均游戏时长(分)':pnum(pj.get('次均游戏时长_分')),
      '平均启动速度(秒)':pnum(pj.get('平均启动速度_秒')),'平均首次启动速度(秒)':pnum(pj.get('平均首次启动速度_秒')),'启动成功率':ppct(pj.get('启动成功率')),
      '人均广告展示次数':pnum(pj.get('人均广告展示次数')),'人均广告次数':d3(a.get('gross') or 0,fl),'活跃度平均成本':d2(sp,fl)})
    # 经营日报 agg
    g=GD.setdefault(grp,{}).setdefault(sd,{'sp':0,'rev':0,'rnW':0,'act':0,'nu':0,'fl':0,'expo':0,'req':0,'clk':0,'starts':0,'gross':0,'ecpmW':0,'d1W':0,'d7W':0,'d14W':0,'d30W':0,'lsW':0,'asW':0,'durUW':0,'durSW':0,'spd1W':0,'spd2W':0})
    g['sp']+=sp; g['rev']+=rev; g['rnW']+=sp*roas; g['act']+=act; g['nu']+=nu; g['fl']+=fl
    g['expo']+=expo; g['req']+=pnum(pj.get('广告请求量')); g['clk']+=pnum(pj.get('广告点击量')); g['starts']+=starts; g['gross']+=(a.get('gross') or 0)
    g['ecpmW']+=pnum(pj.get('eCPM'))*expo; g['d1W']+=ppct(pj.get('次留'))*nu; g['d7W']+=ppct(pj.get('七日留存'))*nu; g['d14W']+=ppct(pj.get('十四日留存'))*nu; g['d30W']+=ppct(pj.get('三十日留存'))*nu
    g['lsW']+=ppct(pj.get('启动成功率'))*act; g['asW']+=ppct(pj.get('授权成功率'))*act; g['durUW']+=pnum(pj.get('每位用户平均时长_分'))*act; g['durSW']+=pnum(pj.get('次均游戏时长_分'))*starts
    g['spd1W']+=pnum(pj.get('平均启动速度_秒'))*act; g['spd2W']+=pnum(pj.get('平均首次启动速度_秒'))*act
JY_COLS=['统计周期','月份','是否昨日','项目组','消耗','收入','广告首日ROI','活跃用户','新增用户','活跃度平均成本','广告曝光量','广告请求量','广告点击量','广告点击率','总启动次数','人均进入次数','人均广告展示次数','人均广告次数','次留','7日留存','14日留存','30日留存','eCPM','每位用户平均时长(分)','次均游戏时长(分)','平均启动速度(秒)','平均首次启动速度(秒)','启动成功率','授权成功率']
BT_COLS=['统计周期','月份','是否昨日','游戏名称','消耗','收入','广告首日ROI','广告新增','广告新增成本','运营新增成本','活跃用户','新增用户','eCPM','广告点击率','点击率（目标页面）','人均进入次数','人均广告展示次数','人均广告次数','每位用户平均时长(分)','平均启动速度(秒)','平均首次启动速度(秒)','启动成功率']
def lc(base,tbl,args): return subprocess.run(['lark-cli','base']+args+['--base-token',base,'--table-id',tbl,'--format','json'],capture_output=True,text=True)
def replace(base,tbl,cols,rows):
    allids=[];off=0
    while True:
        ids=None
        for _ in range(4):
            r=lc(base,tbl,['+record-list','--limit','200','--offset',str(off)])
            try: dd=json.loads(r.stdout);ids=dd['data']['record_id_list'];hm=dd['data'].get('has_more');break
            except: time.sleep(1)
        if ids is None: break
        allids+=ids
        if hm and ids: off+=200
        else: break
    for i in range(0,len(allids),200):
        for _ in range(3):
            rr=lc(base,tbl,['+record-delete','--json',json.dumps({"record_id_list":allids[i:i+200]}),'--yes'])
            try:
                if json.loads(rr.stdout).get('ok'): break
            except: pass
            time.sleep(0.6)
    cre=0
    for i in range(0,len(rows),200):
        chunk=rows[i:i+200];body=json.dumps({"fields":cols,"rows":[[c.get(k) for k in cols] for c in chunk]},ensure_ascii=False)
        for _ in range(3):
            r=lc(base,tbl,['+record-batch-create','--json',body])
            try:
                if json.loads(r.stdout).get('ok'):cre+=len(chunk);break
            except: pass
            time.sleep(0.6)
    return len(allids),cre
for grp,cfg in BASES.items():
    # 经营日报 rows
    jyrows=[]
    for sd,g in sorted(GD.get(grp,{}).items()):
        act=g['act'];nu=g['nu'];expo=g['expo'];starts=g['starts'];fl=g['fl']
        jyrows.append({'统计周期':sm(sd),'月份':sd[:7],'是否昨日':'是' if sd==L else '否','项目组':grp,'消耗':round(g['sp'],1),'收入':round(g['rev'],1),
          '广告首日ROI':d4(g['rnW'],g['sp']),'活跃用户':round(act),'新增用户':round(nu),'活跃度平均成本':d2(g['sp'],fl),
          '广告曝光量':round(expo),'广告请求量':round(g['req']),'广告点击量':round(g['clk']),'广告点击率':d4(g['clk'],expo),'总启动次数':round(starts),
          '人均进入次数':d3(starts,act),'人均广告展示次数':d3(expo,act),'人均广告次数':d3(g['gross'],fl),'次留':d4(g['d1W'],nu),'7日留存':d4(g['d7W'],nu),'14日留存':d4(g['d14W'],nu),'30日留存':d4(g['d30W'],nu),
          'eCPM':d3(g['ecpmW'],expo),'每位用户平均时长(分)':d2(g['durUW'],act),'次均游戏时长(分)':d2(g['durSW'],starts),'平均启动速度(秒)':d2(g['spd1W'],act),'平均首次启动速度(秒)':d2(g['spd2W'],act),'启动成功率':d4(g['lsW'],act),'授权成功率':d4(g['asW'],act)})
    de1,c1=replace(cfg['base'],cfg['jy'],JY_COLS,jyrows)
    de2,c2=replace(cfg['base'],cfg['bt'],BT_COLS,PG.get(grp,[]))
    print(f'{grp}: 经营日报 删{de1}建{c1} / 包体日报 删{de2}建{c2}')
print('DONE 独立base')
