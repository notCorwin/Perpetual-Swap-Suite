#[cfg(not(target_os = "macos"))]
compile_error!("The comparison shell is supported on macOS only.");

use std::{env, error::Error, io, process};

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::NSProcessInfo;
use tauri::{
    utils::config::{BackgroundThrottlingPolicy, WebviewUrl},
    webview::NewWindowResponse,
    Manager, WebviewWindowBuilder, WindowEvent,
};

struct Settings {
    url: tauri::Url,
    width: u32,
    height: u32,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn dimension(name: &str, default: u32) -> Result<u32, io::Error> {
    match env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                invalid(format!(
                    "{name} must be a positive integer in logical pixels"
                ))
            }),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(invalid(format!("{name} must be valid UTF-8"))),
    }
}

fn settings() -> Result<Settings, io::Error> {
    let value = env::var("RADAR_COMPARE_URL")
        .map_err(|_| invalid("RADAR_COMPARE_URL is required and must be http://127.0.0.1:PORT/"))?;
    let invalid_url = || {
        invalid("RADAR_COMPARE_URL must use http://127.0.0.1:PORT/ with an optional session path ending in /")
    };
    let (port, path) = value
        .strip_prefix("http://127.0.0.1:")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(invalid_url)?;
    if port.is_empty()
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|port| *port != 0).is_none()
    {
        return Err(invalid_url());
    }
    if !path.is_empty()
        && !path.strip_suffix('/').is_some_and(|path| {
            path.split('/').all(|segment| {
                !segment.is_empty()
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        })
    {
        return Err(invalid_url());
    }
    let url = tauri::Url::parse(&value).map_err(|_| invalid_url())?;

    Ok(Settings {
        url,
        width: dimension("RADAR_COMPARE_WIDTH", 1440)?,
        height: dimension("RADAR_COMPARE_HEIGHT", 900)?,
    })
}

fn create_window(app: &mut tauri::App, settings: Settings) -> Result<(), Box<dyn Error>> {
    let mtm =
        MainThreadMarker::new().ok_or_else(|| invalid("AppKit must run on the main thread"))?;
    let application = NSApplication::sharedApplication(mtm);
    if application.isActive()
        || application.activationPolicy() != NSApplicationActivationPolicy::Prohibited
        || !application.setActivationPolicy(NSApplicationActivationPolicy::Accessory)
        || application.activationPolicy() != NSApplicationActivationPolicy::Accessory
        || application.isActive()
    {
        return Err(invalid("could not establish the inactive accessory policy").into());
    }

    let window = WebviewWindowBuilder::new(app, "comparison", WebviewUrl::External(settings.url))
        .title("Radar Tauri Comparison")
        .inner_size(f64::from(settings.width), f64::from(settings.height))
        .decorations(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .incognito(true)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;

    // Tauri's show() can make a window key on macOS. Check AppKit's
    // actual window capabilities first, then order it front without activation.
    let native = window.ns_window()?;
    if native.is_null() {
        return Err(invalid("could not obtain the native comparison window").into());
    }
    // This callback runs on AppKit's main thread, and Tauri retains the window.
    let native = unsafe { &*native.cast::<NSWindow>() };
    let application = NSApplication::sharedApplication(native.mtm());
    native.setIgnoresMouseEvents(true);
    native.setLevel(-1);
    native.setCollectionBehavior(native.collectionBehavior() | NSWindowCollectionBehavior::CanJoinAllApplications | NSWindowCollectionBehavior::Stationary);
    if application.activationPolicy() != NSApplicationActivationPolicy::Accessory
        || application.isActive()
        || native.canBecomeKeyWindow()
        || native.canBecomeMainWindow()
        || native.isKeyWindow()
        || native.isVisible()
        || !native.ignoresMouseEvents()
    {
        return Err(
            invalid("focus safety check failed before showing the comparison window").into(),
        );
    }
    native.orderBack(None);
    if !native.isVisible() || native.isKeyWindow() || application.isActive() {
        return Err(
            invalid("focus safety check failed after showing the comparison window").into(),
        );
    }

    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    println!(
        "{}",
        serde_json::json!({
            "ready": true,
            "pid": process::id(),
            "focused": false,
            "focusable": false,
            "visible": true,
            "ignoresMouseEvents": true,
            "requestedLogicalSize": [settings.width, settings.height],
            "innerPhysicalSize": [size.width, size.height],
            "scaleFactor": scale,
            "activationPolicy": "accessory",
            "launchPolicy": "prohibited",
            "webkitDataStore": "nonpersistent",
            "inactiveSchedulingPolicy": "none",
            "webkitProcessPids": "unsupported",
            "windowLevel": -1,
            "placement": "behind-user-windows"
        })
    );
    Ok(())
}

fn run(settings: Settings) -> Result<(), Box<dyn Error>> {
    if NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        < 14
    {
        return Err(invalid(
            "macOS 14 or later is required for WebKit's inactive scheduling policy",
        )
        .into());
    }

    // Tao requests application activation during its launch callback even when
    // configured not to ignore other apps. Prohibit activation until that
    // callback has completed, before creating any windows.
    let mtm =
        MainThreadMarker::new().ok_or_else(|| invalid("AppKit must run on the main thread"))?;
    let application = NSApplication::sharedApplication(mtm);
    // AppKit may return false for an already prohibited policy. The launch
    // bundle establishes it before AppKit; verify the resulting state.
    let _ = application.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    if application.activationPolicy() != NSApplicationActivationPolicy::Prohibited
        || application.isActive() {
        return Err(invalid("could not establish the inactive launch policy").into());
    }

    let mut app = tauri::Builder::default()
        .activate_ignoring_other_apps(false)
        .enable_macos_default_menu(false)
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Focused(true)) {
                eprintln!("RADAR_COMPARE event=focus_safety_failure message=unexpected_focus");
                window.app_handle().exit(1);
            }
        })
        .setup(move |app| {
            if let Err(error) = create_window(app, settings) {
                eprintln!("RADAR_COMPARE event=error message={error}");
                process::exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    app.run(|_, _| {});
    Ok(())
}

fn main() {
    let result = settings().map_err(Box::<dyn Error>::from).and_then(run);
    if let Err(error) = result {
        eprintln!("RADAR_COMPARE event=error message={error}");
        process::exit(1);
    }
}
