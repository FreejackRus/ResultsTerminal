import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
export async function validatePdf(bytes: number[]) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;
    if (!doc.numPages) throw Error('INVALID_PDF');
    await doc.getPage(1);
  } finally {
    await task.destroy();
  }
}
