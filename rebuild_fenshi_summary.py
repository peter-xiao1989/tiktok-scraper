#!/usr/bin/env python3
"""
重建【分时同步数据汇总】表
列布局: A=类别 B=更新时间 C=项目组 D=游戏名称 E=出价方式
        F=消耗 G=ROAS H=活跃度平均成本 I=活跃度 J=人均广告次数
"""
import json, subprocess, re, sys, os, time, random
from collections import defaultdict

SPREADSHEET_TOKEN = "K8tgsrOpFhxjy3tgDHscJ5jonHh"
SRC_SHEET     = "jArZTX"   # TT每日分时投放数据原表
SUMMARY_SHEET = "jdlBTh"   # 分时同步数据汇总
SRC_NAME      = "TT每日分时投放数据原表"
REF_NAME      = "产品id及链接"
LIGHT_YELLOW  = "#FFF2CC"

ENV = {**os.environ, "PATH": os.environ["PATH"] + ":/Users/xiao/.npm-global/bin"}

BOT_MODE = os.environ.get("LARK_AS_BOT", "0") == "1"

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
    return lark(["sheets", "+cells-set",
                 "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", SUMMARY_SHEET,
                 "--range", rng,
                 "--cells", json.dumps(cells, ensure_ascii=False)])

def cells_clear(rng):
    return lark(["sheets", "+cells-clear",
                 "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", SUMMARY_SHEET,
                 "--range", rng, "--yes"])

def set_style(rng, bg_color=None, number_format=None):
    args = ["sheets", "+cells-set-style",
            "--spreadsheet-token", SPREADSHEET_TOKEN,
            "--sheet-id", SUMMARY_SHEET,
            "--range", rng]
    if bg_color:
        args += ["--background-color", bg_color]
    if number_format:
        args += ["--number-format", number_format]
    return lark(args)

def csv_get(sheet, rng):
    return lark(["sheets", "+csv-get",
                 "--spreadsheet-token", SPREADSHEET_TOKEN,
                 "--sheet-id", sheet, "--range", rng])

# ── Step 1: 读源表，找消耗>0 的(游戏×出价方式)组合 ──────────────────
print("读取源表...")
d = csv_get(SRC_SHEET, "A1:AU3000")
rows = d['data']['annotated_csv'].strip().split('\n')

spend_map = defaultdict(float)
for r in rows[1:]:
    clean = re.sub(r'^\[row=\d+\] ', '', r)
    parts = clean.split(',')
    if len(parts) < 46 or not parts[1].strip():
        continue
    game, bid = parts[1].strip(), parts[45].strip()
    try:
        spend_map[(game, bid)] += float(parts[4]) if parts[4].strip() else 0.0
    except ValueError:
        pass

combos = sorted(
    [(g, b) for (g, b), s in spend_map.items() if s > 0],
    key=lambda x: (x[0], x[1])
)
print(f"消耗>0的组合: {combos}")
if not combos:
    print("没有消耗>0的组合，退出")
    sys.exit(0)

n = len(combos)
last_data_row  = n + 1          # 最后数据行（行1为表头）
agg_label_row  = last_data_row + 2
agg_val_row    = agg_label_row + 1
clear_to       = agg_val_row + 5

# ── Step 2: 清空 ──────────────────────────────────────────────────────
print(f"清空 A1:J{clear_to}...")
cells_clear(f"A1:J{clear_to}")

# ── Step 3: 表头 ──────────────────────────────────────────────────────
print("写表头...")
cells_set("A1:J1", [[
    {"value": "类别"},
    {"value": "更新时间"},
    {"value": "项目组"},
    {"value": "游戏名称"},
    {"value": "出价方式"},
    {"value": "消耗"},
    {"value": "广告收入 ROAS (TikTok)"},
    {"value": "活跃度平均成本"},
    {"value": "活跃度"},
    {"value": "人均广告次数"},
]])

# ── Step 4: 数据行 ────────────────────────────────────────────────────
def val(col, s=2, e=3000):
    """源表某列：IFERROR(VALUE(...), 0)"""
    return f"IFERROR(VALUE('{SRC_NAME}'!{col}{s}:{col}{e}),0)"

print(f"写 {n} 条数据行(一次批量,减少飞书写请求)...")
data_rows = []
for i, (game, bid) in enumerate(combos):
    row  = i + 2
    cond = f"('{SRC_NAME}'!B2:B3000=D{row})*('{SRC_NAME}'!AT2:AT3000=E{row})"
    data_rows.append([
        {"value": f"单项目-{i+1}"},                          # A: 类别
        {"formula": f"=IFERROR('{SRC_NAME}'!D2,\"\")"},      # B: 更新时间
        {"formula": f"=IFERROR(INDEX('{REF_NAME}'!A2:A100,"  # C: 项目组
                    f"MATCH(D{row},'{REF_NAME}'!B2:B100,0)),\"\")"},
        {"value": game},                                      # D: 游戏名称
        {"value": bid},                                       # E: 出价方式
        {"formula": f"=SUMIFS('{SRC_NAME}'!E2:E3000,"         # F: 消耗
                    f"'{SRC_NAME}'!B2:B3000,D{row},"
                    f"'{SRC_NAME}'!AT2:AT3000,E{row})"},
        {"formula": f"=IFERROR(SUMPRODUCT({cond}*{val('E')}*{val('F')})/F{row},0)"},  # G: ROAS
        {"formula": f"=IFERROR(F{row}/I{row},0)"},           # H: 活跃度平均成本
        {"formula": f"=SUMIFS('{SRC_NAME}'!G2:G3000,"         # I: 活跃度
                    f"'{SRC_NAME}'!B2:B3000,D{row},"
                    f"'{SRC_NAME}'!AT2:AT3000,E{row})"},
        {"formula": f"=IFERROR(SUMPRODUCT({cond}*{val('G')}*{val('I')})/I{row},0)"},  # J: 人均
    ])
cells_set(f"A2:J{n + 1}", data_rows)   # 一次写 n 行,而不是 n 次请求

# ── Step 5: 汇总标签行 ────────────────────────────────────────────────
print(f"写汇总标签（行{agg_label_row}）...")
cells_set(f"A{agg_label_row}:J{agg_label_row}", [[
    {"value": "汇总-1"},
    {"value": ""},
    {"value": ""},
    {"value": ""},
    {"value": ""},
    {"value": "消耗合计"},
    {"value": "ROAS 加权均值"},
    {"value": "活跃度平均成本(综合)"},
    {"value": "活跃度合计"},
    {"value": "人均广告次数加权均值"},
]])

# ── Step 6: 汇总数值行 ────────────────────────────────────────────────
def ar(col):  # agg_range
    return f"{col}2:{col}{last_data_row}"

print(f"写汇总数值（行{agg_val_row}）...")
cells_set(f"A{agg_val_row}:J{agg_val_row}", [[
    {"value": "汇总-2"},
    {"formula": f"=IFERROR('{SRC_NAME}'!D2,\"\")"},
    {"value": ""},
    {"value": ""},
    {"value": ""},
    {"formula": f"=SUM({ar('F')})"},
    {"formula": f"=IFERROR(SUMPRODUCT(IFERROR(VALUE({ar('F')}),0)*IFERROR(VALUE({ar('G')}),0))/F{agg_val_row},0)"},
    {"formula": f"=IFERROR(F{agg_val_row}/I{agg_val_row},0)"},
    {"formula": f"=SUM({ar('I')})"},
    {"formula": f"=IFERROR(SUMPRODUCT(IFERROR(VALUE({ar('I')}),0)*IFERROR(VALUE({ar('J')}),0))/I{agg_val_row},0)"},
]])

# ── Step 7: 数值列格式（防止遗留百分比格式）─────────────────────────
print("修正数值列格式...")
set_style(f"F2:J{agg_val_row}", number_format="#,##0.####")  # F:J 连续,一次设

# ── Step 8: 汇总行背景色（淡黄色）───────────────────────────────────
print("设置汇总行背景色...")
set_style(f"A{agg_label_row}:J{agg_label_row}", bg_color=LIGHT_YELLOW)
set_style(f"A{agg_val_row}:J{agg_val_row}",     bg_color=LIGHT_YELLOW)

print(f"\n完成！共 {n} 行数据（单项目-1 ~ 单项目-{n}），汇总在第 {agg_label_row}-{agg_val_row} 行")
print("新游戏加入后重新运行此脚本即可自动识别")
