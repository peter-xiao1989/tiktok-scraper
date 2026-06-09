#!/usr/bin/env python3
"""
渲染经营报告图(仪表盘风格 PNG)并发送到飞书群。
用法: python3 render_report.py <fenshi|toufang|chanpin> [--no-send]
数据直接读电子表格(与多维表同源),图片经 bot 发到游戏选品群。
"""
import json, subprocess, os, re, sys, time, tempfile

SPREADSHEET = "K8tgsrOpFhxjy3tgDHscJ5jonHh"
CHAT_ID = "oc_0d077d9ba6ce793a835b546bd9dbb9e6"   # 游戏选品群
BASE_URL = "https://wcnr1w3cariy.feishu.cn/base/YB8TbS45kaO1gesMtqlc8kpznEb"
ENV = {**os.environ, "PATH": os.environ["PATH"] + ":/Users/xiao/.npm-global/bin"}

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm

# 中文字体:mac 用 Hiragino Sans GB,linux(CI) 用 Noto Sans CJK
_names = set(f.name for f in fm.fontManager.ttflist)
for f in ["Hiragino Sans GB", "Noto Sans CJK SC", "Arial Unicode MS", "WenQuanYi Zen Hei", "STHeiti"]:
    if f in _names:
        plt.rcParams["font.family"] = f; break
plt.rcParams["axes.unicode_minus"] = False

C_BG, C_PANEL, C_BLUE, C_GREEN, C_ORANGE, C_RED, C_GRAY = \
    "#F5F6F8", "#FFFFFF", "#3370FF", "#34C724", "#FF8800", "#F54A45", "#646A73"


def lark(args, timeout=120):
    r = subprocess.run(["lark-cli", "--format", "json", "--as", "bot"] + args,
                       capture_output=True, text=True, env=ENV, timeout=timeout)
    raw = r.stdout or r.stderr or "{}"
    i = raw.find("{")
    try: return json.loads(raw[i:raw.rfind("}") + 1])
    except Exception: return {"ok": False, "raw": raw[:200]}


def csv_rows(sid, rng, tries=8):
    for _ in range(tries):
        d = lark(["sheets", "+csv-get", "--spreadsheet-token", SPREADSHEET,
                  "--sheet-id", sid, "--range", rng])
        if d.get("ok"):
            rows = d["data"]["annotated_csv"].strip().split("\n")
            out = []
            for r in rows:
                out.append(re.sub(r"^\[row=\d+\] ", "", r).split(","))
            return out
        time.sleep(4)
    raise RuntimeError(f"读取 {sid} 失败")


def fnum(s):
    s = str(s).strip().replace(",", "")
    pct = s.endswith("%")
    try:
        v = float(s.rstrip("%"))
        return v / 100 if pct else v
    except ValueError:
        return 0.0


def style_ax(ax):
    ax.set_facecolor(C_PANEL)
    for sp in ["top", "right"]: ax.spines[sp].set_visible(False)
    for sp in ["left", "bottom"]: ax.spines[sp].set_color("#DEE0E3")
    ax.tick_params(colors=C_GRAY, labelsize=9)
    ax.grid(axis="y", color="#EFF0F1", lw=0.8)
    ax.set_axisbelow(True)


def kpi(ax, label, value, color=C_BLUE):
    ax.axis("off")
    ax.add_patch(plt.Rectangle((0, 0), 1, 1, transform=ax.transAxes,
                 facecolor=C_PANEL, edgecolor="#DEE0E3", lw=1, zorder=0,
                 clip_on=False, joinstyle="round"))
    ax.text(0.5, 0.62, value, ha="center", va="center", fontsize=22,
            fontweight="bold", color=color, transform=ax.transAxes)
    ax.text(0.5, 0.22, label, ha="center", va="center", fontsize=10.5,
            color=C_GRAY, transform=ax.transAxes)


# ───────────────────────── 分时报告 ─────────────────────────
def render_fenshi(path):
    rows = csv_rows("dbGqhL", "A1:L200")
    hdr = rows[0]
    data = [r for r in rows[1:] if len(r) >= 12 and r[0].startswith("单素材")]
    upd = data[0][11] if data else ""
    # 按游戏聚合
    games = {}
    for r in data:
        g = r[2] or "?"
        games.setdefault(g, [0.0, 0.0, 0.0])     # 消耗, roas加权分子, 行数
        games[g][0] += fnum(r[8 - 4])            # E 消耗 -> idx4? 列:0类别1项目组2游戏3素材4消耗5ROAS...
    games = {}
    for r in data:
        g = r[2] or "?"
        a = games.setdefault(g, {"spend": 0.0, "roas_x": 0.0})
        sp = fnum(r[4]); a["spend"] += sp; a["roas_x"] += sp * fnum(r[5])
    tot = sum(v["spend"] for v in games.values())
    top = sorted(data, key=lambda r: -fnum(r[4]))[:10]

    fig = plt.figure(figsize=(12, 8.5), facecolor=C_BG)
    fig.suptitle("分时实时投放看板", x=0.06, y=0.97, ha="left",
                 fontsize=17, fontweight="bold", color="#1F2329")
    fig.text(0.06, 0.925, f"数据更新:{upd}   在投素材 {len(data)} 个", fontsize=10, color=C_GRAY)

    ax1 = fig.add_axes([0.06, 0.78, 0.27, 0.10]); kpi(ax1, "当日总消耗 ($)", f"{tot:,.2f}")
    ax2 = fig.add_axes([0.37, 0.78, 0.27, 0.10]); kpi(ax2, "在投游戏数", str(len(games)), C_GREEN)
    wro = sum(v["roas_x"] for v in games.values()) / tot if tot else 0
    ax3 = fig.add_axes([0.68, 0.78, 0.27, 0.10]); kpi(ax3, "加权 ROAS", f"{wro:.2%}", C_ORANGE)

    axg = fig.add_axes([0.06, 0.42, 0.40, 0.28]); style_ax(axg)
    gs = sorted(games.items(), key=lambda kv: -kv[1]["spend"])
    axg.bar([k for k, _ in gs], [v["spend"] for _, v in gs], color=C_BLUE, width=0.55)
    axg.set_title("各游戏消耗 ($)", fontsize=11, loc="left", color="#1F2329")

    axr = fig.add_axes([0.56, 0.42, 0.40, 0.28]); style_ax(axr)
    axr.bar([k for k, _ in gs], [(v["roas_x"] / v["spend"] if v["spend"] else 0) for _, v in gs],
            color=C_GREEN, width=0.55)
    axr.set_title("各游戏加权 ROAS", fontsize=11, loc="left", color="#1F2329")

    axt = fig.add_axes([0.22, 0.05, 0.74, 0.30]); style_ax(axt)
    names = [f"{i+1}. " + r[3][:20] + ("…" if len(r[3]) > 20 else "")
             for i, r in enumerate(top)][::-1]
    vals = [fnum(r[4]) for r in top][::-1]
    axt.barh(names, vals, color=C_ORANGE, height=0.6)
    axt.set_title("素材消耗 Top10 ($)", fontsize=11, loc="left", color="#1F2329")
    axt.tick_params(labelsize=8)

    fig.savefig(path, dpi=150, facecolor=C_BG); plt.close(fig)


# ───────────────────────── 投放报告 ─────────────────────────
def render_toufang(path):
    rows = csv_rows("kX0M0R", "A1:Z200")
    data = [r for r in rows[1:] if len(r) >= 8 and r[1].strip()]
    # 列: 0序号 1按天/统计周期? 读表头定位
    hdr = rows[0]
    ix = {h.strip(): i for i, h in enumerate(hdr)}
    c_day = ix.get("按天", ix.get("统计周期", 1)); c_grp = ix.get("项目组", 2)
    c_game = ix.get("游戏名称", 3); c_sp = ix.get("消耗", 4); c_roas = ix.get("广告收入 ROAS (TikTok)", 5)
    days = sorted({r[c_day] for r in data})
    latest = days[-1] if days else ""
    cur = [r for r in data if r[c_day] == latest]

    by_day = {}
    for r in data: by_day[r[c_day]] = by_day.get(r[c_day], 0) + fnum(r[c_sp])
    by_game = {}
    for r in cur:
        g = r[c_game] or "?"
        a = by_game.setdefault(g, {"sp": 0.0, "rx": 0.0})
        a["sp"] += fnum(r[c_sp]); a["rx"] += fnum(r[c_sp]) * fnum(r[c_roas])

    tot = sum(v["sp"] for v in by_game.values())
    fig = plt.figure(figsize=(12, 8), facecolor=C_BG)
    fig.suptitle("投放日报(产品维度)", x=0.06, y=0.97, ha="left",
                 fontsize=17, fontweight="bold", color="#1F2329")
    fig.text(0.06, 0.925, f"最新日期:{latest}", fontsize=10, color=C_GRAY)

    ax1 = fig.add_axes([0.06, 0.78, 0.27, 0.10]); kpi(ax1, f"{latest} 消耗 ($)", f"{tot:,.2f}")
    wro = sum(v["rx"] for v in by_game.values()) / tot if tot else 0
    ax2 = fig.add_axes([0.37, 0.78, 0.27, 0.10]); kpi(ax2, "加权 ROAS", f"{wro:.2%}", C_ORANGE)
    ax3 = fig.add_axes([0.68, 0.78, 0.27, 0.10]); kpi(ax3, "在投游戏数", str(len(by_game)), C_GREEN)

    axd = fig.add_axes([0.06, 0.42, 0.90, 0.28]); style_ax(axd)
    ds = sorted(by_day.items())[-21:]
    axd.plot([k[5:] for k, _ in ds], [v for _, v in ds], color=C_BLUE, lw=2, marker="o", ms=3.5)
    axd.fill_between(range(len(ds)), [v for _, v in ds], alpha=0.08, color=C_BLUE)
    axd.set_title("每日总消耗趋势 ($,近21天)", fontsize=11, loc="left", color="#1F2329")

    axg = fig.add_axes([0.06, 0.06, 0.40, 0.27]); style_ax(axg)
    gs = sorted(by_game.items(), key=lambda kv: -kv[1]["sp"])[:8]
    axg.bar([k[:10] for k, _ in gs], [v["sp"] for _, v in gs], color=C_BLUE, width=0.55)
    axg.set_title(f"{latest} 各游戏消耗 ($)", fontsize=11, loc="left", color="#1F2329")
    axg.tick_params(axis="x", labelsize=8, rotation=12)

    axr = fig.add_axes([0.56, 0.06, 0.40, 0.27]); style_ax(axr)
    axr.bar([k[:10] for k, _ in gs], [(v["rx"] / v["sp"] if v["sp"] else 0) for _, v in gs],
            color=C_GREEN, width=0.55)
    axr.set_title(f"{latest} 各游戏 ROAS", fontsize=11, loc="left", color="#1F2329")
    axr.tick_params(axis="x", labelsize=8, rotation=12)

    fig.savefig(path, dpi=150, facecolor=C_BG); plt.close(fig)


# ───────────────────────── 产品报告 ─────────────────────────
def render_chanpin(path):
    rows = csv_rows("wAsSso", "A1:H200")
    hdr = rows[0]; ix = {h.strip(): i for i, h in enumerate(hdr)}
    data = [r for r in rows[1:] if len(r) >= 7 and r[0].strip()]
    c_day, c_sp, c_rev = ix.get("统计周期", 0), ix.get("消耗", 1), ix.get("广告总收入", 2)
    c_csp, c_crev, c_roi = ix.get("累计消耗", 4), ix.get("累计收入", 5), ix.get("TT累计ROI", 6)
    c_new = ix.get("新增用户", 7)
    data.sort(key=lambda r: r[c_day])
    last = data[-1]

    fig = plt.figure(figsize=(12, 8), facecolor=C_BG)
    fig.suptitle("日经营数据汇总", x=0.06, y=0.97, ha="left",
                 fontsize=17, fontweight="bold", color="#1F2329")
    fig.text(0.06, 0.925, f"最新日期:{last[c_day]}", fontsize=10, color=C_GRAY)

    ax1 = fig.add_axes([0.06, 0.78, 0.21, 0.10]); kpi(ax1, "累计消耗 ($)", f"{fnum(last[c_csp]):,.0f}")
    ax2 = fig.add_axes([0.30, 0.78, 0.21, 0.10]); kpi(ax2, "累计收入 ($)", f"{fnum(last[c_crev]):,.0f}", C_GREEN)
    roi = fnum(last[c_roi]); roi_c = C_GREEN if roi >= 1 else C_RED
    ax3 = fig.add_axes([0.54, 0.78, 0.21, 0.10]); kpi(ax3, "TT累计ROI", f"{roi:.2f}", roi_c)
    ax4 = fig.add_axes([0.78, 0.78, 0.18, 0.10]); kpi(ax4, f"{last[c_day][5:]} 新增", f"{fnum(last[c_new]):,.0f}", C_ORANGE)

    days = [r[c_day][5:] for r in data][-30:]
    axm = fig.add_axes([0.06, 0.42, 0.90, 0.28]); style_ax(axm)
    axm.plot(days, [fnum(r[c_sp]) for r in data][-30:], color=C_BLUE, lw=2, marker="o", ms=3, label="消耗")
    axm.plot(days, [fnum(r[c_rev]) for r in data][-30:], color=C_GREEN, lw=2, marker="o", ms=3, label="广告总收入")
    axm.legend(frameon=False, fontsize=9, loc="upper left")
    axm.set_title("每日消耗 vs 收入 ($,近30天)", fontsize=11, loc="left", color="#1F2329")
    axm.tick_params(axis="x", labelsize=7.5, rotation=30)

    axr = fig.add_axes([0.06, 0.06, 0.42, 0.27]); style_ax(axr)
    axr.plot(days, [fnum(r[c_roi]) for r in data][-30:], color=C_ORANGE, lw=2, marker="o", ms=3)
    axr.axhline(1.0, color=C_RED, lw=1, ls="--", alpha=0.6)
    axr.set_title("TT累计ROI 走势(虚线=1.0)", fontsize=11, loc="left", color="#1F2329")
    axr.tick_params(axis="x", labelsize=7.5, rotation=30)

    axn = fig.add_axes([0.54, 0.06, 0.42, 0.27]); style_ax(axn)
    axn.bar(days, [fnum(r[c_new]) for r in data][-30:], color=C_BLUE, width=0.6)
    axn.set_title("每日新增用户", fontsize=11, loc="left", color="#1F2329")
    axn.tick_params(axis="x", labelsize=7.5, rotation=30)

    fig.savefig(path, dpi=150, facecolor=C_BG); plt.close(fig)


REPORTS = {
    "fenshi":  (render_fenshi,  "⏱ 分时实时投放看板(每2小时更新)"),
    "toufang": (render_toufang, "📈 投放日报"),
    "chanpin": (render_chanpin, "📊 产品经营日报"),
}

def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else "fenshi"
    send = "--no-send" not in sys.argv
    fn, caption = REPORTS[kind]
    out = os.path.join(tempfile.gettempdir(), f"report_{kind}.png")
    fn(out)
    print("已渲染:", out)
    if send:
        # 发图(在临时目录执行,--image 要求相对路径)
        d = lark(["im", "+messages-send", "--chat-id", CHAT_ID,
                  "--image", os.path.basename(out)], timeout=60) if False else None
        # lark-cli 限制 cwd 相对路径:切到临时目录执行
        r = subprocess.run(["lark-cli", "--format", "json", "--as", "bot",
                            "im", "+messages-send", "--chat-id", CHAT_ID,
                            "--image", os.path.basename(out)],
                           capture_output=True, text=True, env=ENV, cwd=tempfile.gettempdir())
        raw = r.stdout or r.stderr or "{}"; i = raw.find("{")
        ok = json.loads(raw[i:raw.rfind("}") + 1]).get("ok")
        print("发图:", ok)
        r2 = subprocess.run(["lark-cli", "--format", "json", "--as", "bot",
                             "im", "+messages-send", "--chat-id", CHAT_ID,
                             "--text", f"{caption}\n查看完整仪表盘: {BASE_URL}"],
                            capture_output=True, text=True, env=ENV)
        print("发说明:", json.loads((r2.stdout or "{}")[ (r2.stdout or "{}").find("{"):]).get("ok"))

if __name__ == "__main__":
    main()
