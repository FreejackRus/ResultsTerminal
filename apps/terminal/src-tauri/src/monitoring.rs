use super::*;
use sysinfo::{Disks, System};
fn output(program: &str, args: &[&str], env: Option<(&str, &str)>) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some((k, v)) = env {
        command.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().ok()? {
            if !status.success() {
                return None;
            }
            let mut s = String::new();
            child
                .stdout
                .take()?
                .take(65536)
                .read_to_string(&mut s)
                .ok()?;
            return Some(s);
        }
        if started.elapsed() > Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn printer(config: &Value) -> Value {
    let name = config["hardware"]["printer"].as_str().unwrap_or("");
    if name.is_empty() {
        return json!({"state":"unknown","code":"NOT_CONFIGURED"});
    }
    #[cfg(windows)]
    {
        let script="$p=Get-CimInstance Win32_Printer | Where-Object {$_.Name -eq $env:RT_PRINTER}; if($null -eq $p){exit 2}; $p | Select-Object WorkOffline,PrinterStatus,DetectedErrorState,ExtendedPrinterStatus | ConvertTo-Json -Compress";
        let Some(raw) = output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", script],
            Some(("RT_PRINTER", name)),
        ) else {
            return json!({"state":"unknown","code":"CHECK_FAILED"});
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            return json!({"state":"unknown","code":"CHECK_FAILED"});
        };
        if v["WorkOffline"] == true || v["PrinterStatus"] == 7 {
            return json!({"state":"disconnected","code":"OFFLINE"});
        }
        if matches!(v["DetectedErrorState"].as_u64(), Some(3 | 4 | 5 | 6 | 8)) {
            return json!({"state":"error","code":"PAPER_OR_TONER"});
        }
        if matches!(v["DetectedErrorState"].as_u64(), Some(7 | 9 | 10 | 11)) {
            return json!({"state":"error","code":"QUEUE_ERROR"});
        }
        if matches!(v["PrinterStatus"].as_u64(), Some(4 | 5)) {
            return json!({"state":"busy","code":"OK"});
        }
        if v["PrinterStatus"] == 3
            && v["DetectedErrorState"]
                .as_u64()
                .map(|e| e == 2)
                .unwrap_or(true)
        {
            return json!({"state":"ready","code":"OK"});
        }
        json!({"state":"unknown","code":"CHECK_FAILED"})
    }
    #[cfg(not(windows))]
    {
        let Some(raw) = output("lpstat", &["-p", name], Some(("LC_ALL", "C"))) else {
            return json!({"state":"unknown","code":"CHECK_FAILED"});
        };
        if raw.contains("disabled") {
            return json!({"state":"error","code":"QUEUE_ERROR"});
        }
        if raw.contains("is idle") {
            return json!({"state":"ready","code":"OK"});
        }
        if raw.contains("now printing") {
            return json!({"state":"busy","code":"OK"});
        }
        json!({"state":"unknown","code":"CHECK_FAILED"})
    }
}
fn hid(config: &Value) -> Value {
    let id = config["hardware"]["hidDeviceId"].as_str().unwrap_or("");
    if id.is_empty() {
        return json!({"state":"unknown","code":"HID_UNVERIFIED"});
    }
    #[cfg(windows)]
    {
        let script="$p=Get-CimInstance Win32_PnPEntity | Where-Object {$_.PNPDeviceID -eq $env:RT_HID}; if($null -eq $p){exit 2}; if($p.Status -eq 'OK'){'ready'}else{'error'}";
        match output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", script],
            Some(("RT_HID", id)),
        ) {
            Some(s) if s.trim() == "ready" => json!({"state":"ready","code":"OK"}),
            _ => json!({"state":"disconnected","code":"HID_NOT_FOUND"}),
        }
    }
    #[cfg(not(windows))]
    {
        if id.starts_with("/dev/input/") && Path::new(id).exists() {
            json!({"state":"ready","code":"OK"})
        } else {
            json!({"state":"disconnected","code":"HID_NOT_FOUND"})
        }
    }
}
pub(super) fn start(rt: Runtime) {
    std::thread::spawn(move || {
        let mut sys = System::new_all();
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let config = rt
                .state
                .lock()
                .map(|s| s.config.clone())
                .unwrap_or(Value::Null);
            let scanner = if config["hardware"]["scannerMode"] == "serial" {
                let connected = rt.state.lock().map(|s| s.serial_connected).unwrap_or(false);
                if config["hardware"]["serialPort"]
                    .as_str()
                    .unwrap_or("")
                    .is_empty()
                {
                    json!({"state":"unknown","code":"NOT_CONFIGURED"})
                } else if connected {
                    json!({"state":"ready","code":"OK"})
                } else {
                    json!({"state":"disconnected","code":"PORT_UNAVAILABLE"})
                }
            } else {
                hid(&config)
            };
            let disks = Disks::new_with_refreshed_list();
            let free = disks
                .iter()
                .filter(|d| rt.dir.starts_with(d.mount_point()))
                .max_by_key(|d| d.mount_point().as_os_str().len())
                .map(|d| d.available_space())
                .unwrap_or(0);
            let snapshot = json!({"checkedAt":chrono::Utc::now().to_rfc3339(),"os":std::env::consts::OS,"uptimeSeconds":System::uptime(),"cpuPercent":sys.global_cpu_usage().clamp(0.0,100.0),"memoryTotalMb":sys.total_memory() as f64/1048576.0,"memoryUsedMb":sys.used_memory() as f64/1048576.0,"diskFreeGb":free as f64/1073741824.0,"scanner":scanner,"printer":printer(&config)});
            if let Ok(mut state) = rt.state.lock() {
                state.health = snapshot;
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}
