import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Label } from './i18n';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
export function PdfViewer({ bytes, t }: { bytes: number[]; t: (key: Label) => string }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    [page, setPage] = useState(1),
    [count, setCount] = useState(0),
    [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    let render: pdfjs.RenderTask | undefined;
    void task.promise
      .then(async (doc) => {
        if (!active) return;
        setCount(doc.numPages);
        const p = await doc.getPage(Math.min(page, doc.numPages));
        if (!active || !canvas.current) return;
        const viewport = p.getViewport({ scale: 1.4 }),
          c = canvas.current;
        c.width = viewport.width;
        c.height = viewport.height;
        render = p.render({ canvas: c, viewport });
        await render.promise;
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      render?.cancel();
      void task.destroy();
    };
  }, [bytes, page]);
  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          {t('previous')}
        </button>
        <span>
          {t('page')} {page} / {count || '—'}
        </span>
        <button disabled={page >= count} onClick={() => setPage((p) => p + 1)}>
          {t('next')}
        </button>
      </div>
      {error ? (
        <p role="alert">{t('error')}</p>
      ) : (
        <canvas ref={canvas} aria-label={t('document')} />
      )}
    </div>
  );
}
