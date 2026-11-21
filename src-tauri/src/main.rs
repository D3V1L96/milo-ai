#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, RunEvent};

struct BackendProcess(Mutex<Child>);

fn start_backend(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
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
        let bundled = app
            .path()
            .resolve("backend/milo_backend/milo_backend.exe", tauri::path::BaseDirectory::Resource)?;
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

    Ok(Command::new(program)
        .args(args)
        .current_dir(working_directory)
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()?)
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let backend = start_backend(app)?;
            app.manage(BackendProcess(Mutex::new(backend)));
            Ok(())
        })
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
