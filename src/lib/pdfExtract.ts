/**
 * pdf-parse v2+ exposes a PDFParse class. Older code used `pdfParse(buffer)` which no longer works.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse') as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText: () => Promise<{ text: string; total: number }>;
    destroy: () => Promise<void>;
  };
};

export async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text ?? '').replace(/\u0000/g, ' ').trim();
    return {
      text,
      numpages: typeof result.total === 'number' ? result.total : 0,
    };
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* ignore */
    }
  }
}
