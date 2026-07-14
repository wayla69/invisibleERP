# -*- coding: utf-8 -*-
"""Render the Invisible ERP content as a LIGHT EDITORIAL A4 WHITEPAPER (portrait, flowing
document) — a deliberately different deliverable from the dark 16:9 PPTX slide deck.
Same content module, distinct visual system."""
import os, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Table, TableStyle, PageBreak, Flowable, KeepTogether,
                                NextPageTemplate, CondPageBreak)
from reportlab.lib.styles import ParagraphStyle
from content import build_specs

F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
if not os.path.isdir(F):
    F = os.path.expanduser("~/fonts")
_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
LOGO_WHITE = os.path.join(_ASSETS, "invisible-consulting-logo-white.png")
LOGO_DARK  = os.path.join(_ASSETS, "invisible-consulting-logo-dark.png")
LOGO_AR = 1.908  # width / height
pdfmetrics.registerFont(TTFont("Sarabun", f"{F}/Sarabun-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Sarabun-B", f"{F}/Sarabun-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Sarabun-L", f"{F}/Sarabun-Light.ttf"))
pdfmetrics.registerFont(TTFont("Kanit", f"{F}/Kanit-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Kanit-M", f"{F}/Kanit-Medium.ttf"))
pdfmetrics.registerFont(TTFont("Kanit-SB", f"{F}/Kanit-SemiBold.ttf"))
pdfmetrics.registerFont(TTFont("Kanit-B", f"{F}/Kanit-Bold.ttf"))
pdfmetrics.registerFontFamily("Sarabun", normal="Sarabun", bold="Sarabun-B")

# ── Light editorial palette ────────────────────────────────────────────────────
PAPER   = HexColor("#FBFAF6")   # warm off-white page
INK     = HexColor("#1C2333")   # deep ink
MUTED   = HexColor("#4E586E")   # secondary
FAINT   = HexColor("#8A93A5")   # tertiary
HAIR    = HexColor("#E4E1D8")   # hairline on paper
CARD    = HexColor("#FFFFFF")   # card surface
CARDLN  = HexColor("#E7E3D8")   # card border
PANEL   = HexColor("#F3F1EA")   # tinted panel
DARK    = HexColor("#141B2D")   # dark blocks (cover/divider band)
PAPER2  = HexColor("#F6F4ED")

TEAL    = HexColor("#0E8C79")
CYAN    = HexColor("#1E7FB8")
VIOLET  = HexColor("#6A54C2")
GOLD    = HexColor("#B5892B")
GREEN   = HexColor("#2E9366")
CORAL   = HexColor("#CF5245")
AC = {"teal":TEAL,"cyan":CYAN,"violet":VIOLET,"gold":GOLD,"green":GREEN,"coral":CORAL}
def col(k, d=TEAL): return AC.get(k, d) if isinstance(k, str) else (k or d)
def hx(c): return '#'+c.hexval()[2:]

PW, PH = A4
LM, RM, TMg, BM = 20*mm, 18*mm, 24*mm, 20*mm
CW = PW - LM - RM

# ── styles ─────────────────────────────────────────────────────────────────────
def S(name, **kw):
    base = dict(fontName="Sarabun", fontSize=10, leading=14, textColor=INK, wordWrap="CJK")
    base.update(kw); return ParagraphStyle(name, **base)

st_kicker = S("kick", fontName="Kanit-B", fontSize=8.5, textColor=TEAL, leading=11, spaceAfter=2)
st_h1     = S("h1", fontName="Kanit-B", fontSize=23, textColor=INK, leading=27, spaceAfter=4)
st_h2     = S("h2", fontName="Kanit-B", fontSize=16.5, textColor=INK, leading=20, spaceAfter=3)
st_h3     = S("h3", fontName="Kanit-SB", fontSize=11.5, textColor=INK, leading=14)
st_intro  = S("intro", fontSize=10.5, textColor=MUTED, leading=15, spaceAfter=4)
st_body   = S("body", fontSize=9.5, textColor=MUTED, leading=13.5)
st_bhead  = S("bhead", fontName="Sarabun-B", fontSize=10, textColor=INK, leading=14)
st_card_t = S("ct", fontName="Kanit-SB", fontSize=9.8, textColor=INK, leading=12)
st_card_d = S("cd", fontSize=8.3, textColor=MUTED, leading=11)
st_small  = S("sm", fontSize=8, textColor=FAINT, leading=10.5)
st_ctrl_c = S("cc", fontName="Sarabun-B", fontSize=8.6, textColor=TEAL, leading=11.5)
st_white_t= S("wt", fontName="Kanit-B", fontSize=30, textColor=colors.white, leading=34)


class HeaderMark(Flowable):
    """Zero-height flowable that updates the running header/section for later pages."""
    def __init__(self, holder, text): self.holder=holder; self.text=text; self.width=0; self.height=0
    def draw(self): self.holder["section"] = self.text

class HR(Flowable):
    def __init__(self, w, color=HAIR, weight=0.6, pad=2):
        self.w=w; self.color=color; self.weight=weight; self.height=pad*2
    def wrap(self, aw, ah): return (self.w, self.height)
    def draw(self):
        self.canv.setStrokeColor(self.color); self.canv.setLineWidth(self.weight)
        self.canv.line(0, self.height/2, self.w, self.height/2)

class AccentTick(Flowable):
    """A short thick accent underline (kicker rule)."""
    def __init__(self, color, w=16, weight=2.4):
        self.color=color; self.w=w; self.weight=weight; self.height=6
    def wrap(self, aw, ah): return (self.w, self.height)
    def draw(self):
        self.canv.setStrokeColor(self.color); self.canv.setLineWidth(self.weight)
        self.canv.line(0, 3, self.w, 3)

class Band(Flowable):
    """A filled color panel with text, used for section-divider numbers on paper."""
    def __init__(self, num, title, subtitle, accent):
        self.num=num; self.title=title; self.subtitle=subtitle; self.ac=accent
        self.width=CW; self.height=150*mm
    def wrap(self, aw, ah): return (CW, self.height)
    def draw(self):
        c=self.canv; h=self.height
        c.setFillColor(DARK); c.roundRect(0, 0, CW, h, 6, fill=1, stroke=0)
        c.setFillColor(self.ac); c.rect(0, 0, 5, h, fill=1, stroke=0)
        # big number
        c.setFillColor(self.ac); c.setFont("Kanit-B", 150)
        c.drawString(24, h-140, self.num)
        if os.path.exists(LOGO_WHITE):
            lw=120; lh=lw/LOGO_AR
            c.drawImage(LOGO_WHITE, CW-24-lw, h-30-lh, width=lw, height=lh, mask='auto', preserveAspectRatio=True, anchor='sw')
        c.setFillColor(self.ac); c.setFont("Kanit-B", 10)
        c.drawString(26, h-190, "SECTION")
        c.setFillColor(colors.white); c.setFont("Kanit-B", 30)
        # title may be long -> wrap manually
        _draw_wrapped(c, self.title, 26, h-230, CW-52, "Kanit-B", 30, 34, colors.white)
        c.setFillColor(HexColor("#AEB6C6"));
        _draw_wrapped(c, self.subtitle, 26, 60, CW-60, "Sarabun", 12, 17, HexColor("#AEB6C6"))

def _draw_wrapped(c, text, x, y, maxw, font, size, leading, color):
    c.setFont(font, size); c.setFillColor(color)
    words = text.split(" "); line=""; yy=y
    for w in words:
        test=(line+" "+w).strip()
        if c.stringWidth(test, font, size) > maxw and line:
            c.drawString(x, yy, line); yy-=leading; line=w
        else:
            line=test
    if line: c.drawString(x, yy, line)


# ── card/panel builders (Table-based) ──────────────────────────────────────────
def make_card(glyph, title, desc, accent, w, h=None):
    ac = col(accent)
    inner = [
        [Paragraph(f'<font name="Kanit-B" color="{hx(ac)}">{_esc(glyph)}</font>  '
                   f'<font name="Kanit-SB">{_esc(title)}</font>', st_card_t)],
        [Paragraph(_esc(desc), st_card_d)],
    ]
    t = Table(inner, colWidths=[w-14])
    t.setStyle(TableStyle([
        ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(0,0),0),("BOTTOMPADDING",(0,0),(0,0),3),
        ("TOPPADDING",(0,1),(0,1),0),("BOTTOMPADDING",(0,1),(-1,-1),0),
        ("VALIGN",(0,0),(-1,-1),"TOP"),
    ]))
    outer = Table([[t]], colWidths=[w])
    style = [("BACKGROUND",(0,0),(-1,-1),CARD),("BOX",(0,0),(-1,-1),0.6,CARDLN),
             ("LINEBEFORE",(0,0),(0,-1),2.4,ac),
             ("LEFTPADDING",(0,0),(-1,-1),8),("RIGHTPADDING",(0,0),(-1,-1),7),
             ("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7),
             ("VALIGN",(0,0),(-1,-1),"TOP")]
    if h: style.append(("MINROWHEIGHTS",(0,0),(0,0),h))
    outer.setStyle(TableStyle(style))
    return outer

def card_grid(cards, cols, rowh=None):
    w = (CW - (cols-1)*6) / cols
    cells = [make_card(c[0], c[1], c[2], c[3] if len(c)>3 else "teal", w, rowh) for c in cards]
    rows = []
    for i in range(0, len(cells), cols):
        row = cells[i:i+cols]
        while len(row) < cols: row.append("")
        rows.append(row)
    cw = [w]*cols
    # interleave gap columns
    data=[]; colw=[]
    for r in rows:
        newr=[]
        for j,cell in enumerate(r):
            newr.append(cell)
            if j < cols-1: newr.append("")
        data.append(newr)
    for j in range(cols):
        colw.append(w)
        if j < cols-1: colw.append(6)
    t = Table(data, colWidths=colw)
    ts=[("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3),
        ("VALIGN",(0,0),(-1,-1),"TOP")]
    t.setStyle(TableStyle(ts))
    return t

def bullet_list(items, accent, headcolor=INK):
    ac = col(accent)
    rows=[]
    for b in items:
        if isinstance(b,(list,tuple)): head, desc = b[0], (b[1] if len(b)>1 else None)
        else: head, desc = b, None
        dot = Paragraph(f'<font color="{hx(ac)}">●</font>', S("d", fontSize=7))
        if desc:
            txt = f'<font name="Sarabun-B">{_esc(head)}</font>  <font color="{hx(MUTED)}">{_esc(desc)}</font>'
        else:
            txt = f'<font name="Sarabun-B">{_esc(head)}</font>'
        rows.append([dot, Paragraph(txt, S("bl", fontSize=9.3, textColor=INK, leading=13))])
    t = Table(rows, colWidths=[10, CW-10])
    t.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),2.5),("BOTTOMPADDING",(0,0),(-1,-1),2.5),
        ("VALIGN",(0,0),(0,0),"TOP"),("VALIGN",(0,1),(-1,-1),"TOP")]))
    return t

def two_col_bullets(items, accent):
    ac = col(accent); n=len(items); half=(n+1)//2
    def mini(sub):
        rows=[]
        for b in sub:
            head, desc = (b[0], b[1] if len(b)>1 else None) if isinstance(b,(list,tuple)) else (b,None)
            dot=Paragraph(f'<font color="{hx(ac)}">●</font>', S("d",fontSize=7))
            txt=f'<font name="Sarabun-B">{_esc(head)}</font>' + (f'  <font color="{hx(MUTED)}">{_esc(desc)}</font>' if desc else "")
            rows.append([dot, Paragraph(txt, S("bl",fontSize=9,leading=12.5))])
        colw=[9,(CW-24)/2-9]
        t=Table(rows,colWidths=colw)
        t.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
            ("TOPPADDING",(0,0),(-1,-1),2.5),("BOTTOMPADDING",(0,0),(-1,-1),2.5),("VALIGN",(0,0),(-1,-1),"TOP")]))
        return t
    outer=Table([[mini(items[:half]),"",mini(items[half:])]], colWidths=[(CW-24)/2,24,(CW-24)/2])
    outer.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),("VALIGN",(0,0),(-1,-1),"TOP")]))
    return outer

def panel(heading, glyph, accent, bullets, w):
    ac=col(accent)
    head=Paragraph(f'<font name="Kanit-B" color="{hx(ac)}">{_esc(glyph)}</font>  '
                   f'<font name="Kanit-SB">{_esc(heading)}</font>', S("ph",fontName="Kanit-SB",fontSize=10.5,leading=13))
    rows=[[head]]
    for b in bullets:
        head_t, desc = (b[0], b[1] if len(b)>1 else None) if isinstance(b,(list,tuple)) else (b,None)
        txt=f'<font color="{hx(ac)}">●</font>  <font name="Sarabun-B">{_esc(head_t)}</font>'+(f'  <font color="{hx(MUTED)}">{_esc(desc)}</font>' if desc else "")
        rows.append([Paragraph(txt, S("pb",fontSize=8.6,leading=12))])
    t=Table(rows,colWidths=[w-16])
    t.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(0,0),0),("BOTTOMPADDING",(0,0),(0,0),5),
        ("TOPPADDING",(0,1),(-1,-1),1.5),("BOTTOMPADDING",(0,1),(-1,-1),1.5),("VALIGN",(0,0),(-1,-1),"TOP")]))
    outer=Table([[t]],colWidths=[w])
    outer.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),PANEL),("BOX",(0,0),(-1,-1),0.6,CARDLN),
        ("LINEABOVE",(0,0),(-1,0),2.2,ac),
        ("LEFTPADDING",(0,0),(-1,-1),9),("RIGHTPADDING",(0,0),(-1,-1),8),
        ("TOPPADDING",(0,0),(-1,-1),8),("BOTTOMPADDING",(0,0),(-1,-1),8),("VALIGN",(0,0),(-1,-1),"TOP")]))
    return outer

def _esc(s):
    return (str(s).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;"))


# ── header/footer painters ──────────────────────────────────────────────────────
def make_onpage(holder):
    def onpage(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(PAPER); canvas.rect(0,0,PW,PH,fill=1,stroke=0)
        # top accent hairline
        canvas.setFillColor(TEAL); canvas.rect(0, PH-4, PW, 4, fill=1, stroke=0)
        # left margin accent tick
        canvas.setStrokeColor(HAIR); canvas.setLineWidth(0.5)
        canvas.line(LM, BM-6, PW-RM, BM-6)
        # header
        canvas.setFont("Kanit-B", 9); canvas.setFillColor(INK)
        canvas.drawString(LM, PH-16, "Invisible ERP")
        canvas.setFont("Sarabun", 8.5); canvas.setFillColor(FAINT)
        sec = holder.get("section","")
        canvas.drawRightString(PW-RM, PH-16, sec)
        # footer
        canvas.setFont("Sarabun", 8); canvas.setFillColor(FAINT)
        canvas.drawString(LM, BM-14, "ระบบบริหารธุรกิจอัจฉริยะครบวงจร")
        canvas.setFont("Kanit-B", 9); canvas.setFillColor(TEAL)
        canvas.drawRightString(PW-RM, BM-14, f"{doc.page:02d}")
        canvas.restoreState()
    return onpage

def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(DARK); canvas.rect(0,0,PW,PH,fill=1,stroke=0)
    canvas.setFillColor(TEAL); canvas.rect(0, PH-8, PW, 8, fill=1, stroke=0)
    canvas.setFillColor(VIOLET); canvas.rect(0, 0, PW, 8, fill=1, stroke=0)
    # brand — Invisible Consulting logo (developer)
    if os.path.exists(LOGO_WHITE):
        lw = 150; lh = lw/LOGO_AR
        canvas.drawImage(LOGO_WHITE, LM, PH-40-lh, width=lw, height=lh, mask='auto', preserveAspectRatio=True, anchor='sw')
    else:
        canvas.setStrokeColor(TEAL); canvas.setLineWidth(2); canvas.roundRect(LM, PH-70, 34, 34, 8, fill=0, stroke=1)
        canvas.setFillColor(TEAL); canvas.setFont("Kanit-B", 22); canvas.drawCentredString(LM+17, PH-63, "i")
        canvas.setFillColor(colors.white); canvas.setFont("Kanit-B", 16); canvas.drawString(LM+44, PH-58, "Invisible")
    canvas.setFillColor(HexColor("#9AA6BD")); canvas.setFont("Sarabun",9)
    canvas.drawString(LM, PH-134, "V2 · Enterprise Suite · เอกสารสรุประบบ")
    canvas.restoreState()


# ── build document ───────────────────────────────────────────────────────────
def build(out):
    holder={"section":""}
    doc = BaseDocTemplate(out, pagesize=A4, leftMargin=LM, rightMargin=RM,
                          topMargin=TMg, bottomMargin=BM, title="Invisible ERP — สรุประบบ",
                          author="Invisible ERP")
    frame = Frame(LM, BM, CW, PH-TMg-BM, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body = PageTemplate(id="body", frames=[frame], onPage=make_onpage(holder))
    coverT = PageTemplate(id="cover", frames=[Frame(LM, BM, CW, PH-TMg-BM)], onPage=cover_page)
    doc.addPageTemplates([coverT, body])

    E=[]
    specs = build_specs()
    for i, sp in enumerate(specs):
        t=sp["t"]; acc=col(sp.get("accent"))
        if t=="cover":
            E += cover_flow(sp)
            E.append(NextPageTemplate("body")); E.append(PageBreak())
        elif t=="agenda":
            E += agenda_flow(sp, holder)
        elif t=="divider":
            E.append(HeaderMark(holder, sp["title"]))
            E.append(CondPageBreak(160*mm))
            E.append(Spacer(1, 6*mm))
            E.append(Band(sp["num"], sp["title"], sp["subtitle"], acc))
            E.append(PageBreak())
        elif t=="bullets":
            E += header_block(sp, holder)
            if sp.get("intro"): E.append(Paragraph(_esc(sp["intro"]), st_intro)); E.append(Spacer(1,2*mm))
            E.append(two_col_bullets(sp["bullets"], acc) if sp.get("twocol") else bullet_list(sp["bullets"], acc))
            E.append(Spacer(1, 5*mm))
        elif t=="cards":
            E += header_block(sp, holder)
            if sp.get("intro"): E.append(Paragraph(_esc(sp["intro"]), st_intro)); E.append(Spacer(1,1.5*mm))
            E.append(card_grid(sp["cards"], sp.get("cols",3)))
            E.append(Spacer(1, 5*mm))
        elif t=="stats":
            E += header_block(sp, holder)
            if sp.get("intro"): E.append(Paragraph(_esc(sp["intro"]), st_intro)); E.append(Spacer(1,1.5*mm))
            E.append(stats_flow(sp["stats"]))
            if sp.get("footer"):
                E.append(Spacer(1,3*mm))
                E.append(Paragraph(f'<font color="{hx(TEAL)}">▎</font> <i>{_esc(sp["footer"])}</i>', st_body))
            E.append(Spacer(1, 5*mm))
        elif t=="two_panel":
            E += header_block(sp, holder)
            w=(CW-8)/2
            lp=panel(sp["left"][0],sp["left"][1],sp["left"][2],sp["left"][3],w)
            rp=panel(sp["right"][0],sp["right"][1],sp["right"][2],sp["right"][3],w)
            tb=Table([[lp,"",rp]],colWidths=[w,8,w])
            tb.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),
                ("RIGHTPADDING",(0,0),(-1,-1),0),("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0)]))
            E.append(tb); E.append(Spacer(1,5*mm))
        elif t=="mod_over":
            E += mod_over_flow(sp, holder)
        elif t=="mod_ctrl":
            E += mod_ctrl_flow(sp, holder)
        elif t=="compare":
            E += header_block(sp, holder)
            E.append(compare_flow(sp["rows"]))
            E.append(Spacer(1,5*mm))
        elif t=="closing":
            E.append(HeaderMark(holder, "สรุป"))
            E += closing_flow(sp)
    doc.build(E)
    print(f"wrote {out}")

# ── flow builders ───────────────────────────────────────────────────────────────
def header_block(sp, holder, big=False):
    out=[]
    sec = sp.get("section")
    if sec: out.append(HeaderMark(holder, sec))
    if sp.get("kicker"):
        out.append(AccentTick(col(sp.get("accent"))))
        out.append(Paragraph(_esc(sp["kicker"]).upper(), st_kicker))
    out.append(Paragraph(_esc(sp["title"]), st_h1 if big else st_h2))
    out.append(HR(CW, HAIR, 0.6, 3)); out.append(Spacer(1, 2*mm))
    return out

def cover_flow(sp):
    out=[Spacer(1, 74*mm)]
    out.append(AccentTick(TEAL, 22, 3))
    out.append(Paragraph(_esc(sp.get("kicker","ระบบบริหารธุรกิจอัจฉริยะครบวงจร")).upper() if sp.get("kicker") else "ระบบบริหารธุรกิจอัจฉริยะครบวงจร",
                         ParagraphStyle("ck",fontName="Kanit-B",fontSize=10,textColor=TEAL,leading=14,spaceAfter=6)))
    out.append(Paragraph("Invisible ERP", ParagraphStyle("ct",fontName="Kanit-B",fontSize=46,textColor=colors.white,leading=50,spaceAfter=10)))
    out.append(Paragraph(_esc(sp["subtitle"]), ParagraphStyle("cs",fontName="Sarabun",fontSize=13,textColor=HexColor("#C4CBD8"),leading=19,wordWrap="CJK",spaceAfter=14)))
    out.append(Paragraph(f'<font color="{hx(TEAL)}">▎</font>  <i><font color="#FFFFFF">{_esc(sp["tagline"])}</font></i>',
                         ParagraphStyle("ctag",fontName="Sarabun",fontSize=12,textColor=colors.white,leading=16,wordWrap="CJK")))
    out.append(Spacer(1, 8*mm))
    out.append(Paragraph('<font color="#8A93A5">พัฒนาโดย </font><font name="Kanit-B" color="#C4CBD8">Invisible Consulting</font>',
                         ParagraphStyle("cred",fontName="Sarabun",fontSize=11,textColor=HexColor("#C4CBD8"),leading=14)))
    return out

def agenda_flow(sp, holder):
    out=[HeaderMark(holder,"สารบัญ")]
    out.append(AccentTick(TEAL)); out.append(Paragraph("สารบัญ · AGENDA", st_kicker))
    out.append(Paragraph("สิ่งที่คุณจะได้เห็นในเอกสารฉบับนี้", st_h1))
    out.append(HR(CW,HAIR,0.6,3)); out.append(Spacer(1,4*mm))
    rows=[]
    for j,(num,ti,de) in enumerate(sp["items"]):
        ac=list(AC.values())[j%6]
        numcell=Paragraph(f'<font name="Kanit-B" color="{hx(ac)}" size="15">{num}</font>', S("n",leading=18))
        txt=Paragraph(f'<font name="Kanit-SB" size="12">{_esc(ti)}</font><br/><font color="{hx(FAINT)}" size="9">{_esc(de)}</font>', S("t",leading=14))
        rows.append([numcell, txt])
    t=Table(rows,colWidths=[16,CW-16])
    t.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),("VALIGN",(0,0),(-1,-1),"TOP"),
        ("LINEBELOW",(0,0),(-1,-2),0.5,HAIR)]))
    out.append(t); out.append(PageBreak())
    return out

def stats_flow(stats):
    n=len(stats); w=(CW-(n-1)*6)/n
    cells=[]
    for j,(num,label,sub) in enumerate(stats):
        ac=list(AC.values())[j%6]
        inner=[[Paragraph(f'<font name="Kanit-B" size="30" color="{hx(ac)}">{_esc(num)}</font>', S("num",leading=32))],
               [Paragraph(f'<font name="Kanit-SB" size="10.5">{_esc(label)}</font>', S("lab",leading=13))],
               [Paragraph(_esc(sub), st_small)]]
        it=Table(inner,colWidths=[w-16])
        it.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
            ("TOPPADDING",(0,0),(0,0),0),("BOTTOMPADDING",(0,0),(0,0),4),("TOPPADDING",(0,1),(0,1),0),
            ("BOTTOMPADDING",(0,1),(0,1),2),("TOPPADDING",(0,2),(0,2),0),("VALIGN",(0,0),(-1,-1),"TOP")]))
        ot=Table([[it]],colWidths=[w])
        ot.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),CARD),("BOX",(0,0),(-1,-1),0.6,CARDLN),
            ("LINEABOVE",(0,0),(-1,0),2.4,ac),
            ("LEFTPADDING",(0,0),(-1,-1),10),("RIGHTPADDING",(0,0),(-1,-1),8),
            ("TOPPADDING",(0,0),(-1,-1),10),("BOTTOMPADDING",(0,0),(-1,-1),10),("VALIGN",(0,0),(-1,-1),"TOP")]))
        cells.append(ot)
    data=[[]]; colw=[]
    for j,c in enumerate(cells):
        data[0].append(c)
        if j<n-1: data[0].append("");
    for j in range(n):
        colw.append(w)
        if j<n-1: colw.append(6)
    t=Table(data,colWidths=colw)
    t.setStyle(TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),("VALIGN",(0,0),(-1,-1),"TOP")]))
    return t

def mod_over_flow(sp, holder):
    ac=col(sp.get("accent")); out=[HeaderMark(holder, sp["family"])]
    out.append(CondPageBreak(120*mm))
    # header row: family kicker + title + tag
    out.append(AccentTick(ac))
    tagtxt = f'   <font name="Kanit-B" color="{hx(ac)}" size="8">[{_esc(sp["tag"])}]</font>' if sp.get("tag") else ""
    out.append(Paragraph(f'<font name="Kanit-B" color="{hx(ac)}">{_esc(sp["family"]).upper()}</font>{tagtxt}', st_kicker))
    out.append(Paragraph(_esc(sp["title"]), st_h2))
    # positioning box
    pos=Table([[Paragraph(f'<font name="Kanit-B" color="{hx(ac)}">บทบาท</font>  '
                          f'<font color="{hx(INK)}">{_esc(sp["positioning"])}</font>',
                          S("pos",fontSize=9.3,leading=13))]], colWidths=[CW])
    pos.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),PANEL),("LINEBEFORE",(0,0),(0,-1),3,ac),
        ("LEFTPADDING",(0,0),(-1,-1),10),("RIGHTPADDING",(0,0),(-1,-1),10),
        ("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)]))
    out.append(pos); out.append(Spacer(1,3*mm))
    # features as 2-col cards
    feats=[("▸", f[0], f[1], sp.get("accent")) for f in sp["features"]]
    out.append(card_grid(feats, 2))
    out.append(Spacer(1,4*mm))
    return out

def mod_ctrl_flow(sp, holder):
    ac=col(sp.get("accent")); out=[HeaderMark(holder, sp["family"])]
    out.append(CondPageBreak(120*mm))
    out.append(Paragraph(f'<font name="Kanit-B" color="{hx(ac)}" size="8.5">{_esc(sp["family"]).upper()}  ·  ต่อ</font>', st_kicker))
    out.append(Paragraph(_esc(sp["title"]), st_h2)); out.append(Spacer(1,1*mm))
    w=(CW-8)/2
    # controls panel
    crows=[[Paragraph(f'<font color="{hx(CORAL)}">⛨</font>  <font name="Kanit-SB">การควบคุม &amp; แบ่งแยกหน้าที่ (SoD)</font>', S("h",fontName="Kanit-SB",fontSize=10,leading=13))]]
    import re
    for c in sp["controls"]:
        m=re.match(r"^([A-Z]{2,6}-[0-9A-Za-z/]+)\s+(.*)$", c)
        if m: txt=f'<font color="{hx(CORAL)}">●</font>  <font name="Sarabun-B" color="{hx(TEAL)}">{_esc(m.group(1))}</font>  <font color="{hx(MUTED)}">{_esc(m.group(2))}</font>'
        else: txt=f'<font color="{hx(CORAL)}">●</font>  <font color="{hx(MUTED)}">{_esc(c)}</font>'
        crows.append([Paragraph(txt, S("cb",fontSize=8.4,leading=11.5))])
    ct=Table(crows,colWidths=[w-16]); ct.setStyle(_panelstyle())
    cp=Table([[ct]],colWidths=[w]); cp.setStyle(_panelbox(CORAL))
    # wow panel
    wrows=[[Paragraph(f'<font color="{hx(GOLD)}">★</font>  <font name="Kanit-SB">จุดเด่นที่เหนือคู่แข่ง</font>', S("h",fontName="Kanit-SB",fontSize=10,leading=13))]]
    for wv in sp["wow"]:
        wrows.append([Paragraph(f'<font color="{hx(GOLD)}">●</font>  <font color="{hx(INK)}">{_esc(wv)}</font>', S("wb",fontSize=8.5,leading=11.7))])
    wt=Table(wrows,colWidths=[w-16]); wt.setStyle(_panelstyle())
    wp=Table([[wt]],colWidths=[w]); wp.setStyle(_panelbox(GOLD))
    tb=Table([[cp,"",wp]],colWidths=[w,8,w])
    tb.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),0),
        ("RIGHTPADDING",(0,0),(-1,-1),0),("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0)]))
    out.append(tb); out.append(Spacer(1,2.5*mm))
    # routes
    rt=Table([[Paragraph(f'<font name="Kanit-B" color="{hx(ac)}" size="8.5">หน้าจอหลัก</font>   '
                         f'<font color="{hx(MUTED)}" size="9">{_esc("   ".join(sp["routes"]))}</font>', S("r",leading=12))]],colWidths=[CW])
    rt.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),PAPER2),("BOX",(0,0),(-1,-1),0.5,CARDLN),
        ("LEFTPADDING",(0,0),(-1,-1),9),("RIGHTPADDING",(0,0),(-1,-1),9),
        ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)]))
    out.append(rt); out.append(Spacer(1,5*mm))
    return out

def _panelstyle():
    return TableStyle([("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0),
        ("TOPPADDING",(0,0),(0,0),0),("BOTTOMPADDING",(0,0),(0,0),5),
        ("TOPPADDING",(0,1),(-1,-1),2),("BOTTOMPADDING",(0,1),(-1,-1),2),("VALIGN",(0,0),(-1,-1),"TOP")])
def _panelbox(ac):
    return TableStyle([("BACKGROUND",(0,0),(-1,-1),CARD),("BOX",(0,0),(-1,-1),0.6,CARDLN),
        ("LINEABOVE",(0,0),(-1,0),2,ac),
        ("LEFTPADDING",(0,0),(-1,-1),9),("RIGHTPADDING",(0,0),(-1,-1),8),
        ("TOPPADDING",(0,0),(-1,-1),8),("BOTTOMPADDING",(0,0),(-1,-1),8),("VALIGN",(0,0),(-1,-1),"TOP")])

def compare_flow(rows):
    data=[[Paragraph('<font name="Kanit-B" size="10">ความสามารถ</font>', S("h",leading=13)),
           Paragraph(f'<font name="Kanit-B" size="10" color="{hx(TEAL)}">● Invisible ERP</font>', S("h",leading=13,alignment=TA_CENTER)),
           Paragraph(f'<font name="Kanit-B" size="10" color="{hx(FAINT)}">ERP ทั่วไป</font>', S("h",leading=13,alignment=TA_CENTER))]]
    for feat,ours,theirs in rows:
        data.append([Paragraph(f'<font name="Sarabun-B" size="9.3">{_esc(feat)}</font>', S("f",leading=12)),
                     Paragraph(f'<font color="{hx(GREEN)}">✔</font>  <font size="8.6">{_esc(ours)}</font>', S("o",leading=12,alignment=TA_CENTER)),
                     Paragraph(f'<font color="{hx(CORAL)}">✕</font>  <font color="{hx(FAINT)}" size="8.4">{_esc(theirs)}</font>', S("t",leading=12,alignment=TA_CENTER))])
    c0=CW*0.40; c1=CW*0.32; c2=CW*0.28
    t=Table(data,colWidths=[c0,c1,c2])
    style=[("VALIGN",(0,0),(-1,-1),"MIDDLE"),
           ("BACKGROUND",(0,0),(-1,0),PANEL),
           ("LEFTPADDING",(0,0),(-1,-1),8),("RIGHTPADDING",(0,0),(-1,-1),8),
           ("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7),
           ("LINEBELOW",(0,0),(-1,-1),0.5,HAIR),("BOX",(0,0),(-1,-1),0.6,CARDLN),
           ("LINEAFTER",(0,0),(0,-1),0.5,HAIR),("LINEAFTER",(1,0),(1,-1),0.5,HAIR)]
    for r in range(1,len(data)):
        if r%2==0: style.append(("BACKGROUND",(0,r),(-1,r),PAPER2))
    t.setStyle(TableStyle(style))
    return t

def closing_flow(sp):
    from reportlab.platypus import Image as RLImage
    out=[Spacer(1, 20*mm)]
    if os.path.exists(LOGO_DARK):
        lw=44*mm; lh=lw/LOGO_AR
        img=RLImage(LOGO_DARK, width=lw, height=lh); img.hAlign="LEFT"
        out.append(img); out.append(Spacer(1, 8*mm))
    out.append(AccentTick(TEAL,22,3))
    out.append(Paragraph("ก้าวต่อไปกับ INVISIBLE ERP", ParagraphStyle("k",fontName="Kanit-B",fontSize=10,textColor=TEAL,leading=14,spaceAfter=6)))
    out.append(Paragraph(_esc(sp["title"]), ParagraphStyle("t",fontName="Kanit-B",fontSize=30,textColor=INK,leading=34,spaceAfter=8)))
    out.append(Paragraph(_esc(sp["subtitle"]), ParagraphStyle("s",fontName="Sarabun",fontSize=12,textColor=MUTED,leading=18,wordWrap="CJK",spaceAfter=10)))
    out.append(HR(CW,HAIR,0.6,3)); out.append(Spacer(1,4*mm))
    for label,val in sp["contacts"]:
        out.append(Paragraph(f'<font color="{hx(TEAL)}">●</font>  <font color="{hx(MUTED)}">{_esc(label)}</font>  <font name="Sarabun-B">{_esc(val)}</font>',
                             S("c",fontSize=11,leading=18)))
    return out

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv)>1 else "Invisible-ERP-Whitepaper.pdf"
    build(out)
