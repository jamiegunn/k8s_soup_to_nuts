// Builds the PowerPoint deck from content.js (same copy as index.html)
const pptxgen = require("pptxgenjs");
const path = require("path");
const C = require("./content.js");

const NAVY="102A43", SLATE="486581", MUTE="829AB1", MIST="D9E2EC", MIST2="F0F4F8",
      PAPER="FFFFFF", BLUE="2680C2", BLUE_D="0A558C", BLUE_L="4098D7";
const HEAD="Cambria", BODY="Calibri", MONO="Courier New";
const DOOR=["", "9BD1F5", "A7E0C4", "F3CE8E"]; // code annotation colours by door

// `code` / **bold** / *italic*  ->  pptxgenjs rich-text runs
function rich(s, base = {}) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0, m;
  const push = (text, extra) => { if (text) out.push({ text, options: Object.assign({}, base, extra) }); };
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) push(tok.slice(1, -1), { fontFace: MONO, color: base.codeColor || NAVY });
    else if (tok.startsWith("**")) rich(tok.slice(2, -2), Object.assign({}, base, { bold: true, color: base.strongColor || NAVY })).forEach((r) => out.push(r));
    else push(tok.slice(1, -1), { italic: true });
    last = m.index + tok.length;
  }
  push(s.slice(last));
  return out.length ? out : [{ text: s, options: base }];
}
const plain = (s) => s.replace(/[`*]/g, "");

(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9"; // 10 x 5.625
  pres.author = "K8s Soup to Nuts";
  pres.title = C.meta.title;

  const M = 0.5, W = 9.0;

  function head(s, sl) {
    sl.addText(s.eyebrow, { x: M, y: 0.3, w: W, h: 0.24, fontFace: BODY, fontSize: 10, bold: true, color: BLUE_D, charSpacing: 1.4, margin: 0, isTextBox: true });
    sl.addText(s.title, { x: M, y: 0.55, w: W, h: 0.55, fontFace: HEAD, fontSize: 29, bold: true, color: NAVY, margin: 0, isTextBox: true });
    if (s.kicker) sl.addText(rich(s.kicker, { italic: true, color: SLATE }), { x: M, y: 1.14, w: W, h: 0.42, fontFace: BODY, fontSize: 12.5, margin: 0, isTextBox: true });
    return s.kicker ? 1.62 : 1.22;
  }
  function calloutBox(sl, c, y, h, x = M, w = W) {
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.06 });
    sl.addText(plain(c.label).toUpperCase(), { x: x + 0.2, y: y + 0.08, w: w - 0.4, h: 0.2, fontFace: BODY, fontSize: 8.5, bold: true, color: BLUE_D, charSpacing: 0.9, margin: 0, isTextBox: true });
    sl.addText(rich(c.text, { color: NAVY }), { x: x + 0.2, y: y + 0.28, w: w - 0.4, h: h - 0.34, fontFace: BODY, fontSize: 11, margin: 0, isTextBox: true, valign: "top" });
  }
  function cardRow(sl, items, y, h, opts = {}) {
    const n = items.length, gap = 0.18, cw = (W - gap * (n - 1)) / n;
    items.forEach((c, i) => {
      const x = M + i * (cw + gap);
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.06 });
      let ty = y + 0.14;
      if (c.n) {
        sl.addShape(pres.shapes.OVAL, { x: x + 0.16, y: ty, w: 0.26, h: 0.26, fill: { color: BLUE }, line: { color: BLUE } });
        sl.addText(c.n, { x: x + 0.16, y: ty, w: 0.26, h: 0.26, align: "center", valign: "middle", fontFace: BODY, fontSize: 11, bold: true, color: PAPER, margin: 0, isTextBox: true });
        ty += 0.34;
      }
      sl.addText(plain(c.head), { x: x + 0.16, y: ty, w: cw - 0.32, h: 0.26, fontFace: BODY, fontSize: opts.headSize || 13, bold: true, color: NAVY, margin: 0, isTextBox: true });
      ty += 0.28;
      if (c.sub) { sl.addText(plain(c.sub), { x: x + 0.16, y: ty, w: cw - 0.32, h: 0.24, fontFace: BODY, fontSize: 10.5, italic: true, color: BLUE_D, margin: 0, isTextBox: true }); ty += 0.26; }
      sl.addText(rich(c.text, { color: SLATE, strongColor: NAVY }), { x: x + 0.16, y: ty, w: cw - 0.32, h: y + h - ty - 0.12, fontFace: BODY, fontSize: opts.bodySize || 10, margin: 0, isTextBox: true, valign: "top" });
    });
  }
  function tableBlock(sl, t, y, colW, fontSize) {
    const rows = [[
      ...t.head.map((h) => ({ text: plain(h).toUpperCase(), options: { bold: true, fontSize: 8.5, color: BLUE_D, charSpacing: 0.8 } })),
    ]];
    t.rows.forEach((r, ri) => rows.push(r.map((cell, ci) => ({
      text: rich(cell, { color: ci === 0 ? NAVY : SLATE, strongColor: NAVY }),
      options: { fill: { color: ri % 2 ? PAPER : "FAFCFE" } },
    }))));
    sl.addTable(rows, {
      x: M, y, w: W, colW, fontFace: BODY, fontSize, color: SLATE, valign: "top",
      border: [{ type: "none" }, { type: "none" }, { pt: 0.5, color: MIST }, { type: "none" }],
      margin: [4, 8, 6, 8], autoPage: false,
    });
  }

  // ---------------- cover ----------------
  {
    const sl = pres.addSlide();
    sl.background = { color: NAVY };
    sl.addText(C.meta.title, { x: 0.6, y: 1.25, w: 8.2, h: 1.2, fontFace: HEAD, fontSize: 40, bold: true, color: PAPER, margin: 0, isTextBox: true });
    sl.addText(plain(C.meta.subtitle), { x: 0.6, y: 2.55, w: 7.6, h: 1.1, fontFace: BODY, fontSize: 14.5, color: MIST, margin: 0, isTextBox: true });
    sl.addText(C.meta.phrases.map((p, i) => ({ text: (i ? "   ·   " : "") + p, options: { color: i ? BLUE_L : BLUE_L, bold: true } })),
      { x: 0.6, y: 3.85, w: 8.2, h: 0.35, fontFace: BODY, fontSize: 15, margin: 0, isTextBox: true });
    sl.addText(C.meta.footer, { x: 0.6, y: 4.85, w: 8.2, h: 0.3, fontFace: BODY, fontSize: 10.5, color: MUTE, margin: 0, isTextBox: true });
    sl.addNotes("Title slide — set the frame: this is not a Kubernetes tour, it is three questions and a way to read failures. Say out loud that no devops background is assumed and that every concept will be anchored to something they have already built.");
  }

  // ---------------- content ----------------
  C.slides.forEach((s) => {
    const sl = pres.addSlide();
    sl.background = { color: PAPER };
    const y0 = head(s, sl);

    if (s.layout === "table2") {
      tableBlock(sl, s.table, y0, [4.0, 5.0], 10.5);
      calloutBox(sl, s.callout, 4.40, 0.82);
    }

    if (s.layout === "code-cards") {
      const cw = 5.25, ch = 3.55;
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: y0, w: cw, h: ch, fill: { color: NAVY }, line: { color: NAVY }, rectRadius: 0.06 });
      sl.addText(plain(s.code.caption).toUpperCase(), { x: M + 0.18, y: y0 + 0.1, w: cw - 0.36, h: 0.2, fontFace: BODY, fontSize: 7.5, color: MUTE, charSpacing: 0.8, margin: 0, isTextBox: true });
      const runs = [];
      s.code.lines.forEach(([text, door, note], i) => {
        const col = door ? DOOR[door] : "C6D4E1";
        runs.push({ text, options: { fontFace: MONO, fontSize: 7.5, color: col, breakLine: !note } });
        if (note) runs.push({ text: "  ← " + note, options: { fontFace: BODY, fontSize: 7, italic: true, color: col, breakLine: true } });
      });
      sl.addText(runs, { x: M + 0.18, y: y0 + 0.32, w: cw - 0.3, h: ch - 0.44, margin: 0, isTextBox: true, valign: "top", lineSpacingMultiple: 1.15 });
      // cards stacked on the right
      const rx = M + cw + 0.22, rw = W - cw - 0.22;
      let cy = y0;
      s.cards.forEach((c) => {
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rx, y: cy, w: rw, h: 0.72, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.05 });
        sl.addShape(pres.shapes.OVAL, { x: rx + 0.15, y: cy + 0.13, w: 0.24, h: 0.24, fill: { color: BLUE }, line: { color: BLUE } });
        sl.addText(c.n, { x: rx + 0.15, y: cy + 0.13, w: 0.24, h: 0.24, align: "center", valign: "middle", fontFace: BODY, fontSize: 10, bold: true, color: PAPER, margin: 0, isTextBox: true });
        sl.addText(c.head, { x: rx + 0.47, y: cy + 0.1, w: rw - 0.6, h: 0.26, fontFace: BODY, fontSize: 12.5, bold: true, color: NAVY, margin: 0, isTextBox: true });
        sl.addText(c.text, { x: rx + 0.15, y: cy + 0.38, w: rw - 0.3, h: 0.3, fontFace: BODY, fontSize: 9.5, color: SLATE, margin: 0, isTextBox: true });
        cy += 0.82;
      });
      calloutBox(sl, s.callout, cy, y0 + ch - cy, rx, rw);
    }

    if (s.layout === "quote-cards") {
      sl.addText(plain(s.quote), { x: M, y: y0, w: W, h: 0.5, fontFace: HEAD, fontSize: 21, bold: true, color: NAVY, margin: 0, isTextBox: true });
      sl.addText(rich(s.lead, { color: SLATE }), { x: M, y: y0 + 0.55, w: W, h: 0.62, fontFace: BODY, fontSize: 11.5, margin: 0, isTextBox: true });
      cardRow(sl, s.cards, y0 + 1.22, 1.45);
      calloutBox(sl, s.callout, y0 + 2.8, 0.72);
    }

    if (s.layout === "cards-callout") {
      cardRow(sl, s.cards, y0, 1.7, { headSize: 14 });
      calloutBox(sl, s.callout, y0 + 1.85, 0.88);
      sl.addText(rich(s.lead, { color: SLATE }), { x: M, y: y0 + 2.85, w: W, h: 0.62, fontFace: BODY, fontSize: 11, margin: 0, isTextBox: true });
    }

    if (s.layout === "two-col") {
      sl.addText(rich(s.lead, { color: SLATE }), { x: M, y: y0, w: W, h: 0.4, fontFace: BODY, fontSize: 11.5, margin: 0, isTextBox: true });
      const gap = 0.24, cw = (W - gap) / 2, cy = y0 + 0.5, ch = 1.95;
      s.columns.forEach((c, i) => {
        const x = M + i * (cw + gap);
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: cy, w: cw, h: ch, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.06 });
        sl.addText(plain(c.head), { x: x + 0.2, y: cy + 0.14, w: cw - 0.4, h: 0.3, fontFace: BODY, fontSize: 14, bold: true, color: NAVY, margin: 0, isTextBox: true });
        sl.addText(rich(c.text, { color: SLATE, strongColor: NAVY }), { x: x + 0.2, y: cy + 0.48, w: cw - 0.4, h: 0.95, fontFace: BODY, fontSize: 10.5, margin: 0, isTextBox: true, valign: "top" });
        sl.addText(plain(c.foot), { x: x + 0.2, y: cy + ch - 0.52, w: cw - 0.4, h: 0.44, fontFace: BODY, fontSize: 10, italic: true, color: BLUE_D, margin: 0, isTextBox: true, valign: "bottom" });
      });
      calloutBox(sl, s.callout, cy + ch + 0.16, 0.66);
    }

    if (s.layout === "story") {
      const lw = 3.9;
      let ty = y0;
      s.story.forEach((p, i) => {
        sl.addText(rich(p, { color: i === 0 ? NAVY : SLATE, strongColor: NAVY, codeColor: NAVY }),
          { x: M, y: ty, w: lw, h: 0.92, fontFace: BODY, fontSize: 11.5, margin: 0, isTextBox: true, valign: "top" });
        ty += 0.98;
      });
      const rx = M + lw + 0.25, rw = W - lw - 0.25;
      let cy = y0;
      s.cards.forEach((c) => {
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rx, y: cy, w: rw, h: 0.9, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.05 });
        sl.addShape(pres.shapes.OVAL, { x: rx + 0.15, y: cy + 0.13, w: 0.24, h: 0.24, fill: { color: BLUE }, line: { color: BLUE } });
        sl.addText(c.n, { x: rx + 0.15, y: cy + 0.13, w: 0.24, h: 0.24, align: "center", valign: "middle", fontFace: BODY, fontSize: 10, bold: true, color: PAPER, margin: 0, isTextBox: true });
        sl.addText(c.head, { x: rx + 0.47, y: cy + 0.1, w: rw - 0.6, h: 0.26, fontFace: BODY, fontSize: 12.5, bold: true, color: NAVY, margin: 0, isTextBox: true });
        sl.addText(c.text, { x: rx + 0.15, y: cy + 0.38, w: rw - 0.3, h: 0.46, fontFace: BODY, fontSize: 9.5, color: SLATE, margin: 0, isTextBox: true, valign: "top" });
        cy += 0.98;
      });
      calloutBox(sl, s.callout, 4.50, 0.78);
    }

    if (s.layout === "table3") {
      tableBlock(sl, s.table, y0, [3.0, 1.4, 4.6], 9.5);
      calloutBox(sl, s.callout, 4.34, 0.92);
    }

    if (s.layout === "steps") {
      const gap = 0.3, cw = (W - gap) / 2;
      s.steps.forEach((st, i) => {
        const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * 1.15;
        sl.addShape(pres.shapes.OVAL, { x, y: y + 0.02, w: 0.28, h: 0.28, fill: { color: BLUE }, line: { color: BLUE } });
        sl.addText(String(i + 1), { x, y: y + 0.02, w: 0.28, h: 0.28, align: "center", valign: "middle", fontFace: BODY, fontSize: 11, bold: true, color: PAPER, margin: 0, isTextBox: true });
        sl.addText(rich(st.head, { bold: true, color: NAVY }), { x: x + 0.38, y, w: cw - 0.38, h: 0.3, fontFace: BODY, fontSize: 12.5, margin: 0, isTextBox: true });
        sl.addText(rich(st.text, { color: SLATE }), { x: x + 0.38, y: y + 0.32, w: cw - 0.38, h: 0.72, fontFace: BODY, fontSize: 10, margin: 0, isTextBox: true, valign: "top" });
      });
      const ny = y0 + 2.55;
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: ny, w: W, h: 1.0, fill: { color: MIST2 }, line: { color: MIST }, rectRadius: 0.06 });
      sl.addText(plain(s.next.label).toUpperCase(), { x: M + 0.2, y: ny + 0.1, w: W - 0.4, h: 0.2, fontFace: BODY, fontSize: 8.5, bold: true, color: BLUE_D, charSpacing: 0.9, margin: 0, isTextBox: true });
      const iw = (W - 0.4) / 4;
      s.next.items.forEach(([name, href, blurb], i) => {
        const x = M + 0.2 + i * iw;
        sl.addText(name, { x, y: ny + 0.34, w: iw - 0.12, h: 0.24, fontFace: BODY, fontSize: 11, bold: true, color: BLUE_D, margin: 0, isTextBox: true, hyperlink: { url: C.meta.site + href } });
        sl.addText(blurb, { x, y: ny + 0.56, w: iw - 0.12, h: 0.38, fontFace: BODY, fontSize: 9, color: SLATE, margin: 0, isTextBox: true, valign: "top" });
      });
    }

    sl.addNotes(s.notes);
  });

  await pres.writeFile({ fileName: path.join(__dirname, "k8s-for-developers.pptx") });
  console.log("k8s-for-developers.pptx written");
})().catch((e) => { console.error(e); process.exit(1); });
