#!/usr/bin/env python3
"""Draw the 70x70 manifest icons of all Tableau extensions and embed them in the .trex files.

Run from anywhere:  python3 tools/make_icons.py   (needs Pillow; safe to re-run)

For every extension it
  1. draws the icon at 4x (280x280) and downsamples to 70x70 with LANCZOS,
  2. saves <slug>/icons/trex-icon.png,
  3. replaces the <icon/>, <icon /> or <icon>...</icon> element of the manifest with
     <icon>BASE64</icon> (no data: prefix, no line breaks, as Tableau expects).

Add an icon for a new extension:
  - write a function  def glyph_myslug(d): ...  that draws on the ImageDraw `d` using the
    helpers below and coordinates in a 0..280 box (tile is the full canvas; keep ~50 px padding),
  - add a line to ICONS:  "my-slug": ("my-slug/my-manifest.trex", glyph_myslug),
  - run the script.
"""
import base64
import io
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 280  # working size (4x of 70)
NAVY = "#1F2A44"
WHITE = "#FFFFFF"
ACCENT = "#F26B4E"
FAINT = (255, 255, 255, 90)


def rr(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)


def glyph_kpi_card(d):
    rr(d, (50, 100, 190, 220), 16, WHITE)          # big number block
    rr(d, (72, 128, 168, 140), 6, NAVY)
    rr(d, (72, 160, 140, 192), 8, NAVY)
    d.polygon([(222, 120), (196, 164), (248, 164)], fill=ACCENT)  # up arrow head
    d.rectangle((215, 160, 229, 200), fill=ACCENT)


def glyph_kpi_card_multi(d):
    w, gap, x0 = 52, 12, 46
    for i in range(3):
        x = x0 + i * (w + gap)
        rr(d, (x, 80, x + w, 200), 12, WHITE)
        rr(d, (x + 10, 96, x + w - 10, 106), 4, NAVY)
        rr(d, (x + 10, 150, x + w - 10, 184), 6, ACCENT if i == 1 else NAVY)


def glyph_waterfall(d):
    # up, up, down, total
    spec = [(48, 150, 210, WHITE), (96, 100, 150, WHITE), (144, 100, 130, ACCENT), (192, 100, 210, WHITE)]
    for x, t, b, c in spec:
        rr(d, (x, t, x + 40, b), 8, c)


def glyph_line_chart(d):
    d.line((46, 214, 234, 214), fill=FAINT, width=8)
    pts = [(54, 180), (104, 118), (154, 150), (212, 74)]
    d.line(pts, fill=WHITE, width=14, joint="curve")
    for p in pts:
        d.ellipse((p[0] - 15, p[1] - 15, p[0] + 15, p[1] + 15), fill=ACCENT if p == pts[-1] else WHITE)


def glyph_bar_chart(d):
    for x, t, c in [(52, 140, WHITE), (112, 80, ACCENT), (172, 112, WHITE)]:
        rr(d, (x, t, x + 56, 218), 10, c)


def glyph_matrix_table(d):
    c, gap, x0 = 52, 12, 46
    hi = {(0, 0), (1, 1)}
    for r in range(3):
        for k in range(3):
            x, y = x0 + k * (c + gap), x0 + r * (c + gap)
            rr(d, (x, y, x + c, y + c), 9, ACCENT if (r, k) in hi else WHITE)


def glyph_data_lineage(d):
    nodes = [(66, 140), (140, 80), (140, 200), (214, 140)]
    for (x1, y1), (x2, y2) in [(nodes[0], nodes[1]), (nodes[0], nodes[2]),
                               (nodes[1], nodes[3]), (nodes[2], nodes[3])]:
        pts = []
        for i in range(25):
            t = i / 24
            s = t * t * (3 - 2 * t)  # smooth S curve
            pts.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * s))
        d.line(pts, fill=WHITE, width=10, joint="curve")
    for i, (x, y) in enumerate(nodes):
        rr(d, (x - 26, y - 20, x + 26, y + 20), 9, ACCENT if i == 1 else WHITE)


ICONS = {
    "kpi-card": ("kpi-card/kpiCard.trex", glyph_kpi_card),
    "kpi-card-multi": ("kpi-card-multi/kpiCardMulti.trex", glyph_kpi_card_multi),
    "waterfall": ("waterfall/waterfall.trex", glyph_waterfall),
    "line-chart": ("line-chart/line-chart.trex", glyph_line_chart),
    "bar-chart": ("bar-chart/bar-chart.trex", glyph_bar_chart),
    "matrix-table": ("matrix-table/matrix-table.trex", glyph_matrix_table),
    "data-lineage": ("data-lineage/data-lineage.trex", glyph_data_lineage),
}

ICON_RE = re.compile(r"<icon\s*/>|<icon>.*?</icon>", re.S)


def render(glyph):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    rr(d, (0, 0, S - 1, S - 1), round(S * 0.22), NAVY)
    glyph(d)
    return img.resize((70, 70), Image.LANCZOS)


def main():
    for slug, (trex, glyph) in ICONS.items():
        img = render(glyph)
        out = ROOT / slug / "icons" / "trex-icon.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        out.write_bytes(buf.getvalue())
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        p = ROOT / trex
        text = p.read_text(encoding="utf-8")
        new, n = ICON_RE.subn(lambda m: "<icon>" + b64 + "</icon>", text)
        assert n == 1, f"{trex}: expected one <icon> element, found {n}"
        p.write_text(new, encoding="utf-8")
        print(f"{slug}: {len(buf.getvalue())} bytes")


if __name__ == "__main__":
    main()
