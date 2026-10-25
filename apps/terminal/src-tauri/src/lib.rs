use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
mod monitoring;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
struct Enrollment {
    url: String,
    token: String,
}
#[derive(Default)]
struct Native {
    enrollment: Option<Enrollment>,
    config: Value,
    pdfs: HashMap<String, Vec<u8>>,
    claimed: HashMap<String, u64>,
    printing: bool,
    health: Value,
    serial_connected: bool,
}
#[derive(Clone)]
struct Runtime {
    state: Arc<Mutex<Native>>,
    dir: PathBuf,
}
#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|_| "CONFIG".to_string())?;
    file.write_all(bytes).map_err(|_| "CONFIG".to_string())?;
    file.sync_all().map_err(|_| "CONFIG".to_string())
}
fn safe_base(value: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(value).map_err(|_| "CONFIG")?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || !(u.scheme() == "https" || (cfg!(debug_assertions) && local && u.scheme() == "http"))
    {
        return Err("CONFIG".into());
    }
    Ok(u)
}
fn allowed(path: &str, method: &str) -> bool {
    if path.contains("..") || path.contains('\\') || path.contains('#') || path.contains('%') {
        return false;
    }
    match method {
        "GET" => path == "/api/v1/config" || path.starts_with("/api/v1/sessions/"),
        "POST" => matches!(
            path,
            "/api/v1/identifications"
                | "/api/v1/identifications/confirm"
                | "/api/v1/heartbeat"
                | "/api/v1/reset"
        ),
        "DELETE" => path.starts_with("/api/v1/sessions/"),
        _ => false,
    }
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "NETWORK".into())
}
fn send(
    runtime: &Runtime,
    path: &str,
    method: &str,
    body: &Value,
) -> Result<(u16, Vec<u8>, String), String> {
    if !allowed(path.split('?').next().unwrap_or(""), method) {
        return Err("FORBIDDEN".into());
    }
    let enrollment = runtime
        .state
        .lock()
        .map_err(|_| "CONFIG")?
        .enrollment
        .clone()
        .ok_or("UNAUTHORIZED")?;
    let url = safe_base(&enrollment.url)?
        .join(path)
        .map_err(|_| "CONFIG")?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "FORBIDDEN")?;
    let mut req = client()?.request(m, url).bearer_auth(enrollment.token);
    if !body.is_null() {
        req = req.json(body);
    }
    let response = req.send().map_err(|_| "NETWORK")?;
    let status = response.status().as_u16();
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let limit = if path.ends_with("/pdf") {
        25 * 1024 * 1024
    } else {
        1024 * 1024
    };
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "NETWORK")?;
    if bytes.len() as u64 > limit {
        return Err("INVALID_MIS_RESPONSE".into());
    }
    Ok((status, bytes, mime))
}
#[tauri::command]
fn is_enrolled(runtime: State<'_, Runtime>) -> bool {
    runtime
        .state
        .lock()
        .map(|v| v.enrollment.is_some())
        .unwrap_or(false)
}
#[tauri::command]
async fn enroll(runtime: State<'_, Runtime>, url: String, code: String) -> Result<(), String> {
    let rt = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = safe_base(&url)?;
        let response = client()?
            .post(base.join("/api/v1/enroll").map_err(|_| "CONFIG")?)
            .json(&json!({"code":code}))
            .send()
            .map_err(|_| "NETWORK")?;
        if !response.status().is_success() {
            return Err("UNAUTHORIZED".into());
        }
        let value: Value = response.json().map_err(|_| "INVALID_MIS_RESPONSE")?;
        let token = value["token"]
            .as_str()
            .ok_or("INVALID_MIS_RESPONSE")?
            .to_owned();
        let e = Enrollment { url, token };
        private_write(
            &rt.dir.join("enrollment.json"),
            &serde_json::to_vec(&e).map_err(|_| "CONFIG")?,
        )?;
        rt.state.lock().map_err(|_| "CONFIG")?.enrollment = Some(e);
        Ok(())
    })
    .await
    .map_err(|_| "NETWORK".to_string())?
}
#[tauri::command]
async fn api_request(
    runtime: State<'_, Runtime>,
    path: String,
    method: String,
    body: Value,
) -> Result<ApiResponse, String> {
    let rt = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (status, bytes, _) = send(&rt, &path, &method, &body)?;
        if path == "/api/v1/reset" || method == "DELETE" || path == "/api/v1/identifications" {
            rt.state.lock().map_err(|_| "CONFIG")?.pdfs.clear();
        }
        Ok(ApiResponse {
            status,
            body: String::from_utf8(bytes).map_err(|_| "INVALID_MIS_RESPONSE")?,
        })
    })
    .await
    .map_err(|_| "NETWORK".to_string())?
}
fn fetch_pdf(rt: &Runtime, path: &str) -> Result<Vec<u8>, String> {
    if !path.ends_with("/pdf") {
        return Err("FORBIDDEN".into());
    }
    let (status, bytes, mime) = send(rt, path, "GET", &Value::Null)?;
    if status != 200 || !mime.starts_with("application/pdf") || !bytes.starts_with(b"%PDF-") {
        return Err("INVALID_MIS_RESPONSE".into());
    }
    let mut state = rt.state.lock().map_err(|_| "CONFIG")?;
    if state.pdfs.len() >= 10 {
        state.pdfs.clear();
    }
    state.pdfs.insert(path.to_string(), bytes.clone());
    Ok(bytes)
}
#[tauri::command]
async fn get_pdf(runtime: State<'_, Runtime>, path: String) -> Result<Vec<u8>, String> {
    let rt = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || fetch_pdf(&rt, &path))
        .await
        .map_err(|_| "NETWORK".to_string())?
}
#[tauri::command]
fn get_health(runtime: State<'_, Runtime>) -> Value {
    runtime
        .state
        .lock()
        .map(|s| s.health.clone())
        .unwrap_or(Value::Null)
}
#[tauri::command]
fn apply_config(runtime: State<'_, Runtime>, config: Value) -> Result<(), String> {
    let h = &config["hardware"];
    let pattern = h["scanPattern"].as_str().ok_or("CONFIG")?;
    if pattern.len() > 120 || regex::Regex::new(pattern).is_err() {
        return Err("CONFIG".into());
    }
    let mut state = runtime.state.lock().map_err(|_| "CONFIG")?;
    state.config = config;
    Ok(())
}
fn wait_command(command: &mut Command) -> Result<(), String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "NOT_SUBMITTED")?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("PRINTER".into())
                }
            }
            Err(_) => return Err("PRINTER".into()),
            _ => {}
        }
        if start.elapsed() > Duration::from_secs(120) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PRINTER".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn spool(path: &Path, config: &Value) -> Result<(), String> {
    let name = config["hardware"]["printer"].as_str().unwrap_or("");
    if name.is_empty() {
        return Err("NOT_SUBMITTED".into());
    }
    #[cfg(windows)]
    {
        let helper = config["hardware"]["pdfHelper"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("ProgramFiles")
                    .ok()
                    .map(|p| PathBuf::from(p).join("SumatraPDF/SumatraPDF.exe"))
            })
            .ok_or("NOT_SUBMITTED")?;
        if helper
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| !s.eq_ignore_ascii_case("SumatraPDF.exe"))
            .unwrap_or(true)
            || !helper.is_file()
        {
            return Err("NOT_SUBMITTED".into());
        }
        let mut cmd = Command::new(helper);
        cmd.arg("-silent");
        if name.is_empty() {
            cmd.arg("-print-to-default");
        } else {
            cmd.arg("-print-to").arg(name);
        }
        cmd.arg("-exit-on-print").arg(path);
        wait_command(&mut cmd)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("lp");
        if !name.is_empty() {
            cmd.arg("-d").arg(name);
        }
        cmd.arg("--").arg(path);
        wait_command(&mut cmd)
    }
}
#[tauri::command]
async fn print_document(
    runtime: State<'_, Runtime>,
    session_id: String,
    result_id: String,
    job_id: String,
) -> Result<(), String> {
    let rt = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if ![&session_id, &result_id, &job_id].iter().all(|s| {
            !s.is_empty()
                && s.len() <= 300
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        }) {
            return Err("FORBIDDEN".into());
        }
        let path = format!("/api/v1/sessions/{}/results/{}/pdf", session_id, result_id);
        let (config, bytes) = {
            let mut state = rt.state.lock().map_err(|_| "CONFIG")?;
            if state.printing || state.claimed.contains_key(&job_id) {
                return Err("PRINTER".into());
            }
            if state.config["printing"] != true {
                return Err("FORBIDDEN".into());
            }
            let data = state
                .pdfs
                .get(&path)
                .cloned()
                .ok_or("INVALID_MIS_RESPONSE")?;
            state.printing = true;
            (state.config.clone(), data)
        };
        let result = (|| {
            // Re-authorize against the current session immediately before a physical action.
            let (status, _, _) = send(
                &rt,
                &format!("/api/v1/sessions/{}/results", session_id),
                "GET",
                &Value::Null,
            )?;
            if status != 200 {
                return Err("SESSION_EXPIRED".into());
            }
            let file = rt.dir.join("spool").join(format!("{}.pdf", Uuid::new_v4()));
            private_write(&file, &bytes)?;
            // Persist before spawning. A crash or ambiguous exit must never become an automatic retry.
            {
                let mut state = rt.state.lock().map_err(|_| "CONFIG")?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                state
                    .claimed
                    .retain(|_, at| now.saturating_sub(*at) < 86400);
                state.claimed.insert(job_id, now);
                private_write(
                    &rt.dir.join("print-journal.json"),
                    &serde_json::to_vec(&state.claimed).map_err(|_| "CONFIG")?,
                )?;
            }
            let outcome = spool(&file, &config);
            let _ = fs::remove_file(&file);
            outcome
        })();
        rt.state.lock().map_err(|_| "CONFIG")?.printing = false;
        result
    })
    .await
    .map_err(|_| "PRINTER".to_string())?
}
fn emit_frame(app: &tauri::AppHandle, bytes: &[u8], pattern: &str) {
    use oms_parser::{classify_scanner_frame, ScannerScanResult};
    let payload = match classify_scanner_frame(bytes) {
        ScannerScanResult::Oms(r) => {
            json!({"kind":"oms","omsNumber":r.oms_number,"dateOfBirth":r.date_of_birth,"fullName":([r.last_name,r.first_name,r.middle_name].into_iter().flatten().collect::<Vec<_>>().join(" "))})
        }
        _ => {
            let value = String::from_utf8_lossy(bytes).trim().to_string();
            if value.len() > 256
                || !regex::Regex::new(pattern)
                    .map(|re| re.is_match(&value))
                    .unwrap_or(false)
            {
                return;
            }
            json!({"kind":"token","value":value})
        }
    };
    let _ = app.emit("scanner-scan", payload);
}
fn scanner(app: tauri::AppHandle, rt: Runtime) {
    std::thread::spawn(move || loop {
        let config = rt
            .state
            .lock()
            .map(|s| s.config.clone())
            .unwrap_or(Value::Null);
        if config["hardware"]["scannerMode"] != "serial" {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let port = config["hardware"]["serialPort"].as_str().unwrap_or("");
        let baud = config["hardware"]["baudRate"].as_u64().unwrap_or(9600) as u32;
        let pattern = config["hardware"]["scanPattern"]
            .as_str()
            .unwrap_or("^[A-Za-z0-9_-]{4,128}$");
        if let Ok(mut s) = rt.state.lock() {
            s.serial_connected = false;
        }
        if let Ok(mut connection) = serialport::new(port, baud)
            .timeout(Duration::from_millis(250))
            .open()
        {
            if let Ok(mut s) = rt.state.lock() {
                s.serial_connected = true;
            }
            let mut frame = Vec::new();
            let mut buffer = [0u8; 256];
            let mut last: Option<Instant> = None;
            loop {
                let current = rt
                    .state
                    .lock()
                    .map(|s| s.config.clone())
                    .unwrap_or(Value::Null);
                if current != config {
                    break;
                }
                match connection.read(&mut buffer) {
                    Ok(n) => {
                        for b in &buffer[..n] {
                            if *b == b'\n' || *b == b'\r' {
                                if !frame.is_empty() {
                                    emit_frame(&app, &frame, pattern);
                                    frame.clear();
                                }
                            } else if frame.len() < 2048 {
                                frame.push(*b);
                            } else {
                                frame.clear();
                            }
                        }
                        last = Some(Instant::now());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        if last
                            .map(|v| v.elapsed() > Duration::from_millis(250))
                            .unwrap_or(false)
                            && !frame.is_empty()
                        {
                            emit_frame(&app, &frame, pattern);
                            frame.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    });
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            fs::create_dir_all(dir.join("spool"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
            // Only app-owned, direct spool children are removed; external paths are never accepted.
            for entry in fs::read_dir(dir.join("spool"))?.flatten() {
                if entry.file_type()?.is_file() {
                    let _ = fs::remove_file(entry.path());
                }
            }
            let enrollment = fs::read(dir.join("enrollment.json"))
                .ok()
                .and_then(|v| serde_json::from_slice(&v).ok());
            let claimed = fs::read(dir.join("print-journal.json"))
                .ok()
                .and_then(|v| serde_json::from_slice(&v).ok())
                .unwrap_or_default();
            let runtime = Runtime {
                state: Arc::new(Mutex::new(Native {
                    enrollment,
                    claimed,
                    ..Default::default()
                })),
                dir,
            };
            scanner(app.handle().clone(), runtime.clone());
            monitoring::start(runtime.clone());
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_enrolled,
            enroll,
            api_request,
            get_pdf,
            apply_config,
            get_health,
            print_document
        ])
        .run(tauri::generate_context!())
        .expect("ResultsTerminal runtime failed");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrict_ipc_paths() {
        assert!(allowed("/api/v1/config", "GET"));
        assert!(!allowed("/api/admin/config", "GET"));
        assert!(!allowed("/api/v1/sessions/../admin", "GET"));
        assert!(!allowed("https://evil.invalid", "GET"));
    }
    #[test]
    fn transport_requires_trust() {
        assert!(safe_base("https://example.invalid").is_ok());
        assert!(safe_base("http://example.invalid").is_err());
        assert!(safe_base("https://user:pass@example.invalid").is_err());
    }
}
