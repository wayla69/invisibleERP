import { inflateSync } from 'node:zlib';

// Minimal, dependency-free PDF TEXT-LAYER extraction for the AP-intake upload channel (EXP-10).
// Walks every content stream (inflating FlateDecode), pulls the text-showing operators (Tj / TJ) and
// breaks lines on text-positioning operators. This is the DETERMINISTIC fallback so a digital PDF
// (text layer present) extracts without an API key — CI/harness rely on it. It is intentionally naive:
// scanned/image-only PDFs yield nothing (→ AI vision path or human review), and exotic encodings
// (CID/UTF-16 fonts, common for Thai) may yield garbage — callers must treat short/absent output as
// "no usable text layer", never as an empty invoice.
export function pdfExtractText(buf: Buffer): string {
  const latin = buf.toString('latin1'); // byte↔char stable, keeps stream offsets exact
  const out: string[] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    streamRe.lastIndex = end;
    let data = buf.subarray(start, end);
    const dictStart = latin.lastIndexOf('<<', m.index);
    const dict = latin.slice(dictStart >= 0 ? dictStart : 0, m.index);
    if (/FlateDecode/.test(dict)) {
      // trailing EOL before 'endstream' is not part of the stream — retry trimmed if inflate chokes
      try { data = inflateSync(data); } catch { try { data = inflateSync(data.subarray(0, data.length - 1)); } catch { continue; } }
    }
    const content = data.toString('latin1');
    if (!/(?:\)\s*Tj)|(?:\]\s*TJ)/.test(content)) continue; // not a text content stream
    const toks = content.match(/\((?:\\.|[^\\()])*\)\s*Tj|\[(?:\\.|[^\]\\])*\]\s*TJ|T\*|Td|TD|ET/g) ?? [];
    let line = '';
    const flush = () => { if (line.trim()) out.push(line.trim()); line = ''; };
    for (const t of toks) {
      if (t === 'T*' || t === 'Td' || t === 'TD' || t === 'ET') { flush(); continue; }
      for (const s of t.match(/\((?:\\.|[^\\()])*\)/g) ?? []) line += unescapePdfString(s.slice(1, -1));
    }
    flush();
  }
  return out.join('\n');
}

// Is an extracted text layer actually USABLE, or CID/UTF-16 mojibake? The old `length >= 20` routing
// gate was fooled by garbage: a Thai CID-font PDF can inflate to plenty of characters of junk, which
// then mis-extracted through the regex path instead of routing to vision / human review. Heuristic:
// enough word characters (Latin/digit/Thai) both in ratio and in at least one contiguous run, and not
// dominated by control/replacement characters.
export function usableTextLayer(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 20) return false;
  let word = 0;
  let ctrl = 0;
  let nonWs = 0;
  let run = 0;
  let maxRun = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0)!;
    const isWs = /\s/.test(ch);
    if (!isWs) nonWs++;
    const isWord = /[A-Za-z0-9ก-๛]/.test(ch);
    if (isWord) { word++; run++; if (run > maxRun) maxRun = run; } else { run = 0; }
    if ((code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') || code === 0xfffd) ctrl++;
  }
  if (nonWs === 0) return false;
  return word / nonWs >= 0.35 && maxRun >= 3 && ctrl / nonWs < 0.1;
}

function unescapePdfString(s: string): string {
  return s.replace(/\\(\d{1,3}|.)/g, (_all, esc: string) => {
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 8) & 0xff);
    switch (esc) {
      case 'n': return '\n'; case 'r': return '\r'; case 't': return '\t';
      case 'b': return '\b'; case 'f': return '\f';
      default: return esc; // \( \) \\ and anything else → the literal char
    }
  });
}
