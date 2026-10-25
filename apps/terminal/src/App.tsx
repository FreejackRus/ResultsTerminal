import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  defaults,
  type Config,
  type Method,
  type MedicalResult,
  type Results,
  type Session,
} from '@rt/contracts';
import {
  api,
  applyConfig,
  deviceHealth,
  enroll,
  errorMessages,
  isNative,
  localReady,
  pdfBytes,
  submitPrint,
} from './bridge';
import { dictionaries, methodLabels, type Label } from './i18n';
import { PdfViewer } from './PdfViewer';
import { validatePdf } from './pdf';
import { printBatch, type PrintOutcome } from './printing';
type Screen =
  'setup' | 'home' | 'methods' | 'identify' | 'otp' | 'results' | 'preview' | 'printing' | 'done';
export default function App() {
  const [config, setConfig] = useState<Config>(defaults),
    [screen, setScreen] = useState<Screen>('home'),
    [language, setLanguage] = useState<'ru' | 'en' | 'zh'>('ru'),
    [contrast, setContrast] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [method, setMethod] = useState<Method>('oms-birth');
  const [identifier, setIdentifier] = useState(''),
    [proof, setProof] = useState(''),
    [challenge, setChallenge] = useState(''),
    [session, setSession] = useState<Session | null>(null),
    [items, setItems] = useState<MedicalResult[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [bytes, setBytes] = useState<number[] | null>(null),
    [current, setCurrent] = useState(''),
    [outcome, setOutcome] = useState<PrintOutcome | null>(null),
    [help, setHelp] = useState(false),
    [keyboard, setKeyboard] = useState<false | 'identifier' | 'proof'>(false),
    [warning, setWarning] = useState<number | null>(null),
    [setupUrl, setSetupUrl] = useState('https://'),
    [setupCode, setSetupCode] = useState('');
  const generation = useRef(0),
    printLock = useRef(false),
    lastActivity = useRef(Date.now()),
    screenRef = useRef(screen),
    sessionRef = useRef<Session | null>(null),
    alive = useRef(true),
    field = useRef<HTMLInputElement>(null);
  screenRef.current = screen;
  sessionRef.current = session;
  const t = useCallback((k: Label) => dictionaries[language][k], [language]);
  const showError = (e: unknown) =>
    setError(
      e instanceof Error
        ? language === 'ru'
          ? (errorMessages[e.message] ?? t('error'))
          : t('error')
        : t('error'),
    );
  const loadConfig = async () => {
    const c = await api<Config>('/api/v1/config');
    await applyConfig(c);
    setConfig(c);
    setLanguage(c.defaultLanguage);
    setContrast(c.highContrast);
  };
  const finish = useCallback(async () => {
    generation.current++;
    setSession(null);
    setItems([]);
    setSelected([]);
    setBytes(null);
    setIdentifier('');
    setProof('');
    setChallenge('');
    setOutcome(null);
    setWarning(null);
    setError('');
    setBusy(false);
    setKeyboard(false);
    setScreen('home');
    lastActivity.current = Date.now();
    try {
      await api('/api/v1/reset', 'POST', {});
    } catch {
      /* session expiry is the server fallback */
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        if (await localReady()) {
          await api('/api/v1/reset', 'POST', {});
          await loadConfig();
        } else setScreen('setup');
      } catch (e) {
        showError(e);
        setScreen('setup');
      } finally {
        setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    const touch = () => {
      lastActivity.current = Date.now();
    };
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    const timer = setInterval(() => {
      if (['home', 'setup'].includes(screenRef.current) || printLock.current) return;
      const elapsed = (Date.now() - lastActivity.current) / 1000;
      const idle = config.timers.idleSeconds,
        warn = config.timers.warningSeconds;
      if (elapsed >= idle + warn) void finish();
      else setWarning(elapsed >= idle ? Math.ceil(idle + warn - elapsed) : null);
    }, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
    };
  }, [config.timers, finish]);
  useEffect(() => {
    if (screen !== 'done' || !outcome || outcome.uncertain || outcome.failed.length) return;
    const id = setTimeout(() => void finish(), config.timers.successSeconds * 1000);
    return () => clearTimeout(id);
  }, [screen, outcome, config.timers.successSeconds, finish]);
  useEffect(() => {
    if (screen === 'setup') return;
    const id = setInterval(() => {
      void deviceHealth()
        .then((health) =>
          api('/api/v1/heartbeat', 'POST', { version: '0.1.0', ...(health ? { health } : {}) }),
        )
        .catch((e) => {
          if (e instanceof Error && e.message === 'UNAUTHORIZED') {
            void finish();
            setScreen('setup');
          }
        });
      if (screenRef.current === 'home' && !printLock.current) void loadConfig().catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [screen === 'setup']);
  useEffect(() => {
    if (!isNative) return;
    let remove: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{
          kind: string;
          value?: string;
          omsNumber?: string;
          dateOfBirth?: string;
          fullName?: string;
        }>('scanner-scan', ({ payload: p }) => {
          if (!['methods', 'identify', 'home'].includes(screenRef.current)) return;
          lastActivity.current = Date.now();
          setError('');
          if (p.kind === 'oms') {
            const m = config.methods.includes('oms-birth')
              ? 'oms-birth'
              : config.methods.includes('oms-name')
                ? 'oms-name'
                : null;
            if (!m) return;
            setMethod(m);
            setIdentifier(p.omsNumber ?? '');
            setProof(m === 'oms-birth' ? (p.dateOfBirth ?? '') : (p.fullName ?? ''));
            setScreen('identify');
          } else if (p.value) {
            const m = config.methods.includes('barcode')
              ? 'barcode'
              : config.methods.includes('qr')
                ? 'qr'
                : null;
            if (!m) return;
            setMethod(m);
            setIdentifier(p.value);
            setScreen('identify');
          }
        }),
      )
      .then((fn) => {
        remove = fn;
      });
    return () => remove?.();
  }, [config.methods.join(',')]);
  async function run(action: () => Promise<void>) {
    if (busy || printLock.current) return;
    setBusy(true);
    setError('');
    const g = generation.current;
    try {
      await action();
    } catch (e) {
      if (g === generation.current) showError(e);
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  async function accept(s: Session, g: number) {
    if (g !== generation.current) {
      void api(`/api/v1/sessions/${s.sessionId}`, 'DELETE').catch(() => {});
      return;
    }
    setSession(s);
    const data = await api<Results>(`/api/v1/sessions/${s.sessionId}/results`);
    if (g !== generation.current) return;
    setItems(data.items);
    setCursor(data.nextCursor);
    setSelected([]);
    setScreen('results');
    setIdentifier('');
    setProof('');
    setKeyboard(false);
  }
  const identify = () =>
    run(async () => {
      const g = generation.current;
      lastActivity.current = Date.now();
      const body =
        screen === 'otp'
          ? { challengeId: challenge, code: proof }
          : {
              method,
              identifier: identifier.trim(),
              ...(['barcode', 'qr', 'phone-otp'].includes(method) ? {} : { proof: proof.trim() }),
            };
      const res = await api<Session | { challengeId: string }>(
        screen === 'otp' ? '/api/v1/identifications/confirm' : '/api/v1/identifications',
        'POST',
        body,
      );
      if (g !== generation.current) return;
      if ('challengeId' in res) {
        setChallenge(res.challengeId);
        setProof('');
        setScreen('otp');
      } else await accept(res, g);
    });
  async function preview(id: string) {
    await run(async () => {
      if (!session) return;
      const g = generation.current;
      const data = await pdfBytes(session.sessionId, id);
      if (g !== generation.current) return;
      setBytes(data);
      setCurrent(id);
      setScreen('preview');
    });
  }
  async function print(ids = selected) {
    if (!session || printLock.current || busy || !ids.length) return;
    printLock.current = true;
    setError('');
    setScreen('printing');
    const g = generation.current;
    const runId = crypto.randomUUID();
    try {
      const result = await printBatch(
        ids,
        async (id) => {
          const data = await pdfBytes(session.sessionId, id);
          await validatePdf(data);
          return data;
        },
        async (id) => submitPrint(session.sessionId, id, `${runId}:${id}`),
        () => alive.current && g === generation.current,
        (id) => setCurrent(id),
      );
      if (g !== generation.current) return;
      setOutcome(result);
      const remove = new Set([
        ...result.completed,
        ...(result.uncertain ? [result.uncertain] : []),
      ]);
      setSelected((s) => s.filter((id) => !remove.has(id)));
      setScreen('done');
    } finally {
      printLock.current = false;
      lastActivity.current = Date.now();
    }
  }
  const pick = (m: Method) => {
    setMethod(m);
    setIdentifier('');
    setProof('');
    setError('');
    setScreen('identify');
    setTimeout(() => field.current?.focus(), 0);
  };
  const primaryLabel = method.startsWith('oms')
    ? t('policy')
    : method === 'phone-otp'
      ? t('phone')
      : ['qr', 'barcode'].includes(method)
        ? t('token')
        : t('identifier');
  const proofLabel =
    method === 'oms-birth' ? t('birth') : method === 'oms-name' ? t('name') : t('proof');
  const style = {
    '--brand': config.brand.primary,
    '--ground': config.brand.background,
  } as CSSProperties;
  return (
    <div className={`kiosk ${contrast ? 'contrast' : ''}`} style={style}>
      <header className="kiosk-header">
        <div className="identity">
          {config.brand.logo ? (
            <img src={config.brand.logo} alt="" />
          ) : (
            <svg className="mark" viewBox="0 0 40 40" aria-hidden="true">
              <path
                d="M7 31V9h13a8 8 0 0 1 0 16H7m14-1 12 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path d="m24 7 8 8" stroke="currentColor" strokeWidth="3" />
            </svg>
          )}
          <strong>{config.brand.name}</strong>
        </div>
        <div className="header-actions">
          <button onClick={() => setContrast(!contrast)} aria-pressed={contrast}>
            Aa <span>{t('contrast')}</span>
          </button>
          <div className="languages">
            {config.languages.map((l) => (
              <button key={l} aria-pressed={l === language} onClick={() => setLanguage(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>
      {!isNative && screen !== 'setup' && <div className="demo-note">{t('demo')}</div>}
      <main className="kiosk-main" aria-busy={busy}>
        {screen === 'setup' ? (
          <section className="input-panel">
            <h1>{t('setup')}</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await enroll(setupUrl, setupCode);
                  await loadConfig();
                  setSetupCode('');
                  setScreen('home');
                });
              }}
            >
              <label>
                {t('gateway')}
                <input value={setupUrl} onChange={(e) => setSetupUrl(e.target.value)} required />
              </label>
              <label>
                {t('enrollment')}
                <input
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value)}
                  required
                  type="password"
                />
              </label>
              <button className="primary" disabled={busy}>
                {t('connect')}
              </button>
            </form>
          </section>
        ) : screen === 'home' ? (
          <section className="welcome">
            <div className="welcome-copy">
              <div className="service-label">
                {language === 'ru'
                  ? 'Получение медицинских документов'
                  : language === 'en'
                    ? 'Medical documents'
                    : '医疗报告'}
              </div>
              <h1>
                {t('title')
                  .split('\n')
                  .map((line, i) => (
                    <span key={i}>{line}</span>
                  ))}
              </h1>
              <p>{t('intro')}</p>
              <button
                className="primary start"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setScreen('methods');
                  lastActivity.current = Date.now();
                }}
              >
                {t('start')} <span aria-hidden="true">→</span>
              </button>
              <div className="privacy">
                <span aria-hidden="true">◈</span> {t('privacy')}
              </div>
            </div>
            <div className="steps" aria-label={t('start')}>
              {(['step1', 'step2', 'step3'] as Label[]).map((k, i) => (
                <div className="step" key={k}>
                  <span className="step-number">0{i + 1}</span>
                  <span>{t(k)}</span>
                  <span className="step-arrow" aria-hidden="true">
                    ↗
                  </span>
                </div>
              ))}
              <div className="paper-illustration" aria-hidden="true">
                <div className="paper">
                  <div className="paper-mark">R /</div>
                  <div className="paper-title">ResultsTerminal</div>
                  <div className="paper-lines">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="paper-sign">✓</div>
                </div>
              </div>
            </div>
          </section>
        ) : screen === 'methods' ? (
          <section>
            <div className="page-heading">
              <h1>{t('choose')}</h1>
              <p>{t('chooseHint')}</p>
            </div>
            <div className="method-grid">
              {config.methods.map((m, i) => (
                <button key={m} className="method" onClick={() => pick(m)}>
                  <span className="method-index">{String(i + 1).padStart(2, '0')}</span>
                  <span>{methodLabels[language][m]}</span>
                  <span aria-hidden="true">→</span>
                </button>
              ))}
            </div>
            {!config.methods.length && <p>{t('noMethods')}</p>}
          </section>
        ) : screen === 'identify' || screen === 'otp' ? (
          <section className="input-panel">
            <h1>{screen === 'otp' ? t('otp') : methodLabels[language][method]}</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void identify();
              }}
            >
              {screen !== 'otp' && (
                <label>
                  {primaryLabel}
                  <input
                    ref={field}
                    autoComplete="off"
                    maxLength={256}
                    value={identifier}
                    onFocus={() => setKeyboard('identifier')}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                  />
                </label>
              )}
              {(screen === 'otp' || !['barcode', 'qr', 'phone-otp'].includes(method)) && (
                <label>
                  {screen === 'otp' ? t('proof') : proofLabel}
                  <input
                    type={method === 'oms-birth' && screen !== 'otp' ? 'date' : 'text'}
                    autoComplete="off"
                    maxLength={200}
                    value={proof}
                    onFocus={() => setKeyboard('proof')}
                    onChange={(e) => setProof(e.target.value)}
                    required
                  />
                </label>
              )}
              <div className="form-actions">
                <button type="button" onClick={() => setKeyboard(keyboard ? false : 'identifier')}>
                  {t('keyboard')}
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? t('loading') : screen === 'otp' ? t('continue') : t('search')}
                </button>
              </div>
            </form>
            {keyboard && (
              <div className="keyboard" aria-label={t('keyboard')}>
                {(method === 'oms-name'
                  ? ['ЙЦУКЕНГШЩЗХЪ', 'ФЫВАПРОЛДЖЭ', 'ЯЧСМИТЬБЮ', '1234567890']
                  : ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM', '+-.']
                ).map((row) => (
                  <div key={row}>
                    {[...row].map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          keyboard === 'identifier'
                            ? setIdentifier((s) => (s + key).slice(0, 256))
                            : setProof((s) => (s + key).slice(0, 200))
                        }
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                ))}
                <div>
                  <button
                    onClick={() =>
                      keyboard === 'identifier'
                        ? setIdentifier((s) => s + ' ')
                        : setProof((s) => s + ' ')
                    }
                  >
                    ␣
                  </button>
                  <button
                    onClick={() =>
                      keyboard === 'identifier'
                        ? setIdentifier((s) => s.slice(0, -1))
                        : setProof((s) => s.slice(0, -1))
                    }
                  >
                    ⌫
                  </button>
                  <button onClick={() => setKeyboard(false)}>{t('close')}</button>
                </div>
              </div>
            )}
          </section>
        ) : screen === 'results' ? (
          <section>
            <div className="page-heading">
              <h1>{t('results')}</h1>
              <p>
                {session?.patient.displayName} · {t('select')}
              </p>
            </div>
            <div className="results-list">
              {items.map((item) => (
                <div className="result-row" key={item.id}>
                  <input
                    type="checkbox"
                    aria-label={item.title}
                    disabled={!item.pdfAvailable || item.status !== 'ready'}
                    checked={selected.includes(item.id)}
                    onChange={() =>
                      setSelected((s) =>
                        s.includes(item.id) ? s.filter((id) => id !== item.id) : [...s, item.id],
                      )
                    }
                  />
                  <div>
                    <small>
                      {item.category} · {item.date}
                    </small>
                    <h2>{item.title}</h2>
                    <span className={`status ${item.status}`}>
                      {t(item.status === 'ready' ? 'ready' : 'pending')}
                    </span>
                  </div>
                  {config.preview && item.pdfAvailable && item.status === 'ready' && (
                    <button disabled={busy} onClick={() => void preview(item.id)}>
                      {t('preview')} ↗
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!items.length && <p className="empty">{t('empty')}</p>}
            {cursor && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const g = generation.current;
                    const page = await api<Results>(
                      `/api/v1/sessions/${session!.sessionId}/results?cursor=${encodeURIComponent(cursor)}`,
                    );
                    if (g !== generation.current) return;
                    setItems((s) => [
                      ...s,
                      ...page.items.filter((x) => !s.some((y) => y.id === x.id)),
                    ]);
                    setCursor(page.nextCursor);
                  })
                }
              >
                {t('loadMore')}
              </button>
            )}
            <div className="selection-bar">
              <span>
                {t('selected')}: <strong>{selected.length}</strong>
              </span>
              {config.printing && (
                <button
                  className="primary"
                  disabled={!selected.length || busy || !isNative}
                  onClick={() => void print()}
                >
                  {t('print')} →
                </button>
              )}
            </div>
          </section>
        ) : screen === 'preview' && bytes ? (
          <section>
            <div className="page-heading">
              <h1>{items.find((i) => i.id === current)?.title}</h1>
              <div className="form-actions">
                <button
                  onClick={() => {
                    setBytes(null);
                    setScreen('results');
                  }}
                >
                  {t('back')}
                </button>
                {config.printing && (
                  <button
                    className="primary"
                    disabled={!isNative}
                    onClick={() => void print([current])}
                  >
                    {t('print')}
                  </button>
                )}
              </div>
            </div>
            <PdfViewer bytes={bytes} t={t} />
          </section>
        ) : screen === 'printing' ? (
          <section className="completion">
            <div className="completion-mark">↗</div>
            <h1>{t('printing')}</h1>
            <p>{items.find((i) => i.id === current)?.title}</p>
            <p>{t('wait')}</p>
          </section>
        ) : (
          <section className="completion">
            <div className="completion-mark">{outcome?.uncertain ? '!' : '✓'}</div>
            <h1>
              {outcome?.uncertain
                ? t('uncertain')
                : outcome?.failed.length
                  ? t('partial')
                  : t('done')}
            </h1>
            <p>{outcome?.uncertain ? t('uncertainHint') : t('take')}</p>
            <p>
              {t('printed')}: {outcome?.completed.length ?? 0}
            </p>
            {outcome?.failed.map((id) => (
              <p key={id}>{items.find((i) => i.id === id)?.title}</p>
            ))}
            <div className="form-actions">
              {!!outcome?.failed.length && (
                <button className="primary" onClick={() => void print(outcome.failed)}>
                  {t('retry')}
                </button>
              )}
              <button onClick={() => void finish()}>{t('exit')}</button>
            </div>
          </section>
        )}
        {busy && screen !== 'home' && (
          <p className="loading" role="status">
            {t('loading')}
          </p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </main>
      <footer className="kiosk-footer">
        <div>
          <span className="connection-dot" />
          {config.brand.contacts || 'ResultsTerminal'}
        </div>
        <div className="footer-actions">
          {!['home', 'setup', 'printing'].includes(screen) && (
            <button
              onClick={() => {
                if (screen === 'identify') {
                  generation.current++;
                  setBusy(false);
                  void api('/api/v1/reset', 'POST', {}).catch(() => {});
                  setScreen('methods');
                  setError('');
                  setKeyboard(false);
                } else if (screen === 'methods') setScreen('home');
                else void finish();
              }}
            >
              {screen === 'identify' || screen === 'methods' ? t('back') : t('exit')}
            </button>
          )}
          <button onClick={() => setHelp(true)}>
            {t('help')} <span aria-hidden="true">?</span>
          </button>
        </div>
      </footer>
      {help && (
        <div className="overlay">
          <section role="dialog" aria-modal="true" aria-label={t('help')}>
            <h2>{t('help')}</h2>
            <p>{config.brand.help}</p>
            <p>{config.brand.contacts}</p>
            <button className="primary" autoFocus onClick={() => setHelp(false)}>
              {t('close')}
            </button>
          </section>
        </div>
      )}
      {warning !== null && (
        <div className="overlay">
          <section role="alertdialog" aria-modal="true" aria-label={t('sessionWarning')}>
            <h2>{t('sessionWarning')}</h2>
            <p>
              {t('timeout')} {warning} {t('seconds')}
            </p>
            <button
              className="primary"
              autoFocus
              onClick={() => {
                lastActivity.current = Date.now();
                setWarning(null);
              }}
            >
              {t('continue')}
            </button>
            <button onClick={() => void finish()}>{t('exit')}</button>
          </section>
        </div>
      )}
    </div>
  );
}
