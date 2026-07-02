#!/usr/bin/env python3
"""经营总览预览图:从多维表拉核心数据,绘制一张驾驶舱快照(深色主题),
供机器人定时推送。数据源:昨日速览-总览/项目、【每日经营概览】、近30天-项目日消耗。
"""
import json, os, urllib.request, datetime

APP_ID = os.environ.get('FEISHU_APP_ID', 'cli_aa898a664d395cc2')
APP_SECRET = os.environ['FEISHU_APP_SECRET']
YB = 'YB8TbS45kaO1gesMtqlc8kpznEb'
OUT = '/tmp/overview_preview.png'

def api(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request('https://open.feishu.cn' + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token: req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

tok = api('POST', '/open-apis/auth/v3/tenant_access_token/internal',
          body={'app_id': APP_ID, 'app_secret': APP_SECRET})['tenant_access_token']

tables = {t['name']: t['table_id'] for t in api('GET', f'/open-apis/bitable/v1/apps/{YB}/tables?page_size=100', tok)['data']['items']}

def recs(name):
    out, pt = [], ''
    while True:
        r = api('GET', f"/open-apis/bitable/v1/apps/{YB}/tables/{tables[name]}/records?page_size=500" + (f"&page_token={pt}" if pt else ''), tok)
        out += [x['fields'] for x in r['data'].get('items') or []]
        if not r['data'].get('has_more'): break
        pt = r['data']['page_token']
    return out

num = lambda v: float(v) if v not in (None, '') else 0.0

ov = sorted(recs('昨日速览-总览'), key=lambda x: -num(x.get('日期')))
Y = ov[0]
daily = sorted(recs('【每日经营概览】'), key=lambda x: num(x.get('日期')))
pj = [x for x in recs('昨日速览-项目') if x.get('是否昨日') == '是']
pj.sort(key=lambda x: -num(x.get('消耗')))
r30 = recs('近30天-项目日消耗')
rev30 = {}
for x in r30: rev30[x.get('项目组')] = rev30.get(x.get('项目组'), 0) + num(x.get('收入'))
rev30 = sorted(rev30.items(), key=lambda kv: -kv[1])[:6]

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
for f in ['PingFang HK', 'PingFang SC', 'Heiti TC', 'Noto Sans CJK SC', 'Arial Unicode MS']:
    if any(f.lower() in x.name.lower() for x in font_manager.fontManager.ttflist):
        plt.rcParams['font.family'] = f; break
plt.rcParams['axes.unicode_minus'] = False

BG, CARD, FG, DIM = '#0d1117', '#161b27', '#e6edf3', '#8b949e'
C1, C2, C3, UP, DN = '#58a6ff', '#f0883e', '#3fb950', '#3fb950', '#f85149'
fig = plt.figure(figsize=(12, 9), facecolor=BG)
ydate = datetime.datetime.utcfromtimestamp(num(Y['日期']) / 1000).strftime('%m-%d')
fig.text(0.04, 0.965, 'TT 经营数据总览', color=FG, fontsize=20, fontweight='bold')
fig.text(0.04, 0.935, f"昨日({ydate}) · 生成 {datetime.datetime.now().strftime('%m-%d %H:%M')} · 数据自动同步", color=DIM, fontsize=10)

def pct(v): return f"{v*100:+.0f}%" if v is not None else '-'
cards = [
    ('昨日消耗', f"¥{num(Y.get('消耗')):,.0f}", pct(Y.get('消耗环比') if Y.get('消耗环比') != '' else None), num(Y.get('消耗环比') or 0) >= 0),
    ('昨日收入', f"¥{num(Y.get('收入')):,.0f}", Y.get('收入状态') or '', None),
    ('广告首日ROI', f"{num(Y.get('广告首日ROI'))*100:.0f}%", '', None),
    ('累计ROI', f"{num(Y.get('累计ROI'))*100:.0f}%", '回本进度', None),
    ('昨日新增', f"{num(Y.get('新增用户')):,.0f}", '', None),
    ('环比上周同天', pct(Y.get('消耗环比上周同天') if Y.get('消耗环比上周同天') != '' else None), '消耗', None),
]
for i, (label, val, sub, up) in enumerate(cards):
    x = 0.04 + i * 0.158
    ax = fig.add_axes([x, 0.80, 0.145, 0.10]); ax.set_facecolor(CARD); ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values(): s.set_color('#21262d')
    ax.text(0.08, 0.72, label, color=DIM, fontsize=9, transform=ax.transAxes)
    ax.text(0.08, 0.30, val, color=FG, fontsize=15, fontweight='bold', transform=ax.transAxes)
    if sub: ax.text(0.08, 0.06, str(sub)[:12], color=(UP if up else DN) if up is not None else DIM, fontsize=8, transform=ax.transAxes)

# 近30天 消耗柱 × 投放ROI线
ax1 = fig.add_axes([0.06, 0.42, 0.60, 0.30]); ax1.set_facecolor(CARD)
ds = [datetime.datetime.utcfromtimestamp(num(x['日期']) / 1000).strftime('%m-%d') for x in daily]
sp = [num(x.get('消耗')) for x in daily]; roi = [num(x.get('投放ROI')) * 100 for x in daily]
ax1.bar(ds, sp, color=C1, alpha=0.85, label='消耗')
ax1b = ax1.twinx(); ax1b.plot(ds, roi, color=C2, lw=2, marker='o', ms=3, label='投放ROI%')
ax1.set_title('近30天 每日消耗 × 投放ROI', color=FG, fontsize=12, loc='left')
for ax in (ax1, ax1b):
    ax.tick_params(colors=DIM, labelsize=7)
    for s in ax.spines.values(): s.set_color('#21262d')
ax1.set_xticks(ds[::4]); ax1b.grid(False); ax1.grid(axis='y', color='#21262d', lw=0.5)

# 昨日各项目 消耗×ROI
ax2 = fig.add_axes([0.72, 0.42, 0.24, 0.30]); ax2.set_facecolor(CARD)
gs = [x.get('项目组') for x in pj if num(x.get('消耗')) > 0]
gsp = [num(x.get('消耗')) for x in pj if num(x.get('消耗')) > 0]
ax2.barh(gs[::-1], gsp[::-1], color=C3, alpha=0.85)
ax2.set_title('昨日各项目消耗', color=FG, fontsize=12, loc='left')
ax2.tick_params(colors=DIM, labelsize=9)
for s in ax2.spines.values(): s.set_color('#21262d')

# 近30天项目收入排行
ax3 = fig.add_axes([0.06, 0.06, 0.42, 0.26]); ax3.set_facecolor(CARD)
ax3.barh([k for k, _ in rev30][::-1], [v for _, v in rev30][::-1], color=C2, alpha=0.85)
ax3.set_title('近30天 项目收入排行', color=FG, fontsize=12, loc='left')
ax3.tick_params(colors=DIM, labelsize=9)
for s in ax3.spines.values(): s.set_color('#21262d')

# 营收ROI vs 投放ROI
ax4 = fig.add_axes([0.54, 0.06, 0.42, 0.26]); ax4.set_facecolor(CARD)
rroi = [num(x.get('营收ROI')) * 100 for x in daily]
ax4.plot(ds, rroi, color=C3, lw=2, label='营收ROI%')
ax4.plot(ds, roi, color=C2, lw=2, label='投放ROI%')
ax4.axhline(100, color=DN, lw=1, ls='--', alpha=0.6)
ax4.set_title('近30天 营收ROI vs 投放ROI', color=FG, fontsize=12, loc='left')
ax4.legend(facecolor=CARD, edgecolor='#21262d', labelcolor=FG, fontsize=8)
ax4.tick_params(colors=DIM, labelsize=7); ax4.set_xticks(ds[::4])
for s in ax4.spines.values(): s.set_color('#21262d')
ax4.grid(axis='y', color='#21262d', lw=0.5)

fig.savefig(OUT, dpi=130, facecolor=BG)
print('saved', OUT)
