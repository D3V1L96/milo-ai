#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

struct BackendProcess(Mutex<Child>);

#[tauri::command]
fn save_window_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let directory = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join("widget-position.txt"), format!("{x},{y}"))
        .map_err(|error| error.to_string())
}

/// Build a `Command` that never flashes a console window on Windows.
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) | CREATE_NEW_PROCESS_GROUP (0x00000200)
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    command
}

fn backend_is_listening() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 8765));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn ollama_is_listening() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 11434));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn start_ollama() {
    if ollama_is_listening() {
        return;
    }

    let mut candidates = vec![std::path::PathBuf::from("ollama.exe")];
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(std::path::PathBuf::from(local_app_data).join("Programs/Ollama/ollama.exe"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(std::path::PathBuf::from(program_files).join("Ollama/ollama.exe"));
    }

    for executable in candidates {
        if hidden_command(&executable)
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return;
        }
    }
}

fn wait_for_backend(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if backend_is_listening() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn start_backend(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
    // If a previous MILO backend is still holding the port (e.g. a hot reload),
    // reuse it instead of spawning a second process that cannot bind.
    if backend_is_listening() {
        eprintln!("MILO backend already listening on 127.0.0.1:8765 - reusing it");
        return Err("backend already running".into());
    }

    let (program, args, working_directory) = if cfg!(debug_assertions) {
        let manifest_directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest_directory
            .parent()
            .ok_or("MILO source checkout has no parent directory")?;
        let backend = root.join("backend");
        let python = backend.join(".venv").join("Scripts").join("python.exe");
        if !python.is_file() {
            return Err(format!(
                "MILO development backend Python was not found at {}",
                python.display()
            )
            .into());
        }
        (python, vec!["run.py".to_string()], backend)
    } else {
        let bundled = app.path().resolve(
            "backend/milo_backend/milo_backend.exe",
            tauri::path::BaseDirectory::Resource,
        )?;
        if !bundled.is_file() {
            return Err(format!(
                "Packaged MILO backend was not found at {}",
                bundled.display()
            )
            .into());
        }
        let directory = bundled
            .parent()
            .ok_or("Packaged MILO backend has no parent directory")?
            .to_path_buf();
        (bundled, Vec::new(), directory)
    };

    let data_directory = app.path().app_local_data_dir()?;
    let log_directory = data_directory.join("logs");
    fs::create_dir_all(&log_directory)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_directory.join("backend.log"))?;
    let stderr = log.try_clone()?;

    let child = hidden_command(&program)
        .args(args)
        .current_dir(working_directory)
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()?;

    Ok(child)
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            if let Ok(directory) = app.path().app_local_data_dir() {
                if let Ok(position) = fs::read_to_string(directory.join("widget-position.txt")) {
                    let mut values = position.trim().split(',').filter_map(|part| part.parse::<i32>().ok());
                    if let (Some(x), Some(y)) = (values.next(), values.next()) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                        }
                    }
                }
            }
            start_ollama();
            match start_backend(app) {
                Ok(backend) => {
                    app.manage(BackendProcess(Mutex::new(backend)));
                }
                Err(error) => {
                    // A backend that is already running is fine; anything else
                    // is worth knowing about but must not block the window.
                    eprintln!("MILO backend start skipped: {error}");
                }
            }

            // Surface the window only once the API answers, so the first paint
            // is not a glass shell with failing requests.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    wait_for_backend(Duration::from_secs(45));
                    let _ = window.show();
                    let _ = window.set_focus();
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_window_position])
        .build(tauri::generate_context!())
        .expect("failed to build MILO");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(backend) = handle.try_state::<BackendProcess>() {
                if let Ok(mut child) = backend.0.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
