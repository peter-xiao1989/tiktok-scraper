#!/usr/bin/env python3
"""
将电子表格的加工汇总表同步到多维表(Base)。兼做首次迁移与定时全量同步。
- 自动识别数值列(建 number 字段)，其余 text；日期/文本保持 text。
- 每次运行：清空目标表记录后全量重灌（表 ≤ 数百行，简单可靠无残留）。
- 表 id 缓存在 base_sync_tables.json，避免重复建表。
"""
import json, subprocess, os, re, sys, time

SPREADSHEET = "K8tgsrOpFhxjy3tgDHscJ5jonHh"
BASE_TOKEN  = "YB8TbS45kaO1gesMtqlc8kpznEb"   # TT经营数据中心（用户身份创建）
CACHE = os.path.join(os.path.dirname(__file__), "base_sync_tables.json")
ENV = {**os.environ, "PATH": os.environ["PATH"] + ":/Users/xiao/.npm-global/bin"}
BOT = os.environ.get("LARK_AS_BOT", "1") == "1"

# (sheet_id, 读取范围列上界, 多维表名, 组)
SHEETS = [
    ("wAsSso", "H",  "日经营数据汇总",   "chanpin"),
    ("JIKPZV", "T",  "项目维度经营表",   "chanpin"),
    ("6B1PVx", "AB", "各产品经营日报表", "chanpin"),
    ("kX0M0R", "Z",  "投放日报-产品维度", "toufang"),
    ("TOBfe9", "K",  "投放日报-素材维度", "toufang"),
    ("dbGqhL", "L",  "分时素材效果表",   "fenshi"),
]

def lark(args, timeout=120):
    base = ["lark-cli", "--format", "json"] + (["--as", "bot"] if BOT else [])
    r = subprocess.run(base + args, capture_output=True, text=True, env=ENV, timeout=timeout)
    try: return json.loads(r.stdout or r.stderr or "{}")
    except Exception: return {"ok": False, "raw": (r.stdout or r.stderr)[:200]}

def csv_get(sid, rng, tries=8):
    for _ in range(tries):
        d = lark(["sheets", "+csv-get", "--spreadsheet-token", SPREADSHEET,
                  "--sheet-id", sid, "--range", rng])
        if d.get("ok"): return d
        time.sleep(4)
    return d

def load_cache():
    return json.load(open(CACHE)) if os.path.exists(CACHE) else {}
def save_cache(c): json.dump(c, open(CACHE, "w"), ensure_ascii=False, indent=2)

def parse_num(v):
    """尝试把文本转数值；百分比转小数；失败返回 None。"""
    s = str(v).strip()
    if s == "": return None
    pct = s.endswith("%")
    t = s.rstrip("%").replace(",", "")
    try:
        f = float(t)
        return f/100 if pct else f
    except ValueError:
        return None

def list_tables():
    d = lark(["base", "+table-list", "--base-token", BASE_TOKEN])
    return {t["name"]: t["id"] for t in d.get("data", {}).get("tables", [])}

def clear_records(tid):
    ids, offset = [], 0
    while True:
        d = lark(["base", "+record-list", "--base-token", BASE_TOKEN, "--table-id", tid,
                  "--limit", "200", "--offset", str(offset)])
        dd = d.get("data", {})
        batch = dd.get("record_id_list", [])
        ids += batch
        if not dd.get("has_more") or not batch: break
        offset += len(batch)
    for i in range(0, len(ids), 200):
        lark(["base", "+record-delete", "--base-token", BASE_TOKEN, "--table-id", tid,
              "--json", json.dumps({"record_id_list": ids[i:i+200]}), "--yes"])
        time.sleep(0.4)
    return len(ids)

def sync_sheet(sid, colmax, tname, cache):
    print(f"\n── {tname} ({sid}) ──")
    d = csv_get(sid, f"A1:{colmax}600")
    if not d.get("ok"):
        print("  读取失败:", d.get("error", {}).get("message", "")[:80]); return
    rows = d["data"]["annotated_csv"].strip().split("\n")
    raw_header = re.sub(r"^\[row=\d+\] ", "", rows[0]).split(",")
    while raw_header and raw_header[-1].strip() == "": raw_header.pop()
    # 丢弃空列名、下划线辅助列、以及"序号/类别"列(多维表不需要,用记录本身)
    SKIP = {"序号", "类别"}
    keep = [j for j, h in enumerate(raw_header)
            if h.strip() and not h.strip().startswith("_")
            and h.strip() not in SKIP and not re.match(r"序号\d+$", h.strip())]
    header, seen = [], {}
    for j in keep:
        h = raw_header[j].strip()
        if h in seen:                       # 重名列加后缀
            seen[h] += 1; h = f"{h}{seen[h]}"
        else:
            seen[h] = 1
        header.append(h)
    ncol = len(header)
    if ncol == 0: print("  空表头，跳过"); return
    nraw = len(raw_header)
    data = []
    for r in rows[1:]:
        c = re.sub(r"^\[row=\d+\] ", "", r).split(",")
        c = (c + [""]*nraw)[:nraw]
        c = [c[j] for j in keep]
        if not any(x.strip() for x in c): continue
        data.append(c)
    if not data: print("  无数据行，跳过"); return

    # 数值列检测：非空值≥80%可转数值，且列名不像日期/时间
    numeric = []
    for j in range(ncol):
        vals = [data[i][j].strip() for i in range(len(data)) if data[i][j].strip()]
        if not vals: numeric.append(False); continue
        if any(k in header[j] for k in ("时间", "周期", "按天", "日期")): numeric.append(False); continue
        ok = sum(1 for v in vals if parse_num(v) is not None)
        numeric.append(ok/len(vals) >= 0.8)

    # 按表名复用；无则建表
    tid = list_tables().get(tname)
    if not tid:
        fields = [{"name": header[j], "type": "number" if numeric[j] else "text"} for j in range(ncol)]
        cr = lark(["base", "+table-create", "--base-token", BASE_TOKEN, "--name", tname,
                   "--fields", json.dumps(fields, ensure_ascii=False)])
        if not cr.get("ok"): print("  建表失败:", cr.get("error", {}).get("message", "")[:80]); return
        tid = list_tables().get(tname)
        cache[tname] = tid; save_cache(cache)
        print(f"  新建表 {tid}  字段{ncol} (数值列 {sum(numeric)})")
    else:
        n = clear_records(tid)
        print(f"  复用表 {tid}  清旧记录 {n}")

    # 组装记录行：数值列转 float，其余 str
    out_rows = []
    for c in data:
        row = []
        for j in range(ncol):
            if numeric[j]:
                v = parse_num(c[j]); row.append(v if v is not None else None)
            else:
                row.append(c[j].strip())
        out_rows.append(row)
    # 分批写入（上限200/批 + 限流）
    total = 0
    for i in range(0, len(out_rows), 200):
        chunk = out_rows[i:i+200]
        for attempt in range(4):
            wr = lark(["base", "+record-batch-create", "--base-token", BASE_TOKEN, "--table-id", tid,
                       "--json", json.dumps({"fields": header, "rows": chunk}, ensure_ascii=False)])
            if wr.get("ok"): total += len(chunk); break
            msg = wr.get("error", {}).get("message", "")
            if "limited" in msg: time.sleep(2)
            else: print("  写入失败:", msg[:80]); break
        time.sleep(0.8)
    print(f"  写入记录 {total}")

def main():
    cache = load_cache()
    only = sys.argv[1] if len(sys.argv) > 1 else None   # sheet_id / 表名 / 组名(fenshi|toufang|chanpin)
    for sid, colmax, tname, grp in SHEETS:
        if only and only not in (sid, tname, grp): continue
        sync_sheet(sid, colmax, tname, cache)
    print("\n同步完成。")

if __name__ == "__main__":
    main()
