import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * PDF simples (licence, facture, avoir) avec les polices standard : aucune police à embarquer.
 * Les caractères hors de l'alphabet latin des polices standard sont remplacés (ex. emoji d'un titre).
 */
export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'text'; text: string; muted?: boolean; mono?: boolean }
  | { kind: 'heading'; text: string }
  | { kind: 'rows'; rows: [string, string][] }
  | { kind: 'space' };

const WINANSI = /[^ -~ -ÿ€’‘“”–—…ŒœŠšŸŽž•]/g;
export const pdfSafe = (s: string) => s.replace(/[   ]/g, ' ').replace(/\s+/g, (m) => (m.includes('\n') ? '\n' : ' ')).replace(WINANSI, '?');

export async function renderPdf(meta: { title: string; footer: string }, blocks: Block[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(meta.title));
  doc.setProducer('Sonikc');
  doc.setCreator('Sonikc');
  // Dates des métadonnées fixées à l'émission : le fichier ne dépend que de son contenu.
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const W = 595, H = 842, M = 50;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.07, 0.07, 0.09), mute = rgb(0.4, 0.4, 0.45), accent = rgb(1, 0.35, 0.21);
  const need = (h: number) => { if (y - h < M + 20) { page = doc.addPage([W, H]); y = H - M; } };
  const wrap = (text: string, font: PDFFont, size: number, width: number) => {
    const out: string[] = [];
    for (const para of pdfSafe(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const tryLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(tryLine, size) <= width) { line = tryLine; continue; }
        if (line) out.push(line);
        // Mot plus long que la ligne (empreinte, adresse) : coupé au caractère.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let n = w.length;
          while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          out.push(w.slice(0, n)); w = w.slice(n);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  };
  const draw = (text: string, x: number, size: number, font: PDFFont, color = ink) => page.drawText(text, { x, y, size, font, color });

  for (const b of blocks) {
    if (b.kind === 'space') { y -= 10; continue; }
    if (b.kind === 'title') {
      need(40); draw('SONIKC', M, 9, fonts.bold, accent); y -= 26;
      for (const l of wrap(b.text, fonts.bold, 20, W - 2 * M)) { need(24); draw(l, M, 20, fonts.bold); y -= 24; }
      y -= 6; continue;
    }
    if (b.kind === 'heading') {
      need(30); y -= 8; draw(pdfSafe(b.text).toUpperCase(), M, 9, fonts.bold, mute); y -= 16; continue;
    }
    if (b.kind === 'text') {
      const font = b.mono ? fonts.mono : fonts.regular, size = b.mono ? 8.5 : 10;
      for (const l of wrap(b.text, font, size, W - 2 * M)) { need(14); draw(l, M, size, font, b.muted ? mute : ink); y -= 14; }
      continue;
    }
    for (const [k, v] of b.rows) {
      const lines = wrap(v, fonts.regular, 10, W - 2 * M - 170);
      need(14 * lines.length);
      draw(pdfSafe(k), M, 10, fonts.bold, mute);
      for (const l of lines) { draw(l, M + 170, 10, fonts.regular); y -= 14; }
    }
  }
  for (const [i, p] of doc.getPages().entries()) {
    p.drawText(pdfSafe(`${meta.footer} · page ${i + 1}/${doc.getPageCount()}`), { x: M, y: 28, size: 8, font: fonts.regular, color: mute });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
