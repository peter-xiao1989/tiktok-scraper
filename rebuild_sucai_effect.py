#!/usr/bin/env python3
"""
重建【分时素材效果表】
列布局: A=类别 B=项目组 C=游戏名称 D=创意素材名称 E=消耗 F=ROAS
        G=活跃度平均成本 H=展示量 I=点击率（目标页面） J=千次展示成本CPM
        K=人均广告次数 L=更新时间

按(游戏×创意素材)聚合，仅保留消耗>SPEND_THRESHOLD 的素材；
按 项目组+游戏名称 归类、组内按消耗降序；类别=单素材-N。
下方紧接 汇总-1/汇总-2（合计与加权均值），再接判断表：
每个游戏按 ROAS 取前3=最优、后3=最劣（消耗门槛过滤）。
"""
import json, subprocess, re, sys, os, time, random
from collections import defaultdict

SPREADSHEET_TOKEN = "K8tgsrOpFhxjy3tgDHscJ5jonHh"
SRC_SHEET     = "jArZTX"   # TT每日分时投放数据原表
TARGET_SHEET  = "dbGqhL"   # 分时素材效果表
REF_SHEET     = "juQobR"   # 产品id及链接
LIGHT_YELLOW  = "#FFF2CC"
LIGHT_GREEN   = "#D9EAD3"   # 最优
LIGHT_RED     = "#F4CCCC"   # 最劣

SPEND_THRESHOLD = 0.0   # 消耗门槛：仅统计消耗 > 此值的素材；数据量增长后可调高
TOP_N           = 3     # 每游戏取前/后 N 个

ENV = {**os.environ, "PATH": os.environ["PATH"] + ":/Users/xiao/.npm-global/bin"}
BOT_MODE = os.environ.get("LARK_AS_BOT", "0") == "1"

# 源表列索引（0-based）
C_GAME, C_UPDATE, C_SPEND, C_ROAS, C_ACTIVITY = 1, 3, 4, 5, 6
C_PER_AD, C_CTR, C_CPM, C_MATERIAL = 8, 9, 10, 12
C_CLICKS, C_IMPR = 23, 24


def lark(args):
    base = ["lark-cli", "--format", "json"]
    if BOT_MODE:
        base += ["--as", "bot"]
    for attempt in range(10):
        r = subprocess.run(base + args, capture_output=True, text=True, env=ENV)
        d = json.loads(r.stdout or r.stderr or '{}')
        if d.get('code') in (90217, 90235) and attempt < 9:  # rate-limit → exp backoff + jitter (~1min total)
            time.sleep(min(15, 0.5 * 2 ** attempt) + random.random() * 0.5)
            continue
        return d


def cells_set(rng, cells):
    return lark(["sheets", "+cells-set", "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", TARGET_SHEET, "--range", rng,
                 "--cells", json.dumps(cells, ensure_ascii=False)])


def cells_clear(rng):
    return lark(["sheets", "+cells-clear", "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", TARGET_SHEET, "--range", rng, "--yes"])


def set_style(rng, bg_color=None, number_format=None):
    args = ["sheets", "+cells-set-style", "--spreadsheet-token", SPREADSHEET_TOKEN,
            "--sheet-id", TARGET_SHEET, "--range", rng]
    if bg_color:
        args += ["--background-color", bg_color]
    if number_format:
        args += ["--number-format", number_format]
    return lark(args)


def csv_get(sheet, rng):
    return lark(["sheets", "+csv-get", "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", sheet, "--range", rng])


def fnum(s):
    s = str(s).strip().replace(",", "")
    if not s:
        return 0.0
    pct = s.endswith("%")
    try:
        v = float(s.rstrip("%"))
        return v / 100 if pct else v
    except (ValueError, AttributeError):
        return 0.0


# ── Step 1: 读项目组映射（游戏名称 -> 项目组）────────────────────────
print("读取项目组映射...")
ref = csv_get(REF_SHEET, "A1:C100")
group_map = {}
for r in ref['data']['annotated_csv'].strip().split('\n')[1:]:
    p = re.sub(r'^\[row=\d+\] ', '', r).split(',')
    if len(p) >= 2 and p[1].strip():
        group_map[p[1].strip()] = p[0].strip()

# ── Step 2: 读源表，按(游戏×创意)聚合 ───────────────────────────────
print("读取源表...")
d = csv_get(SRC_SHEET, "A1:AU219")
rows = d['data']['annotated_csv'].strip().split('\n')

agg = defaultdict(lambda: {"spend": 0.0, "activity": 0.0, "impr": 0.0,
                           "clicks": 0.0, "roas_x": 0.0, "perad_x": 0.0,
                           "update": ""})
for r in rows[1:]:
    p = re.sub(r'^\[row=\d+\] ', '', r).split(',')
    if len(p) <= C_IMPR or not p[C_GAME].strip():
        continue
    game, mat = p[C_GAME].strip(), p[C_MATERIAL].strip()
    if not mat:
        continue
    a = agg[(game, mat)]
    spend = fnum(p[C_SPEND]); activity = fnum(p[C_ACTIVITY])
    a["spend"]    += spend
    a["activity"] += activity
    a["impr"]     += fnum(p[C_IMPR])
    a["clicks"]   += fnum(p[C_CLICKS])
    a["roas_x"]   += spend * fnum(p[C_ROAS])         # 消耗加权 ROAS 分子
    a["perad_x"]  += activity * fnum(p[C_PER_AD])    # 活跃度加权 人均 分子
    if p[C_UPDATE].strip():
        a["update"] = p[C_UPDATE].strip()


def metrics(game, mat, a):
    spend, activity, impr = a["spend"], a["activity"], a["impr"]
    return {
        "group":    group_map.get(game, ""),
        "game":     game,
        "material": mat,
        "spend":    spend,
        "roas":     a["roas_x"] / spend if spend else 0.0,
        "act_cost": spend / activity if activity else 0.0,
        "impr":     impr,
        "ctr":      a["clicks"] / impr if impr else 0.0,
        "cpm":      spend / impr * 1000 if impr else 0.0,
        "per_ad":   a["perad_x"] / activity if activity else 0.0,
        "update":   a["update"],
    }


records = [metrics(g, m, a) for (g, m), a in agg.items()
           if a["spend"] > SPEND_THRESHOLD]
if not records:
    print("没有消耗>门槛的素材，退出")
    sys.exit(0)

# 归类：项目组 -> 游戏名称 -> 组内消耗降序
records.sort(key=lambda x: (x["group"], x["game"], -x["spend"]))
n = len(records)
print(f"消耗>{SPEND_THRESHOLD} 的素材数: {n}")


def row_cells(category, m, bg=None):
    return [
        {"value": category}, {"value": m["group"]}, {"value": m["game"]},
        {"value": m["material"]}, {"value": round(m["spend"], 4)},
        {"value": round(m["roas"], 4)}, {"value": round(m["act_cost"], 4)},
        {"value": round(m["impr"], 0)}, {"value": round(m["ctr"], 6)},
        {"value": round(m["cpm"], 4)}, {"value": round(m["per_ad"], 4)},
        {"value": m["update"]},
    ]


# ── 计算行布局 ──────────────────────────────────────────────────────
data_start = 2
data_end   = data_start + n - 1
agg_label  = data_end + 2          # 汇总-1
agg_val    = agg_label + 1         # 汇总-2

# 判断表：每游戏 top/bottom N
games_sorted = sorted({r["game"] for r in records},
                      key=lambda g: (group_map.get(g, ""), g))
best_rows, worst_rows = [], []
for g in games_sorted:
    grp = sorted([r for r in records if r["game"] == g],
                 key=lambda x: (-x["roas"], -x["spend"]))
    for i, m in enumerate(grp[:TOP_N]):
        best_rows.append((f"{g}-最优{i+1}", m))
    worst = sorted([r for r in records if r["game"] == g],
                   key=lambda x: (x["roas"], -x["spend"]))
    for i, m in enumerate(worst[:TOP_N]):
        worst_rows.append((f"{g}-最劣{i+1}", m))

best_hdr   = agg_val + 2           # "最优素材表现" 标题行
best_start = best_hdr + 1
best_end   = best_start + len(best_rows) - 1
worst_hdr  = best_end + 2
worst_start = worst_hdr + 1
worst_end   = worst_start + len(worst_rows) - 1
clear_to    = worst_end + 5

# ── Step 3: 清空 ────────────────────────────────────────────────────
print(f"清空 A1:L{clear_to}...")
cells_clear(f"A1:L{clear_to}")

# ── Step 4: 表头 ────────────────────────────────────────────────────
header = ["类别", "项目组", "游戏名称", "创意素材名称", "消耗",
          "广告收入 ROAS (TikTok)", "活跃度平均成本", "展示量",
          "点击率（目标页面）", "千次展示成本 (CPM)", "人均广告次数", "更新时间"]
cells_set("A1:L1", [[{"value": h} for h in header]])

# ── Step 5: 数据行 ──────────────────────────────────────────────────
print(f"写 {n} 条数据行...")
data_cells = []
for i, m in enumerate(records):
    data_cells.append(row_cells(f"单素材-{i+1}", m))
cells_set(f"A{data_start}:L{data_end}", data_cells)

# ── Step 6: 汇总行 ──────────────────────────────────────────────────
tot_spend = sum(r["spend"] for r in records)
tot_act   = sum(r["spend"] / r["act_cost"] if r["act_cost"] else 0 for r in records)
tot_impr  = sum(r["impr"] for r in records)
tot_clk   = sum(r["ctr"] * r["impr"] for r in records)
tot_roas_x = sum(r["roas"] * r["spend"] for r in records)
tot_perad_x = sum(r["per_ad"] * (r["spend"] / r["act_cost"] if r["act_cost"] else 0)
                  for r in records)
update_any = next((r["update"] for r in records if r["update"]), "")

cells_set(f"A{agg_label}:L{agg_label}", [[
    {"value": "汇总-1"}, {"value": ""}, {"value": ""}, {"value": ""},
    {"value": "消耗合计"}, {"value": "ROAS 加权均值"}, {"value": "活跃度平均成本(综合)"},
    {"value": "展示量合计"}, {"value": "点击率(综合)"}, {"value": "CPM(综合)"},
    {"value": "人均广告次数加权均值"}, {"value": "更新时间"},
]])
cells_set(f"A{agg_val}:L{agg_val}", [[
    {"value": "汇总-2"}, {"value": ""}, {"value": ""}, {"value": ""},
    {"value": round(tot_spend, 4)},
    {"value": round(tot_roas_x / tot_spend, 4) if tot_spend else 0},
    {"value": round(tot_spend / tot_act, 4) if tot_act else 0},
    {"value": round(tot_impr, 0)},
    {"value": round(tot_clk / tot_impr, 6) if tot_impr else 0},
    {"value": round(tot_spend / tot_impr * 1000, 4) if tot_impr else 0},
    {"value": round(tot_perad_x / tot_act, 4) if tot_act else 0},
    {"value": update_any},
]])

# ── Step 7: 判断表 ──────────────────────────────────────────────────
print(f"写判断表：最优{len(best_rows)}行 / 最劣{len(worst_rows)}行...")
cells_set(f"A{best_hdr}:L{best_hdr}", [[
    {"value": f"最优素材表现（每游戏按 ROAS 取前{TOP_N}，消耗>{SPEND_THRESHOLD}）"}
] + [{"value": ""}] * 11])
cells_set(f"A{best_start}:L{best_end}",
          [row_cells(cat, m) for cat, m in best_rows])

cells_set(f"A{worst_hdr}:L{worst_hdr}", [[
    {"value": f"最劣素材表现（每游戏按 ROAS 取后{TOP_N}，消耗>{SPEND_THRESHOLD}）"}
] + [{"value": ""}] * 11])
cells_set(f"A{worst_start}:L{worst_end}",
          [row_cells(cat, m) for cat, m in worst_rows])

# ── Step 8: 数值列格式 ──────────────────────────────────────────────
print("修正数值列格式...")
num_end = worst_end
for col in ["E", "F", "G", "H", "J", "K"]:
    set_style(f"{col}{data_start}:{col}{num_end}", number_format="#,##0.####")
set_style(f"I{data_start}:I{num_end}", number_format="0.00%")   # 点击率

# ── Step 9: 背景色 ──────────────────────────────────────────────────
print("设置背景色...")
set_style(f"A{agg_label}:L{agg_val}", bg_color=LIGHT_YELLOW)
set_style(f"A{best_hdr}:L{best_end}", bg_color=LIGHT_GREEN)
set_style(f"A{worst_hdr}:L{worst_end}", bg_color=LIGHT_RED)

print(f"\n完成！数据行 2-{data_end}，汇总 {agg_label}-{agg_val}，"
      f"最优 {best_start}-{best_end}，最劣 {worst_start}-{worst_end}")
