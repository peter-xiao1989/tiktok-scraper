import json,subprocess,datetime,time
BASE='YB8TbS45kaO1gesMtqlc8kpznEb'; TBL='tblqOrXAMcnA9nD3'
ds=json.load(open('/tmp/ds_all.json'))[0]['results']
def sm(d):
    y,m,dd=map(int,d.split('-')); return round(datetime.datetime(y,m,dd,tzinfo=datetime.timezone.utc).timestamp()/86400)*86400000
r=subprocess.run(['lark-cli','base','+record-list','--base-token',BASE,'--table-id',TBL,'--format','json','--limit','200'],capture_output=True,text=True)
d=json.loads(r.stdout);data=d['data']['data'];ids=d['data']['record_id_list'];fn=d['data']['fields'];di=fn.index('统计周期')
exist={str(row[di])[:10]:rid for row,rid in zip(data,ids)}
def lc(args): return subprocess.run(['lark-cli','base']+args+['--base-token',BASE,'--table-id',TBL,'--format','json'],capture_output=True,text=True)
ok=cre=fail=0
creates=[]
for x in ds:
    f={'统计周期':sm(x['stat_date']),'消耗':x['sp'],'收入':x['rev'],'广告首日ROI':x['adroi'],'新增用户':x['nu'],'累计消耗':x['cs'],'累计收入':x['cr'],'TT累计ROI':x['croi']}
    if x['stat_date'] in exist:
        done=False
        for _ in range(3):
            rr=lc(['+record-batch-update','--json',json.dumps({"record_id_list":[exist[x['stat_date']]],"patch":f},ensure_ascii=False)])
            try:
                if json.loads(rr.stdout).get('ok'):done=True;break
            except:pass
            time.sleep(0.4)
        ok+=done;fail+=0 if done else 1
    else: creates.append(f)
if creates:
    cols=list(creates[0].keys())
    rr=lc(['+record-batch-create','--json',json.dumps({"fields":cols,"rows":[[c[k] for k in cols] for c in creates]},ensure_ascii=False)])
    try: cre=len(creates) if json.loads(rr.stdout).get('ok') else 0
    except: cre=0
print(f'日汇总: 更新{ok} 新建{cre} 失败{fail}')
