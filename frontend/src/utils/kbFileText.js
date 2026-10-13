/**
 * Reads a knowledge file's text in the browser so only text goes to the server.
 * PDFs are parsed with pdf.js in a web worker: a large PDF takes 15s+ to parse,
 * which the API proxy times out on (504) and which would stall the bot server.
 */

const TEXT_EXT = /\.(txt|md|csv|json)$/i;

async function pdfText(file, onProgress) {
  // Loaded on demand — pdf.js is large and only this upload flow needs it.
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Same line joining as the server's pdf-parse, so chunking is identical.
      let lastY;
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform[5];
        text += lastY === y || !lastY ? item.str : `\n${item.str}`;
        lastY = y;
      }
      pages.push(text);
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
    return pages.join('\n\n');
  } finally {
    doc.destroy();
  }
}

/** { kind, text } for a .pdf/.txt/.md/.csv/.json file. */
export async function readKnowledgeFile(file, onProgress) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const text = await pdfText(file, onProgress);
    if (!text.trim()) throw new Error('No text found in this PDF (is it a scanned image?)');
    return { kind: 'pdf', text };
  }
  if (TEXT_EXT.test(file.name) || file.type.startsWith('text/')) {
    return { kind: 'text', text: await file.text() };
  }
  throw new Error('Upload a .txt, .md, .csv, .json or .pdf file');
}
