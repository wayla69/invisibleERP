# -*- coding: utf-8 -*-
"""Render the Invisible ERP deck as a premium dark 16:9 PPTX with embedded Thai fonts."""
import os, sys
from slides import Slides
from pptx_lib import TEAL, CYAN, VIOLET, GOLD, GREEN, CORAL
from content import build_specs

AC = {"teal":TEAL,"cyan":CYAN,"violet":VIOLET,"gold":GOLD,"green":GREEN,"coral":CORAL}
def col(k, default=TEAL):
    return AC.get(k, default) if isinstance(k, str) else (k or default)

def conv_cards(cards):
    out = []
    for c in cards:
        c = list(c)
        if len(c) > 3:
            c[3] = col(c[3])
        out.append(tuple(c))
    return out

def conv_panel(p):
    heading, glyph, ac, bl = p
    return (heading, glyph, col(ac), bl)

def main():
    d = Slides()
    _here = os.path.dirname(os.path.abspath(__file__))
    _assets = os.path.join(_here, "assets")
    lw = os.path.join(_assets, "invisible-consulting-logo-white.png")
    ld = os.path.join(_assets, "invisible-consulting-logo-dark.png")
    if os.path.exists(lw): d.logo_white = lw
    if os.path.exists(ld): d.logo_dark = ld
    specs = build_specs()
    page = 0
    for sp in specs:
        t = sp["t"]
        acc = col(sp.get("accent"))
        if t == "cover":
            d.cover(sp["title"], sp["subtitle"], sp["tagline"])
        elif t == "agenda":
            page += 1; d.agenda(sp["items"], page)
        elif t == "divider":
            try: dnum = int(sp["num"])
            except Exception: dnum = 0
            d.divider(sp["num"], sp["title"], sp["subtitle"], dnum, acc)
        elif t == "bullets":
            page += 1
            d.bullets(sp["kicker"], sp["title"], sp["bullets"], page,
                      section=sp.get("section",""), intro=sp.get("intro"),
                      accent=acc, twocol=sp.get("twocol", False))
        elif t == "cards":
            page += 1
            d.cards(sp["kicker"], sp["title"], conv_cards(sp["cards"]), page,
                    section=sp.get("section",""), cols=sp.get("cols",3),
                    intro=sp.get("intro"), accent=acc)
        elif t == "stats":
            page += 1
            d.stats(sp["kicker"], sp["title"], sp["stats"], page,
                    section=sp.get("section",""), intro=sp.get("intro"),
                    footer_note=sp.get("footer"))
        elif t == "two_panel":
            page += 1
            d.two_panel(sp["kicker"], sp["title"], conv_panel(sp["left"]),
                        conv_panel(sp["right"]), page, section=sp.get("section",""), accent=acc)
        elif t == "mod_over":
            page += 1
            d.module_overview(sp["family"], sp["title"], sp["positioning"], sp["features"],
                              page, glyph=sp.get("glyph","●"), accent=acc, tag=sp.get("tag"))
        elif t == "mod_ctrl":
            page += 1
            d.module_controls(sp["family"], sp["title"], sp["controls"], sp["wow"],
                              sp["routes"], page, accent=acc)
        elif t == "compare":
            page += 1
            d.compare(sp["kicker"], sp["title"], sp["rows"], page, section=sp.get("section",""))
        elif t == "closing":
            d.closing(sp["title"], sp["subtitle"], sp["contacts"])
        else:
            raise SystemExit(f"unknown spec type: {t}")

    out = sys.argv[1] if len(sys.argv) > 1 else "Invisible-ERP-Presentation.pptx"
    d.save_embedded(out)
    print(f"wrote {out}  ({len(d.prs.slides.__iter__.__self__._sldIdLst)} slides)")

if __name__ == "__main__":
    main()
