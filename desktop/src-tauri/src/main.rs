#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::{
    env, fs, io,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, POINT},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
    },
};

const SERVER_ADDR: &str = "127.0.0.1:18766";
const CLONOTH_ADDR: &str = "127.0.0.1:18767";
const CLONOTH_TOKEN: &str = "ryza-local-clonoth";

#[derive(Default)]
struct Sidecars {
    moka: Option<Child>,
    clonoth: Option<Child>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForegroundContext {
    process: String,
    title: String,
}

struct ForegroundState(Arc<Mutex<ForegroundContext>>);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InteractionRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct InteractionState(Arc<Mutex<Vec<InteractionRegion>>>);
struct LayoutState(Arc<AtomicBool>);

fn address_ready(value: &str) -> bool {
    let address: SocketAddr = value.parse().expect("valid server address");
    TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok()
}

fn resource_root(_app: &tauri::App) -> io::Result<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
    }
    #[cfg(not(debug_assertions))]
    {
        _app.path().resource_dir().map_err(io::Error::other)
    }
}

fn clonoth_root() -> PathBuf {
    PathBuf::from(env::var_os("APPDATA").unwrap_or_else(|| ".".into()))
        .join("RyzaPet")
        .join("clonoth")
}

fn configure_hidden(command: &mut Command, root: &Path) {
    command
        .current_dir(root)
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
}

fn terminate_tree(child: &mut Child) {
    let pid = child.id().to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags(0x08000000)
        .output();
    let _ = child.wait();
}

fn wait_for_child(
    mut child: Child,
    address: &str,
    label: &str,
    attempts: usize,
) -> io::Result<Child> {
    for _ in 0..attempts {
        if address_ready(address) {
            return Ok(child);
        }
        if child.try_wait()?.is_some() {
            return Err(io::Error::other(format!("{label} exited during startup")));
        }
        thread::sleep(Duration::from_millis(100));
    }
    terminate_tree(&mut child);
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("{label} startup timed out"),
    ))
}

fn spawn_clonoth(app: &tauri::App) -> io::Result<Option<Child>> {
    if address_ready(CLONOTH_ADDR) {
        return Ok(None);
    }
    let root = resource_root(app)?;
    #[cfg(debug_assertions)]
    let mut command = {
        let mut value = Command::new(root.join(".venv/Scripts/python.exe"));
        value.arg(root.join("desktop/clonoth_entry.py"));
        value
    };
    #[cfg(not(debug_assertions))]
    let mut command = Command::new(root.join("ryza-clonoth/ryza-clonoth.exe"));

    command
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            "18767",
            "--log-level",
            "warning",
        ])
        .env("CLONOTH_ADMIN_TOKEN", CLONOTH_TOKEN)
        .env("RYZA_CLONOTH_ROOT", clonoth_root());
    configure_hidden(&mut command, &root);
    wait_for_child(command.spawn()?, CLONOTH_ADDR, "Clonoth runtime", 300).map(Some)
}

fn spawn_server(app: &tauri::App) -> io::Result<Option<Child>> {
    if address_ready(SERVER_ADDR) {
        return Ok(None);
    }
    let root = resource_root(app)?;
    #[cfg(debug_assertions)]
    let mut command = {
        let mut value = Command::new(root.join(".venv/Scripts/python.exe"));
        value.args(["-m", "ryza_moka"]);
        value
    };
    #[cfg(not(debug_assertions))]
    let mut command = Command::new(root.join("ryza-moka.exe"));

    command
        .args(["--spine", root.join("spine").to_string_lossy().as_ref()])
        .args(["--media", root.join("assets").to_string_lossy().as_ref()])
        .env("RYZA_CLONOTH_ROOT", clonoth_root());
    configure_hidden(&mut command, &root);
    wait_for_child(command.spawn()?, SERVER_ADDR, "Ryza Python sidecar", 150).map(Some)
}

fn process_name(pid: u32) -> String {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return String::new();
        }
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 {
            return String::new();
        }
        PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]))
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

fn foreground_context() -> Option<ForegroundContext> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() || IsWindowVisible(hwnd) == 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == std::process::id() {
            return None;
        }
        let length = GetWindowTextLengthW(hwnd);
        let mut title_buffer = vec![0u16; (length.max(0) + 1) as usize];
        let copied = GetWindowTextW(hwnd, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
        let title = String::from_utf16_lossy(&title_buffer[..copied.max(0) as usize])
            .trim()
            .to_string();
        let process = process_name(pid);
        let lower = process.to_lowercase();
        if lower.starts_with("ryza-")
            || title.starts_with("Ryza ")
            || (title.is_empty() && process.is_empty())
        {
            return None;
        }
        Some(ForegroundContext { process, title })
    }
}

fn start_foreground_tracker(state: Arc<Mutex<ForegroundContext>>) {
    thread::spawn(move || loop {
        if let Some(context) = foreground_context() {
            *state.lock().expect("foreground context mutex") = context;
        }
        thread::sleep(Duration::from_millis(500));
    });
}

fn start_passthrough_tracker(
    window: WebviewWindow,
    regions: Arc<Mutex<Vec<InteractionRegion>>>,
    adjusting: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2));
        let mut ignored = false;
        loop {
            if adjusting.load(Ordering::Relaxed) {
                if ignored {
                    let _ = window.set_ignore_cursor_events(false);
                    ignored = false;
                }
                thread::sleep(Duration::from_millis(40));
                continue;
            }
            let mut point = POINT { x: 0, y: 0 };
            let cursor_ok = unsafe { GetCursorPos(&mut point) } != 0;
            if cursor_ok {
                if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor())
                {
                    let x = (point.x - position.x) as f64 / scale;
                    let y = (point.y - position.y) as f64 / scale;
                    let interactive = regions
                        .lock()
                        .expect("interaction regions mutex")
                        .iter()
                        .any(|region| {
                            x >= region.x
                                && y >= region.y
                                && x <= region.x + region.width
                                && y <= region.y + region.height
                        });
                    let next_ignored = !interactive;
                    if next_ignored != ignored {
                        let _ = window.set_ignore_cursor_events(next_ignored);
                        ignored = next_ignored;
                    }
                }
            }
            thread::sleep(Duration::from_millis(40));
        }
    });
}

#[tauri::command]
fn get_foreground_context(state: State<'_, ForegroundState>) -> ForegroundContext {
    state.0.lock().expect("foreground context mutex").clone()
}

#[tauri::command]
fn set_interaction_regions(
    regions: Vec<InteractionRegion>,
    state: State<'_, InteractionState>,
) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| "interaction regions unavailable")? = regions
        .into_iter()
        .filter(|region| region.width > 0.0 && region.height > 0.0)
        .collect();
    Ok(())
}

fn apply_layout_mode(window: &WebviewWindow, state: &AtomicBool, adjusting: bool) {
    state.store(adjusting, Ordering::Relaxed);
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.eval(&format!(
        "window.dispatchEvent(new CustomEvent('ryza-layout-mode', {{ detail: {adjusting} }}))"
    ));
}

fn decode_clipboard_png(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("剪贴板图片不是 PNG")?;
    if encoded.len() > 28_000_000 {
        return Err("剪贴板图片过大".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("剪贴板图片内容无效".into());
    }
    Ok(bytes)
}

#[tauri::command]
fn save_clipboard_image(data_url: String) -> Result<String, String> {
    let bytes = decode_clipboard_png(&data_url)?;
    let dir = clonoth_root().join("data").join("attachments").join("ryza");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let path = dir.join(format!("paste-{stamp}.png"));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_clipboard_png() {
        assert_eq!(
            decode_clipboard_png("data:image/png;base64,iVBORw0KGgo=")
                .unwrap()
                .len(),
            8
        );
        assert!(decode_clipboard_png("data:image/jpeg;base64,AAAA").is_err());
    }
}

fn main() {
    let sidecars = Arc::new(Mutex::new(Sidecars::default()));
    let setup_sidecars = Arc::clone(&sidecars);
    let exit_sidecars = Arc::clone(&sidecars);
    let foreground = Arc::new(Mutex::new(ForegroundContext::default()));
    let interactions = Arc::new(Mutex::new(Vec::<InteractionRegion>::new()));
    let adjusting = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .manage(ForegroundState(Arc::clone(&foreground)))
        .manage(InteractionState(Arc::clone(&interactions)))
        .manage(LayoutState(Arc::clone(&adjusting)))
        .invoke_handler(tauri::generate_handler![
            get_foreground_context,
            save_clipboard_image,
            set_interaction_regions,
        ])
        .setup(move |app| {
            let mut children = setup_sidecars.lock().expect("sidecar process mutex");
            children.clonoth = spawn_clonoth(app)?;
            match spawn_server(app) {
                Ok(child) => children.moka = child,
                Err(error) => {
                    if let Some(child) = children.clonoth.as_mut() {
                        terminate_tree(child);
                    }
                    return Err(error.into());
                }
            }
            drop(children);

            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Ryza Desktop Pet")
                .inner_size(520.0, 760.0)
                .min_inner_size(320.0, 480.0)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .transparent(true)
                .build()?;

            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                .title("Ryza 设置")
                .inner_size(1080.0, 820.0)
                .min_inner_size(760.0, 600.0)
                .visible(false)
                .build()?;

            start_foreground_tracker(Arc::clone(&foreground));
            start_passthrough_tracker(main, Arc::clone(&interactions), Arc::clone(&adjusting));

            let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏", true, None::<&str>)?;
            let adjust = MenuItem::with_id(
                app,
                "adjust_layout",
                "调整 / 锁定大小和位置",
                true,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &adjust, &settings, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("application icon").clone())
                .tooltip("Ryza Desktop Pet")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "adjust_layout" => {
                        show_main(app);
                        if let Some(window) = app.get_webview_window("main") {
                            let state = app.state::<LayoutState>();
                            let adjusting = !state.0.load(Ordering::Relaxed);
                            apply_layout_mode(&window, &state.0, adjusting);
                        }
                    }
                    "settings" => show_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Ryza desktop app")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let mut children = exit_sidecars.lock().expect("sidecar process mutex");
                if let Some(child) = children.moka.as_mut() {
                    terminate_tree(child);
                }
                if let Some(child) = children.clonoth.as_mut() {
                    terminate_tree(child);
                }
            }
        });
}
