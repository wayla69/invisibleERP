# -*- coding: utf-8 -*-
"""High-level slide templates for the Invisible ERP deck. Built on pptx_lib.Deck."""
from pptx_lib import (Deck, PP_ALIGN, MSO_ANCHOR, HEAD, BODY,
                      BG, BG2, CARD, CARD2, STROKE, INK, MUTED, FAINT,
                      TEAL, CYAN, VIOLET, GOLD, CORAL, GREEN, ACCENTS,
                      INKSOFT, PANEL_DK, TINTS)

MX = 0.72   # left margin

# map an accent RGBColor to its light tint (for card fills on white)
def tint_of(ac):
    for k, v in {'teal':TEAL,'cyan':CYAN,'violet':VIOLET,'gold':GOLD,'green':GREEN,'coral':CORAL}.items():
        if v == ac:
            return TINTS[k]
    return CARD2

class Slides(Deck):
    # ────────────────────────────────────────────────────────────────────────
    def cover(self, title, subtitle, tagline, kicker="ระบบบริหารธุรกิจอัจฉริยะครบวงจร",
              credit="พัฒนาโดย", suite="Enterprise Business Platform"):
        s = self.slide(BG)
        # decorative pastel field on the right (soft, layered)
        p = self.rect(s, 9.5, -1.8, 6.6, 7.2, color=TINTS['teal'], radius=0.5)
        p = self.rect(s, 11.0, 3.4, 5.2, 5.2, color=TINTS['violet'], radius=0.5)
        p = self.rect(s, 10.2, 1.2, 2.9, 2.9, color=TINTS['gold'], radius=0.5)
        # accent rules
        self.rect(s, 0, 0, 13.333, 0.09, color=TEAL)
        self.rect(s, MX, 7.02, 3.4, 0.045, color=TEAL)
        # brand mark
        if self.logo_dark:
            self.pic(s, self.logo_dark, MX, 0.80, 2.15)
        else:
            self.text(s, MX, 0.9, 8, 0.6, [[("Invisible", HEAD, 22, INK, True, False),
                                            (" ERP", HEAD, 22, TEAL, True, False)]])
        self.kicker(s, MX, 3.25, kicker)
        self.text(s, MX, 3.5, 11.0, 2.0, [self.para(title, HEAD, 54, INK, bold=True)], leading=0.98)
        self.text(s, MX, 5.35, 9.6, 0.9, [self.para(subtitle, BODY, 18, MUTED)], leading=1.28)
        self.text(s, MX, 6.6, 11.4, 0.5, [[("▎  ", BODY, 15, TEAL, True, False),
                                           (tagline, BODY, 14.5, INKSOFT, False, False)]])
        self.text(s, MX, 7.12, 11.4, 0.35, [[(credit + "  ", BODY, 11, FAINT, False, False),
                                             ("Invisible Consulting", HEAD, 11, MUTED, True, False)]])
        return s

    # ── agenda / TOC ─────────────────────────────────────────────────────────
    def agenda(self, items, idx, kicker="สารบัญ", title="ภาพรวมของการนำเสนอ"):
        s = self.slide(BG)
        self.corner_accent(s)
        self.kicker(s, MX, 0.75, kicker)
        self.text(s, MX, 0.98, 11, 0.8, [self.para(title, HEAD, 30, INK, bold=True)])
        top = 2.05; colw = 5.9; rowh = 0.86
        for i, (num, t, d) in enumerate(items):
            col = i // 6; row = i % 6
            x = MX + col*(colw+0.5); y = top + row*rowh
            ac = ACCENTS[i % len(ACCENTS)]
            self.rect(s, x, y, 0.52, 0.52, color=None, line=ac, line_w=1.4, radius=0.28)
            self.text(s, x, y-0.02, 0.52, 0.52, [self.para(num, HEAD, 16, ac, bold=True)],
                      align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
            self.text(s, x+0.72, y-0.04, colw-0.8, 0.4, [self.para(t, HEAD, 15.5, INK, bold=True)])
            self.text(s, x+0.72, y+0.34, colw-0.8, 0.4, [self.para(d, BODY, 11, FAINT)])
        self.pagefoot(s, idx)
        return s

    # ── section divider ───────────────────────────────────────────────────────
    def divider(self, number, title, subtitle, idx, accent=TEAL, label="SECTION"):
        s = self.slide(BG)
        tint = tint_of(accent)
        # large pastel field on the right
        self.rect(s, 8.7, 0, 4.633, 7.5, color=tint)
        self.rect(s, 0, 0, 0.18, 7.5, color=accent)
        if self.logo_dark:
            self.pic(s, self.logo_dark, 10.95, 0.62, 1.9)
        # oversized numeral
        self.text(s, MX, 1.15, 7.5, 3.2, [self.para(number, HEAD, 168, accent, bold=True)], leading=0.9)
        self.kicker(s, MX+0.08, 4.55, label, accent)
        self.text(s, MX+0.02, 4.78, 8.0, 1.3, [self.para(title, HEAD, 38, INK, bold=True)], leading=1.0)
        self.text(s, MX+0.06, subtitle_y(title), 7.6, 1.2,
                  [self.para(subtitle, BODY, 15.5, MUTED)], leading=1.32)
        self.text(s, 11.0, 6.95, 1.9, 0.4, [self.para(f"{idx:02d}", HEAD, 12, accent, bold=True)],
                  align=PP_ALIGN.RIGHT)
        return s

    # ── generic content: kicker + title + intro + bullets ──────────────────────
    def bullets(self, kicker, title, bullets, idx, section="", intro=None, accent=TEAL, twocol=False):
        s = self.slide(BG)
        self.corner_accent(s)
        self._head(s, kicker, title, accent)
        y0 = 2.6 if intro else 1.95
        if intro:
            self.text(s, MX, 1.74, 11.9, 0.8, [self.para(intro, BODY, 14, MUTED)], leading=1.25)
        if twocol:
            half = (len(bullets)+1)//2
            self._bullet_col(s, bullets[:half], MX, y0, 5.9, accent)
            self._bullet_col(s, bullets[half:], MX+6.1, y0, 5.9, accent)
        else:
            self._bullet_col(s, bullets, MX, y0, 11.9, accent)
        self.pagefoot(s, idx, section)
        return s

    def _bullet_col(self, s, bullets, x, y, w, accent):
        for b in bullets:
            if isinstance(b, tuple):
                head, desc = b
            else:
                head, desc = b, None
            self.rect(s, x, y+0.09, 0.13, 0.13, color=accent, radius=0.5)
            runs = [[(head, BODY, 13.5, INK, True, False)]]
            if desc:
                runs = [[(head + "  ", BODY, 13.5, INK, True, False),
                         (desc, BODY, 13, MUTED, False, False)]]
            tb = self.text(s, x+0.32, y, w-0.32, 0.9, runs, leading=1.16)
            # estimate height
            length = len(head) + (len(desc) if desc else 0)
            lines = max(1, int(length / (w*4.6)) + 1)
            y += 0.30 + lines*0.235

    def _head(self, s, kicker, title, accent=TEAL):
        self.kicker(s, MX, 0.78, kicker, accent)
        self.text(s, MX, 1.0, 12, 0.7, [self.para(title, HEAD, 27, INK, bold=True)], leading=1.0)

    # ── card grid ──────────────────────────────────────────────────────────────
    def cards(self, kicker, title, cards, idx, section="", cols=3, intro=None, accent=TEAL):
        s = self.slide(BG)
        self.corner_accent(s)
        self._head(s, kicker, title, accent)
        y0 = 2.42 if intro else 1.9
        if intro:
            self.text(s, MX, 1.7, 11.9, 0.7, [self.para(intro, BODY, 13.5, MUTED)], leading=1.2)
        n = len(cards); rows = (n + cols - 1)//cols
        gap = 0.28
        cw = (12.6 - (cols-1)*gap)/cols
        avail_h = 6.85 - y0
        ch = (avail_h - (rows-1)*gap)/rows
        for i, c in enumerate(cards):
            r = i//cols; col = i % cols
            x = MX + col*(cw+gap); y = y0 + r*(ch+gap)
            ac = c[3] if len(c) > 3 else ACCENTS[i % len(ACCENTS)]
            a, b, cdesc = c[0], c[1], c[2]
            self.rect(s, x, y, cw, ch, color=CARD, line=STROKE, line_w=0.75, radius=0.10, shadow=True)
            self.rect(s, x, y, 0.09, ch, color=ac, radius=0.0)
            if len(a) <= 2:  # a is a short glyph symbol → chip + title + desc
                self.rect(s, x+0.28, y+0.26, 0.46, 0.46, color=tint_of(ac), radius=0.26)
                self.text(s, x+0.28, y+0.24, 0.46, 0.46, [self.para(a, HEAD, 14, ac, bold=True)],
                          align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
                self.text(s, x+0.9, y+0.24, cw-1.1, 0.5, [self.para(b, HEAD, 13.5, INK, bold=True)],
                          anchor=MSO_ANCHOR.MIDDLE, leading=1.02)
                self.text(s, x+0.3, y+0.86, cw-0.55, ch-1.0, [self.para(cdesc, BODY, 11.2, MUTED)], leading=1.16)
            else:  # a is the title (no glyph); b is an optional subtitle
                self.rect(s, x+0.3, y+0.24, 0.34, 0.05, color=ac)
                twoline = len(a) > int((cw-0.55)*5.6)
                self.text(s, x+0.3, y+0.36, cw-0.5, 0.7, [self.para(a, HEAD, 13.5, INK, bold=True)], leading=1.02)
                if b:
                    self.text(s, x+0.3, y+0.8, cw-0.55, 0.35, [self.para(b, BODY, 10.8, ac, bold=True)])
                    self.text(s, x+0.3, y+1.16, cw-0.55, ch-1.28, [self.para(cdesc, BODY, 11, MUTED)], leading=1.14)
                else:
                    dy = 1.02 if twoline else 0.74
                    self.text(s, x+0.3, y+dy, cw-0.5, ch-dy-0.12, [self.para(cdesc, BODY, 10.8, MUTED)], leading=1.14)
        self.pagefoot(s, idx, section)
        return s

    # ── stat row ─────────────────────────────────────────────────────────────
    def stats(self, kicker, title, stats, idx, section="", intro=None, footer_note=None):
        s = self.slide(BG)
        self.corner_accent(s)
        self._head(s, kicker, title)
        if intro:
            self.text(s, MX, 1.72, 11.9, 0.5, [self.para(intro, BODY, 14, MUTED)], leading=1.2)
        n = len(stats); gap = 0.3
        cw = (12.6 - (n-1)*gap)/n
        y = 2.7; ch = 2.7
        for i, (num, label, sub) in enumerate(stats):
            x = MX + i*(cw+gap)
            ac = ACCENTS[i % len(ACCENTS)]
            self.rect(s, x, y, cw, ch, color=CARD, line=STROKE, line_w=0.75, radius=0.12, shadow=True)
            self.rect(s, x+0.3, y+0.4, 0.5, 0.06, color=ac)
            self.text(s, x+0.25, y+0.62, cw-0.5, 1.1, [self.para(num, HEAD, 40, INK, bold=True)],
                      leading=0.95)
            self.text(s, x+0.28, y+1.72, cw-0.5, 0.4, [self.para(label, HEAD, 14, ac, bold=True)])
            self.text(s, x+0.28, y+2.08, cw-0.5, 0.5, [self.para(sub, BODY, 11, MUTED)], leading=1.12)
        if footer_note:
            self.text(s, MX, 5.9, 11.9, 0.6, [[("▎ ", BODY, 13, TEAL, True, False),
                      (footer_note, BODY, 13, MUTED, False, True)]], leading=1.2)
        self.pagefoot(s, idx, section)
        return s

    # ── two panels ─────────────────────────────────────────────────────────────
    def two_panel(self, kicker, title, left, right, idx, section="", accent=TEAL):
        """left/right = (heading, glyph, accent, [bullets])"""
        s = self.slide(BG)
        self.corner_accent(s)
        self._head(s, kicker, title, accent)
        for (px, panel) in [(MX, left), (MX+6.15, right)]:
            heading, glyph, pac, bl = panel
            self.rect(s, px, 1.95, 5.85, 4.9, color=CARD, line=STROKE, line_w=0.75, radius=0.1, shadow=True)
            self.rect(s, px, 1.95, 5.85, 0.72, color=None, radius=0.1)
            self.rect(s, px+0.3, 2.14, 0.42, 0.42, color=None, line=pac, line_w=1.2, radius=0.24)
            self.text(s, px+0.3, 2.12, 0.42, 0.42, [self.para(glyph, HEAD, 14, pac, bold=True)],
                      align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
            self.text(s, px+0.85, 2.12, 4.9, 0.45, [self.para(heading, HEAD, 15.5, INK, bold=True)],
                      anchor=MSO_ANCHOR.MIDDLE)
            yy = 2.95
            for b in bl:
                if isinstance(b, tuple):
                    head, desc = b
                else:
                    head, desc = b, None
                self.rect(s, px+0.32, yy+0.08, 0.11, 0.11, color=pac, radius=0.5)
                if desc:
                    runs = [[(head+"  ", BODY, 12, INK, True, False), (desc, BODY, 11.5, MUTED, False, False)]]
                else:
                    runs = [[(head, BODY, 12, INK, False, False)]]
                self.text(s, px+0.58, yy, 5.05, 0.7, runs, leading=1.12)
                length = len(head) + (len(desc) if desc else 0)
                lines = max(1, int(length/26)+1)
                yy += 0.20 + lines*0.205
        self.pagefoot(s, idx, section)
        return s

    # ── module deep-dive: overview slide ───────────────────────────────────────
    def module_overview(self, family, title, positioning, features, idx, glyph="●", accent=TEAL, tag=None):
        s = self.slide(BG)
        self.rect(s, 0, 0, 13.333, 0.06, color=accent)
        # header band
        self.rect(s, MX, 0.7, 0.62, 0.62, color=None, line=accent, line_w=1.6, radius=0.3)
        self.text(s, MX, 0.68, 0.62, 0.62, [self.para(glyph, HEAD, 20, accent, bold=True)],
                  align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        self.text(s, MX+0.82, 0.66, 9.5, 0.35, [self.para(family.upper(), HEAD, 11, accent, bold=True)])
        self.text(s, MX+0.82, 0.94, 10.2, 0.6, [self.para(title, HEAD, 25, INK, bold=True)], leading=1.0)
        if tag:
            tw = 0.16*len(tag)+0.5
            self.rect(s, 12.61-tw, 0.82, tw, 0.4, color=None, line=accent, line_w=1, radius=0.5)
            self.text(s, 12.61-tw, 0.8, tw, 0.4, [self.para(tag, HEAD, 10.5, accent, bold=True)],
                      align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        # positioning box
        self.rect(s, MX, 1.72, 11.89, 0.96, color=CARD2, radius=0.1)
        self.rect(s, MX, 1.72, 0.08, 0.96, color=accent)
        self.text(s, MX+0.32, 1.80, 11.4, 0.85, [[(self.L["role"]+"  ", HEAD, 11.5, accent, True, False),
                  (positioning, BODY, 12.5, INK, False, False)]], leading=1.2, anchor=MSO_ANCHOR.MIDDLE)
        # feature cards grid 2 x 3
        y0 = 2.95; gap = 0.26; cols = 3
        rows = (len(features)+cols-1)//cols
        cw = (12.6 - (cols-1)*gap)/cols
        ch = (6.85 - y0 - (rows-1)*gap)/rows
        for i, f in enumerate(features):
            r = i//cols; c = i % cols
            x = MX + c*(cw+gap); y = y0 + r*(ch+gap)
            ftitle, fdesc = f
            self.rect(s, x, y, cw, ch, color=CARD, line=STROKE, line_w=0.6, radius=0.09)
            self.rect(s, x+0.24, y+0.24, 0.28, 0.06, color=accent)
            self.text(s, x+0.24, y+0.4, cw-0.45, 0.5, [self.para(ftitle, HEAD, 12.8, INK, bold=True)], leading=1.02)
            self.text(s, x+0.24, y+0.9, cw-0.45, ch-1.0, [self.para(fdesc, BODY, 10.8, MUTED)], leading=1.14)
        self.pagefoot(s, idx, family)
        return s

    # ── module deep-dive: controls + differentiators slide ─────────────────────
    def module_controls(self, family, title, controls, wow, routes, idx, accent=TEAL):
        s = self.slide(BG)
        self.rect(s, 0, 0, 13.333, 0.06, color=accent)
        self.text(s, MX, 0.62, 9.5, 0.35, [self.para(family.upper()+"  "+self.L["continued"], HEAD, 11, accent, bold=True)])
        self.text(s, MX, 0.9, 11, 0.55, [self.para(title, HEAD, 22, INK, bold=True)], leading=1.0)
        # left = controls, right = wow
        lx = MX; rx = MX+6.15; top = 1.9; ph = 4.15
        # controls panel
        self.rect(s, lx, top, 5.85, ph, color=CARD, line=STROKE, line_w=0.75, radius=0.1)
        self.rect(s, lx, top, 5.85, 0.6, color=None)
        self.text(s, lx+0.3, top+0.02, 5.4, 0.55, [[("⛨ ", HEAD, 13, CORAL, True, False),
                  (self.L["controls"], HEAD, 13.5, INK, True, False)]],
                  anchor=MSO_ANCHOR.MIDDLE)
        yy = top+0.72
        for c in controls:
            self.rect(s, lx+0.32, yy+0.07, 0.1, 0.1, color=CORAL, radius=0.5)
            self.text(s, lx+0.56, yy, 5.1, 0.6, [self._ctrl_runs(c)], leading=1.12)
            yy += 0.2 + max(1, int(len(c)/30)+1)*0.205
        # wow panel
        self.rect(s, rx, top, 5.85, ph, color=CARD, line=STROKE, line_w=0.75, radius=0.1)
        self.rect(s, rx, top, 5.85, 0.6, color=None)
        self.text(s, rx+0.3, top+0.02, 5.4, 0.55, [[("★ ", HEAD, 13, GOLD, True, False),
                  (self.L["wow"], HEAD, 13.5, INK, True, False)]], anchor=MSO_ANCHOR.MIDDLE)
        yy = top+0.72
        for w in wow:
            self.rect(s, rx+0.32, yy+0.07, 0.1, 0.1, color=GOLD, radius=0.5)
            self.text(s, rx+0.56, yy, 5.1, 0.7, [[(w, BODY, 11.7, INK, False, False)]], leading=1.14)
            yy += 0.2 + max(1, int(len(w)/30)+1)*0.205
        # routes strip
        self.rect(s, MX, 6.2, 11.89, 0.62, color=CARD2, radius=0.1)
        self.text(s, MX+0.3, 6.2, 1.5, 0.62, [self.para(self.L["routes"], HEAD, 10.5, accent, bold=True)],
                  anchor=MSO_ANCHOR.MIDDLE)
        self.text(s, MX+1.7, 6.2, 10.0, 0.62, [self.para("   ".join(routes), BODY, 11, MUTED)],
                  anchor=MSO_ANCHOR.MIDDLE)
        self.pagefoot(s, idx, family)
        return s

    def _ctrl_runs(self, c):
        # bold a leading CODE token if present (e.g. "GL-05 — ...")
        import re
        m = re.match(r"^([A-Z]{2,5}-[0-9A-Za-z/]+(?:/[0-9A-Za-z-]+)*)\s+(.*)$", c)
        if m:
            return [(m.group(1)+"  ", BODY, 12, TEAL, True, False), (m.group(2), BODY, 11.8, MUTED, False, False)]
        return [(c, BODY, 11.8, MUTED, False, False)]

    # ── comparison table ───────────────────────────────────────────────────────
    def compare(self, kicker, title, rows, idx, us="Invisible ERP", them="ERP ทั่วไป", section=""):
        s = self.slide(BG)
        self.corner_accent(s)
        self._head(s, kicker, title)
        top = 1.95; x = MX; w = 11.89
        c0 = 5.0; c1 = 3.45; c2 = w - c0 - c1
        # header row
        self.rect(s, x, top, w, 0.66, color=CARD2, radius=0.08)
        self.text(s, x+0.3, top, c0-0.3, 0.66, [self.para(self.L["capability"], HEAD, 13, MUTED, bold=True)], anchor=MSO_ANCHOR.MIDDLE)
        self.text(s, x+c0, top, c1, 0.66, [[("● ", BODY, 12, TEAL, True, False),(us, HEAD, 13, TEAL, True, False)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        self.text(s, x+c0+c1, top, c2, 0.66, [self.para(them, HEAD, 13, FAINT, bold=True)], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        y = top+0.74; rh = (6.75 - y)/len(rows)
        for i, (feat, ours, theirs) in enumerate(rows):
            bg = CARD if i % 2 == 0 else BG2
            self.rect(s, x, y, w, rh-0.06, color=bg, radius=0.06)
            self.text(s, x+0.3, y, c0-0.4, rh-0.06, [self.para(feat, BODY, 11.8, INK, bold=True)], anchor=MSO_ANCHOR.MIDDLE, leading=1.05)
            self.text(s, x+c0, y, c1, rh-0.06, [[("✔  ", BODY, 12, GREEN, True, False),(ours, BODY, 11, INK, False, False)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, leading=1.05)
            self.text(s, x+c0+c1, y, c2, rh-0.06, [[("✕  ", BODY, 12, CORAL, True, False),(theirs, BODY, 10.5, FAINT, False, False)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, leading=1.05)
            y += rh
        self.pagefoot(s, idx, section)
        return s

    # ── closing ────────────────────────────────────────────────────────────────
    def closing(self, title, subtitle, contact_lines, kicker="ก้าวต่อไปกับ Invisible ERP"):
        s = self.slide(BG)
        self.rect(s, 8.7, 0, 4.633, 7.5, color=TINTS['teal'])
        self.rect(s, 10.6, 3.6, 4.2, 4.2, color=TINTS['violet'], radius=0.5)
        self.rect(s, 0, 0, 13.333, 0.09, color=TEAL)
        if self.logo_dark:
            self.pic(s, self.logo_dark, MX, 0.95, 2.15)
        self.kicker(s, MX, 2.7, kicker)
        self.text(s, MX, 2.95, 8.0, 1.6, [self.para(title, HEAD, 44, INK, bold=True)], leading=1.0)
        self.text(s, MX, 4.65, 7.9, 0.9, [self.para(subtitle, BODY, 16.5, MUTED)], leading=1.3)
        self.rect(s, MX, 5.75, 3.0, 0.04, color=TEAL)
        y = 6.0
        for label, val in contact_lines:
            self.rect(s, MX, y+0.07, 0.12, 0.12, color=TEAL, radius=0.5)
            self.text(s, MX+0.3, y, 8, 0.4, [[(label+"  ", BODY, 13, MUTED, False, False),
                      (val, BODY, 13, INK, True, False)]])
            y += 0.48
        return s


def subtitle_y(title):
    return 5.55
