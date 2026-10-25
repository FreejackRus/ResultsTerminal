import { useEffect, useState, type FormEvent } from 'react';
import { defaults, methods, themes, type Config, type Hardware, type Health } from '@rt/contracts';
import { methodLabels } from '../../terminal/src/i18n';
const titles = {
  institution: 'Учреждение',
  access: 'Получение результатов',
  integration: 'Подключение МИС',
  terminals: 'Терминалы',
  audit: 'Журнал событий',
  transfer: 'Импорт и экспорт',
};
type Tab = keyof typeof titles;
type Terminal = {
  id: string;
  name: string;
  hardware: Partial<Hardware>;
  revoked: number;
  last_seen: number | null;
  version: string | null;
  error: string | null;
  health: Health | null;
  timers: Partial<Config['timers']> | null;
};
async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api/admin' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-rt-admin': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json();
    throw Error(e.error?.code ?? 'NETWORK');
  }
  return res.json();
}
const deviceNames: Record<string, string> = {
  ready: 'Готов',
  busy: 'Занят',
  error: 'Ошибка',
  disconnected: 'Нет соединения',
  unknown: 'Не проверено',
};
const errors: Record<string, string> = {
  UNAUTHORIZED: 'Не удалось войти. Проверьте учётные данные.',
  FORBIDDEN: 'Действие недоступно. Для первого запуска нужен код настройки с сервера.',
  CONFLICT: 'Конфигурация уже изменена. Обновите страницу перед сохранением.',
  VALIDATION_ERROR: 'Проверьте значения полей. Настройки не сохранены.',
  MIS_UNAVAILABLE: 'Шлюз не смог подключиться к МИС. Проверьте адрес, сертификат и ключ.',
  INVALID_MIS_RESPONSE: 'Ответ МИС не соответствует контракту.',
  RATE_LIMITED: 'Слишком много попыток. Подождите и повторите.',
};
export default function App() {
  const [tab, setTab] = useState<Tab>('institution'),
    [signed, setSigned] = useState(false),
    [setup, setSetup] = useState(false),
    [busy, setBusy] = useState(true),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [config, setConfig] = useState<Config>(defaults),
    [integration, setIntegration] = useState({
      url: '',
      key: '',
      ca: '',
      timeoutMs: 30000,
      keyConfigured: false,
    }),
    [terminals, setTerminals] = useState<Terminal[]>([]),
    [audit, setAudit] = useState<{ time: string; event: string; subject: string }[]>([]),
    [name, setName] = useState(''),
    [enrollment, setEnrollment] = useState(''),
    [edit, setEdit] = useState<{ id: string; hardware: Hardware; timers: Config['timers'] } | null>(
      null,
    ),
    [capabilities, setCapabilities] = useState<string[]>([]);
  const load = async () => {
    const c = await request<Config>('/config');
    setConfig(c);
    const i = await request('/integration');
    setIntegration({ ...i, key: '' });
    setTerminals(await request('/terminals'));
    setAudit(await request('/audit'));
    setSigned(true);
  };
  useEffect(() => {
    if (!signed || tab !== 'terminals') return;
    const id = setInterval(() => {
      void request<Terminal[]>('/terminals')
        .then(setTerminals)
        .catch(() => setError('Нет связи со шлюзом. Данные мониторинга устарели.'));
    }, 15000);
    return () => clearInterval(id);
  }, [signed, tab]);
  useEffect(() => {
    void (async () => {
      try {
        const s = await request('/status');
        setSetup(s.setupRequired);
        if (!s.setupRequired) await load();
      } catch {
        /* show sign in */
      } finally {
        setBusy(false);
      }
    })();
  }, []);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(
        errors[(e as Error).message] ??
          'Не удалось выполнить действие. Проверьте соединение со шлюзом.',
      );
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    perform(async () => {
      setConfig(await request('/config', 'PUT', config));
      setMessage('Новая версия опубликована. Терминалы применят её между сеансами пациентов.');
    });
  function field(key: keyof Config, value: any) {
    setConfig((c) => ({ ...c, [key]: value }));
  }
  const input = (label: string, value: string, onChange: (s: string) => void, type = 'text') => (
    <label>
      {label}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
  const check = (label: string, checked: boolean, change: () => void) => (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={change} />
      <span>{label}</span>
    </label>
  );
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await perform(async () => {
      await request(setup ? '/setup' : '/login', 'POST', {
        username: data.get('username'),
        password: data.get('password'),
        ...(setup ? { setupToken: data.get('setupToken') } : {}),
      });
      await load();
      setSetup(false);
    });
  }
  const brand = (key: keyof Config['brand'], value: string) =>
    field('brand', { ...config.brand, [key]: value });
  return (
    <div className="admin-shell">
      <aside>
        <div className="product">
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <path
              d="M6 29V7h13a8 8 0 0 1 0 16H6m14-1 11 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
            />
          </svg>
          <strong>ResultsTerminal</strong>
        </div>
        <div className="workspace">
          {config.brand.name}
          <small>Локальный шлюз учреждения</small>
        </div>
        <nav>
          {(Object.keys(titles) as Tab[]).map((k) => (
            <button
              key={k}
              disabled={!signed}
              className={tab === k ? 'active' : ''}
              onClick={() => {
                setTab(k);
                setError('');
                setMessage('');
                location.hash = k;
                if (k === 'terminals' || k === 'audit')
                  void perform(async () => {
                    setTerminals(await request('/terminals'));
                    setAudit(await request('/audit'));
                  });
              }}
            >
              {titles[k]}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          Версия 0.1.0
          {signed && (
            <button
              onClick={() =>
                void perform(async () => {
                  await request('/logout', 'POST', {});
                  setSigned(false);
                })
              }
            >
              Выйти из панели
            </button>
          )}
        </div>
      </aside>
      <div className="admin-work">
        <header>
          <span>Управление учреждением</span>
          <span className="version">Конфигурация v{config.version}</span>
        </header>
        <main>
          {!signed ? (
            <section className="login">
              <span className="eyebrow">ResultsTerminal / Администрирование</span>
              <h1>{setup ? 'Первоначальная настройка' : 'Вход в панель'}</h1>
              <p>
                {setup
                  ? 'Создайте учётную запись администратора локального шлюза.'
                  : 'Настройки учреждения и подключённых терминалов.'}
              </p>
              <form onSubmit={login}>
                <label>
                  Имя администратора
                  <input name="username" autoComplete="username" required />
                </label>
                <label>
                  Пароль
                  <input
                    name="password"
                    type="password"
                    autoComplete={setup ? 'new-password' : 'current-password'}
                    minLength={setup ? 12 : 1}
                    maxLength={128}
                    required
                  />
                </label>
                {setup && (
                  <label>
                    Код первоначальной настройки
                    <input name="setupToken" type="password" autoComplete="off" required />
                    <small>Получите код у администратора сервера. В демо: demo-setup-local.</small>
                  </label>
                )}
                <button className="primary" disabled={busy}>
                  {setup ? 'Создать администратора' : 'Войти'}
                </button>
              </form>
            </section>
          ) : (
            <>
              <div className="title-row">
                <div>
                  <h1>{titles[tab]}</h1>
                  <p>
                    {tab === 'institution'
                      ? 'Один продукт — оформление вашего учреждения.'
                      : tab === 'access'
                        ? 'Включайте только способы, поддерживаемые вашей МИС.'
                        : tab === 'integration'
                          ? 'Данные запрашиваются из МИС при обращении пациента.'
                          : tab === 'terminals'
                            ? 'Индивидуальные настройки оборудования и доступ к шлюзу.'
                            : tab === 'audit'
                              ? 'Технические события без медицинских данных.'
                              : 'Перенос настроек без ключей МИС и учётных данных.'}
                  </p>
                </div>
                {['institution', 'access'].includes(tab) && (
                  <button className="primary" disabled={busy} onClick={() => void save()}>
                    Опубликовать настройки
                  </button>
                )}
              </div>
              {tab === 'institution' && (
                <>
                  <section className="settings-section">
                    <div>
                      <h2>Фирменное оформление</h2>
                      <p>
                        Название и цвета применяются ко всем терминалам. Предпросмотр показывает
                        стартовый экран.
                      </p>
                      <div className="preset-row">
                        {Object.entries(themes).map(([id, b]) => (
                          <button key={id} onClick={() => field('brand', b)}>
                            {id === 'neutral'
                              ? 'Нейтральная'
                              : id === 'clinic'
                                ? 'Клиника «Север»'
                                : 'Центр «Линия»'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-panel">
                      {input('Название учреждения', config.brand.name, (v) => brand('name', v))}
                      <div className="color-row">
                        {input(
                          'Основной цвет',
                          config.brand.primary,
                          (v) => brand('primary', v),
                          'color',
                        )}
                        {input(
                          'Фон',
                          config.brand.background,
                          (v) => brand('background', v),
                          'color',
                        )}
                      </div>
                      <label>
                        Логотип PNG или WebP
                        <input
                          type="file"
                          accept="image/png,image/webp"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (file.size > 300000) {
                              setError('Размер логотипа — до 300 КБ.');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onload = () => brand('logo', String(reader.result));
                            reader.readAsDataURL(file);
                          }}
                        />
                      </label>
                      {config.brand.logo && (
                        <button onClick={() => brand('logo', '')}>Удалить логотип</button>
                      )}
                      <div
                        className="terminal-preview"
                        style={{ background: config.brand.background, color: config.brand.primary }}
                      >
                        {config.brand.logo && <img src={config.brand.logo} alt="Логотип" />}
                        <strong>{config.brand.name}</strong>
                        <h3>
                          Ваши результаты.
                          <br />
                          Без очереди.
                        </h3>
                        <span>Получить результаты →</span>
                      </div>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div>
                      <h2>Помощь пациенту</h2>
                      <p>Контакты и инструкция доступны на каждом экране терминала.</p>
                    </div>
                    <div className="settings-panel">
                      {input('Контактная информация', config.brand.contacts, (v) =>
                        brand('contacts', v),
                      )}
                      <label>
                        Текст помощи
                        <textarea
                          value={config.brand.help}
                          onChange={(e) => brand('help', e.target.value)}
                        />
                      </label>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div>
                      <h2>Языки и доступность</h2>
                      <p>Пациент может переключить язык и крупный шрифт в любой момент.</p>
                    </div>
                    <div className="settings-panel">
                      {(['ru', 'en', 'zh'] as const).map((l) => (
                        <div key={l}>
                          {check(
                            { ru: 'Русский', en: 'English', zh: '中文' }[l],
                            config.languages.includes(l),
                            () =>
                              field(
                                'languages',
                                config.languages.includes(l)
                                  ? config.languages.filter((v) => v !== l)
                                  : [...config.languages, l],
                              ),
                          )}
                        </div>
                      ))}
                      <label>
                        Язык по умолчанию
                        <select
                          value={config.defaultLanguage}
                          onChange={(e) => field('defaultLanguage', e.target.value)}
                        >
                          {config.languages.map((l) => (
                            <option key={l}>{l}</option>
                          ))}
                        </select>
                      </label>
                      {check('Крупный шрифт по умолчанию', config.highContrast, () =>
                        field('highContrast', !config.highContrast),
                      )}
                    </div>
                  </section>
                </>
              )}
              {tab === 'access' && (
                <>
                  <section className="settings-section">
                    <div>
                      <h2>Идентификация</h2>
                      <p>
                        Шлюз дополнительно проверяет возможности МИС. ОМС с ФИО включается только по
                        решению учреждения.
                      </p>
                    </div>
                    <div className="settings-panel">
                      {methods.map((m) => (
                        <div key={m}>
                          {check(methodLabels.ru[m], config.methods.includes(m), () =>
                            field(
                              'methods',
                              config.methods.includes(m)
                                ? config.methods.filter((x) => x !== m)
                                : [...config.methods, m],
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="settings-section">
                    <div>
                      <h2>Документы и сеанс</h2>
                      <p>
                        Печать выполняется на выбранном принтере терминала. Таймер предупреждает
                        пациента перед очисткой сеанса.
                      </p>
                    </div>
                    <div className="settings-panel">
                      {check('Просмотр PDF', config.preview, () =>
                        field('preview', !config.preview),
                      )}
                      {check('Печать PDF', config.printing, () =>
                        field('printing', !config.printing),
                      )}
                      {Object.entries({
                        idleSeconds: 'До предупреждения, сек.',
                        warningSeconds: 'Предупреждение, сек.',
                        successSeconds: 'Выход после успеха, сек.',
                      }).map(([k, label]) => (
                        <div key={k}>
                          {input(
                            label,
                            String(config.timers[k as keyof typeof config.timers]),
                            (v) => field('timers', { ...config.timers, [k]: Number(v) }),
                            'number',
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
              {tab === 'integration' && (
                <section className="settings-section">
                  <div>
                    <h2>API медицинской системы</h2>
                    <p>
                      МИС реализует контракт /integration/v1. HTTPS и доверенный сертификат
                      обязательны вне локального демо.
                    </p>
                    <p>Ключ хранится на шлюзе в зашифрованном виде и не передаётся терминалам.</p>
                    <a href="https://github.com/FreejackRus/ResultsTerminal/tree/main/docs">
                      Документация интеграции ↗
                    </a>
                  </div>
                  <form
                    className="settings-panel"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void perform(async () => {
                        const { keyConfigured, ...body } = integration;
                        await request('/integration', 'PUT', {
                          ...body,
                          ...(!body.key ? { key: undefined } : {}),
                        });
                        setIntegration((i) => ({ ...i, key: '', keyConfigured: true }));
                        setMessage('Настройки подключения сохранены.');
                      });
                    }}
                  >
                    {input('Базовый адрес API', integration.url, (v) =>
                      setIntegration((i) => ({ ...i, url: v })),
                    )}
                    <label>
                      Ключ доступа
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={integration.key}
                        placeholder={
                          integration.keyConfigured
                            ? 'Сохранён. Оставьте поле пустым для сохранения ключа'
                            : 'Введите ключ'
                        }
                        onChange={(e) => setIntegration((i) => ({ ...i, key: e.target.value }))}
                      />
                    </label>
                    <label>
                      Доверенный CA-сертификат PEM
                      <textarea
                        value={integration.ca}
                        onChange={(e) => setIntegration((i) => ({ ...i, ca: e.target.value }))}
                      />
                      <small>Оставьте пустым для использования системного доверия.</small>
                    </label>
                    {input(
                      'Таймаут запроса, мс',
                      String(integration.timeoutMs),
                      (v) => setIntegration((i) => ({ ...i, timeoutMs: Number(v) })),
                      'number',
                    )}
                    <div className="actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const caps = await request('/integration/check', 'POST', {});
                            setCapabilities(caps.methods);
                            setMessage('Подключение проверено.');
                          })
                        }
                      >
                        Проверить сохранённое подключение
                      </button>
                      <button className="primary" disabled={busy}>
                        Сохранить
                      </button>
                    </div>
                    {!!capabilities.length && (
                      <p>
                        Поддерживаются:{' '}
                        {capabilities
                          .map((m) => methodLabels.ru[m as keyof typeof methodLabels.ru])
                          .join(', ')}
                      </p>
                    )}
                  </form>
                </section>
              )}
              {tab === 'terminals' && (
                <>
                  <section className="enroll-row">
                    <div>
                      <h2>Новый терминал</h2>
                      <p>Код действует 10 минут и используется один раз.</p>
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void perform(async () => {
                          const res = await request('/enrollments', 'POST', { name });
                          setEnrollment(res.code);
                          setName('');
                        });
                      }}
                    >
                      <label>
                        Название терминала
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          required
                          maxLength={200}
                        />
                      </label>
                      <button className="primary" disabled={busy}>
                        Создать код регистрации
                      </button>
                    </form>
                  </section>
                  {enrollment && (
                    <div className="notice">
                      <label>
                        Одноразовый код
                        <input readOnly value={enrollment} onFocus={(e) => e.target.select()} />
                      </label>
                      <p>Введите код в приложении ResultsTerminal на новом устройстве.</p>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(enrollment);
                          setMessage('Код скопирован.');
                        }}
                      >
                        Скопировать
                      </button>
                    </div>
                  )}
                  <div className="terminal-table">
                    <div className="table-head">
                      <span>Терминал</span>
                      <span>Подключение</span>
                      <span>Сканер / принтер</span>
                      <span>Действия</span>
                    </div>
                    {terminals.map((v) => (
                      <div className="table-row" key={v.id}>
                        <div>
                          <strong>{v.name}</strong>
                          <small>{v.id.slice(0, 8)}</small>
                        </div>
                        <div>
                          <span>
                            {v.revoked
                              ? 'Доступ отозван'
                              : v.last_seen && Date.now() - v.last_seen < 90000
                                ? 'На связи'
                                : 'Нет связи'}
                          </span>
                          <small>
                            {v.last_seen
                              ? new Date(v.last_seen).toLocaleString('ru')
                              : 'Ещё не подключался'}
                            {v.error && v.error !== 'NONE' ? ' · ' + v.error : ''}
                          </small>
                        </div>
                        <div className="device-health">
                          <span>
                            Сканер:{' '}
                            {v.last_seen &&
                            Date.now() - v.last_seen < 90000 &&
                            v.health &&
                            Date.now() - Date.parse(v.health.checkedAt) < 90000
                              ? deviceNames[v.health.scanner.state]
                              : 'Нет свежих данных'}
                          </span>
                          <span>
                            Принтер:{' '}
                            {v.last_seen &&
                            Date.now() - v.last_seen < 90000 &&
                            v.health &&
                            Date.now() - Date.parse(v.health.checkedAt) < 90000
                              ? deviceNames[v.health.printer.state]
                              : 'Нет свежих данных'}
                          </span>
                          {v.health && (
                            <small
                              title={`CPU ${v.health.cpuPercent.toFixed(0)}%; RAM ${v.health.memoryUsedMb.toFixed(0)} / ${v.health.memoryTotalMb.toFixed(0)} МБ; диск ${v.health.diskFreeGb.toFixed(1)} ГБ`}
                            >
                              {v.health.os} · CPU {v.health.cpuPercent.toFixed(0)}% · диск{' '}
                              {v.health.diskFreeGb.toFixed(1)} ГБ
                              <br />
                              RAM {v.health.memoryUsedMb.toFixed(0)} /{' '}
                              {v.health.memoryTotalMb.toFixed(0)} МБ
                              <br />
                              {new Date(v.health.checkedAt).toLocaleTimeString('ru')} · v
                              {v.version ?? '—'}
                              <br />
                              {v.health.scanner.code} / {v.health.printer.code}
                            </small>
                          )}
                        </div>
                        <div className="actions">
                          <button
                            disabled={!!v.revoked}
                            onClick={() =>
                              setEdit({
                                id: v.id,
                                hardware: { ...config.hardware, ...v.hardware },
                                timers: { ...config.timers, ...v.timers },
                              })
                            }
                          >
                            Оборудование
                          </button>
                          <button
                            disabled={!!v.revoked}
                            onClick={() => {
                              if (confirm(`Отозвать доступ терминала «${v.name}»?`))
                                void perform(async () => {
                                  await request(`/terminals/${v.id}/revoke`, 'POST', {});
                                  setTerminals(await request('/terminals'));
                                });
                            }}
                          >
                            Отозвать
                          </button>
                        </div>
                      </div>
                    ))}
                    {!terminals.length && (
                      <p className="empty">
                        Терминалы ещё не зарегистрированы. Создайте код для первого устройства.
                      </p>
                    )}
                  </div>
                  {edit && (
                    <div className="modal">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void perform(async () => {
                            await request(`/terminals/${edit.id}/settings`, 'PUT', {
                              version: config.version,
                              hardware: edit.hardware,
                              timers: edit.timers,
                            });
                            setConfig(await request('/config'));
                            setEdit(null);
                            setTerminals(await request('/terminals'));
                          });
                        }}
                      >
                        <h2>Оборудование терминала</h2>
                        {input('Имя принтера', edit.hardware.printer, (v) =>
                          setEdit((x) => x && { ...x, hardware: { ...x.hardware, printer: v } }),
                        )}
                        <label>
                          Режим сканера
                          <select
                            value={edit.hardware.scannerMode}
                            onChange={(e) =>
                              setEdit(
                                (x) =>
                                  x && {
                                    ...x,
                                    hardware: {
                                      ...x.hardware,
                                      scannerMode: e.target.value as 'hid' | 'serial',
                                    },
                                  },
                              )
                            }
                          >
                            <option value="hid">HID-клавиатура</option>
                            <option value="serial">COM / USB-serial</option>
                          </select>
                        </label>
                        {input('COM-порт или /dev/serial/by-id/…', edit.hardware.serialPort, (v) =>
                          setEdit((x) => x && { ...x, hardware: { ...x.hardware, serialPort: v } }),
                        )}
                        {input(
                          'Идентификатор HID (PNPDeviceID или /dev/input/by-id/…)',
                          edit.hardware.hidDeviceId ?? '',
                          (v) =>
                            setEdit(
                              (x) => x && { ...x, hardware: { ...x.hardware, hidDeviceId: v } },
                            ),
                        )}
                        {input(
                          'Путь к SumatraPDF.exe (Windows)',
                          edit.hardware.pdfHelper ?? '',
                          (v) =>
                            setEdit(
                              (x) => x && { ...x, hardware: { ...x.hardware, pdfHelper: v } },
                            ),
                        )}
                        {input(
                          'Скорость порта',
                          String(edit.hardware.baudRate),
                          (v) =>
                            setEdit(
                              (x) =>
                                x && { ...x, hardware: { ...x.hardware, baudRate: Number(v) } },
                            ),
                          'number',
                        )}
                        {input('Шаблон токена сканера', edit.hardware.scanPattern, (v) =>
                          setEdit(
                            (x) => x && { ...x, hardware: { ...x.hardware, scanPattern: v } },
                          ),
                        )}
                        {Object.entries({
                          idleSeconds: 'До предупреждения, сек.',
                          warningSeconds: 'Предупреждение, сек.',
                          successSeconds: 'Выход после успеха, сек.',
                        }).map(([key, label]) => (
                          <div key={key}>
                            {input(
                              label,
                              String(edit.timers[key as keyof Config['timers']]),
                              (value) =>
                                setEdit(
                                  (x) =>
                                    x && { ...x, timers: { ...x.timers, [key]: Number(value) } },
                                ),
                              'number',
                            )}
                          </div>
                        ))}
                        <div className="actions">
                          <button type="button" onClick={() => setEdit(null)}>
                            Отмена
                          </button>
                          <button className="primary" disabled={busy}>
                            Сохранить
                          </button>
                        </div>
                      </form>
                    </div>
                  )}
                </>
              )}
              {tab === 'audit' && (
                <>
                  <button
                    onClick={() => void perform(async () => setAudit(await request('/audit')))}
                  >
                    Обновить журнал
                  </button>
                  <div className="audit-table">
                    {audit.map((a, i) => (
                      <div key={i}>
                        <time>{new Date(a.time).toLocaleString('ru')}</time>
                        <strong>{a.event}</strong>
                        <code>{a.subject.slice(0, 8) || '—'}</code>
                      </div>
                    ))}
                    {!audit.length && <p>Событий пока нет.</p>}
                  </div>
                </>
              )}
              {tab === 'transfer' && (
                <section className="settings-section">
                  <div>
                    <h2>Конфигурация учреждения</h2>
                    <p>
                      Экспорт содержит оформление, способы входа и общие настройки. Пароли, ключи,
                      регистрация и индивидуальные профили терминалов не экспортируются.
                    </p>
                  </div>
                  <div className="settings-panel">
                    <button
                      onClick={() =>
                        void perform(async () => {
                          const c = await request('/export');
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }),
                          );
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'results-terminal-config.json';
                          a.click();
                          URL.revokeObjectURL(url);
                        })
                      }
                    >
                      Скачать конфигурацию
                    </button>
                    <label>
                      Импорт JSON
                      <input
                        type="file"
                        accept="application/json,.json"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          void perform(async () => {
                            if (f.size > 800000) throw Error('VALIDATION_ERROR');
                            setConfig(await request('/import', 'POST', JSON.parse(await f.text())));
                            setMessage('Конфигурация импортирована и опубликована.');
                          });
                        }}
                      />
                    </label>
                  </div>
                </section>
              )}
            </>
          )}
          {busy && (
            <div className="feedback" role="status">
              Загрузка…
            </div>
          )}
          {message && (
            <div className="feedback success" role="status">
              {message}
            </div>
          )}
          {error && (
            <div className="feedback error" role="alert">
              {error}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
