#[cfg(not(target_os = "macos"))]
compile_error!("The comparison shell is supported on macOS only.");

use std::{
    collections::{HashMap, VecDeque},
    env,
    error::Error,
    io::{self, BufRead, BufReader, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::Path,
    process,
    sync::{Arc, Mutex},
    thread,
};

use objc2::{msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSWindow, NSWindowCollectionBehavior,
};
use objc2_foundation::NSProcessInfo;
use tauri::{
    ipc::Channel,
    utils::{
        acl::ExecutionContext,
        config::{BackgroundThrottlingPolicy, WebviewUrl},
    },
    webview::NewWindowResponse,
    Manager, WebviewWindowBuilder, WindowEvent,
};

const MAX_FRAME: usize = 128 * 1024 * 1024;
const MAX_PENDING: usize = 4096;
const MAX_EVENTS: usize = 4096;
const MAX_ID: u64 = 9_007_199_254_740_991;

type Reply = Result<String, String>;

#[derive(Default)]
struct Requests {
    next_id: u64,
    pending: HashMap<u64, tauri::async_runtime::Sender<Reply>>,
    failure: Option<String>,
}

#[derive(Default)]
struct Events {
    subscriber: Option<Channel<String>>,
    queued: VecDeque<String>,
    bytes: usize,
    failure: Option<String>,
}

struct NativeTransport {
    writer: Mutex<UnixStream>,
    shutdown: UnixStream,
    requests: Mutex<Requests>,
    events: Mutex<Events>,
}

impl NativeTransport {
    fn connect(socket: &str, token: &str) -> Result<Arc<Self>, io::Error> {
        if !Path::new(socket).is_absolute() {
            return Err(invalid(
                "RADAR_COMPARE_SOCKET must be an absolute Unix socket path",
            ));
        }
        if token.is_empty() {
            return Err(invalid(
                "RADAR_COMPARE_NATIVE_TOKEN is required for native transport",
            ));
        }
        let mut writer = UnixStream::connect(socket).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("native comparison socket connection failed: {error}"),
            )
        })?;
        let hello =
            Self::frame(serde_json::json!({"kind": "hello", "token": token})).map_err(invalid)?;
        writer.write_all(&hello)?;
        let reader = writer.try_clone()?;
        let shutdown = writer.try_clone()?;
        let transport = Arc::new(Self {
            writer: Mutex::new(writer),
            shutdown,
            requests: Mutex::new(Requests {
                next_id: 1,
                ..Requests::default()
            }),
            events: Mutex::new(Events::default()),
        });
        let receiver = Arc::clone(&transport);
        thread::Builder::new()
            .name("comparison-native-reader".into())
            .spawn(move || receiver.read(reader))?;
        Ok(transport)
    }

    fn frame(value: serde_json::Value) -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(&value)
            .map_err(|error| format!("cannot encode native comparison frame: {error}"))?;
        if bytes.len() > MAX_FRAME {
            return Err("Native comparison frame exceeds 128 MiB.".into());
        }
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn begin_request(
        &self,
        path: String,
        payload: String,
    ) -> Result<tauri::async_runtime::Receiver<Reply>, String> {
        let (sender, receiver) = tauri::async_runtime::channel(1);
        let id = {
            let mut requests = self.requests.lock().unwrap();
            if let Some(error) = &requests.failure {
                return Err(error.clone());
            }
            if requests.pending.len() >= MAX_PENDING {
                return Err("Too many pending native comparison requests.".into());
            }
            if requests.next_id > MAX_ID {
                return Err("Native comparison request IDs exhausted.".into());
            }
            let id = requests.next_id;
            requests.next_id += 1;
            requests.pending.insert(id, sender);
            id
        };
        let frame = match Self::frame(
            serde_json::json!({"kind": "request", "id": id, "path": path, "payload": payload}),
        ) {
            Ok(frame) => frame,
            Err(error) => {
                self.requests.lock().unwrap().pending.remove(&id);
                return Err(error);
            }
        };
        // Never hold the reader's request/event locks while a socket write can block.
        let result = self.writer.lock().unwrap().write_all(&frame);
        if let Err(error) = result {
            self.fail(format!("Native comparison socket write failed: {error}"));
            return Err(self.requests.lock().unwrap().failure.clone().unwrap());
        }
        // A concurrent close may have drained the request; its receiver then reports the failure.
        Ok(receiver)
    }

    fn subscribe(&self, channel: Channel<String>) -> Result<(), String> {
        let mut events = self.events.lock().unwrap();
        if let Some(error) = &events.failure {
            return Err(error.clone());
        }
        if events.subscriber.is_some() {
            return Err("Native comparison events are already subscribed.".into());
        }
        while let Some(payload) = events.queued.pop_front() {
            channel
                .send(payload)
                .map_err(|error| format!("Native comparison event delivery failed: {error}"))?;
        }
        events.bytes = 0;
        events.subscriber = Some(channel);
        Ok(())
    }

    fn receive_event(&self, payload: String) -> Result<(), String> {
        let mut events = self.events.lock().unwrap();
        if let Some(error) = &events.failure {
            return Err(error.clone());
        }
        if let Some(channel) = &events.subscriber {
            channel
                .send(payload)
                .map_err(|error| format!("Native comparison event delivery failed: {error}"))?;
        } else {
            if events.queued.len() >= MAX_EVENTS
                || events.bytes.saturating_add(payload.len()) > MAX_FRAME
            {
                return Err("Native comparison event buffer is full before subscription.".into());
            }
            events.bytes += payload.len();
            events.queued.push_back(payload);
        }
        Ok(())
    }

    fn read(&self, stream: UnixStream) {
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = Vec::new();
            let count = match Read::by_ref(&mut reader)
                .take((MAX_FRAME + 2) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(count) => count,
                Err(error) => {
                    self.fail(format!("Native comparison socket read failed: {error}"));
                    return;
                }
            };
            if count == 0 {
                self.fail("Native comparison socket closed.".into());
                return;
            }
            if line.last() != Some(&b'\n') {
                self.fail(
                    if line.len() > MAX_FRAME {
                        "Native comparison frame exceeds 128 MiB."
                    } else {
                        "Native comparison socket closed with an incomplete frame."
                    }
                    .into(),
                );
                return;
            }
            line.pop();
            if line.len() > MAX_FRAME {
                self.fail("Native comparison frame exceeds 128 MiB.".into());
                return;
            }
            let result = serde_json::from_slice::<serde_json::Value>(&line)
                .map_err(|error| format!("Invalid native comparison envelope: {error}"))
                .and_then(|value| self.receive(value));
            if let Err(error) = result {
                self.fail(error);
                return;
            }
        }
    }

    fn receive(&self, value: serde_json::Value) -> Result<(), String> {
        match value.get("kind").and_then(|value| value.as_str()) {
            Some("event") => {
                let payload = value
                    .get("payload")
                    .and_then(|value| value.as_str())
                    .ok_or("Invalid native comparison event payload.")?;
                self.receive_event(payload.to_owned())
            }
            Some("response") => {
                let id = value
                    .get("id")
                    .and_then(|value| value.as_u64())
                    .filter(|id| *id > 0 && *id <= MAX_ID)
                    .ok_or("Invalid native comparison response ID.")?;
                let result = match (value.get("result"), value.get("error")) {
                    (Some(serde_json::Value::String(result)), None) => Ok(result.clone()),
                    (None, Some(serde_json::Value::String(error))) => Err(error.clone()),
                    _ => return Err("Invalid native comparison response.".into()),
                };
                let sender = self
                    .requests
                    .lock()
                    .unwrap()
                    .pending
                    .remove(&id)
                    .ok_or("Native comparison response has an unknown request ID.")?;
                let _ = sender.try_send(result);
                Ok(())
            }
            _ => Err("Invalid native comparison envelope kind.".into()),
        }
    }

    fn fail(&self, message: String) {
        let pending = {
            let mut requests = self.requests.lock().unwrap();
            if requests.failure.is_some() {
                return;
            }
            requests.failure = Some(message.clone());
            std::mem::take(&mut requests.pending)
        };
        let _ = self.shutdown.shutdown(Shutdown::Both);
        for (_, sender) in pending {
            let _ = sender.try_send(Err(message.clone()));
        }
        let mut events = self.events.lock().unwrap();
        events.failure = Some(message);
        events.queued.clear();
        events.bytes = 0;
        events.subscriber = None;
    }
}

struct NativeState(Option<Arc<NativeTransport>>);

fn native(
    state: &tauri::State<'_, NativeState>,
    window: &tauri::WebviewWindow,
) -> Result<Arc<NativeTransport>, String> {
    if window.label() != "comparison" {
        return Err("Native comparison IPC is restricted to the comparison page.".into());
    }
    state
        .0
        .clone()
        .ok_or_else(|| "Native comparison transport is disabled.".into())
}

#[tauri::command]
async fn comparison_request(
    state: tauri::State<'_, NativeState>,
    window: tauri::WebviewWindow,
    path: String,
    payload: String,
) -> Reply {
    let native = native(&state, &window)?;
    let mut receiver =
        tauri::async_runtime::spawn_blocking(move || native.begin_request(path, payload))
            .await
            .map_err(|error| format!("Native comparison request task failed: {error}"))??;
    receiver
        .recv()
        .await
        .unwrap_or_else(|| Err("Native comparison request was cancelled.".into()))
}

#[tauri::command]
async fn comparison_subscribe(
    state: tauri::State<'_, NativeState>,
    window: tauri::WebviewWindow,
    on_event: Channel<String>,
) -> Result<(), String> {
    let native = native(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = native.subscribe(on_event);
        if let Err(error) = &result {
            if error.starts_with("Native comparison event delivery failed:") {
                native.fail(error.clone());
            }
        }
        result
    })
    .await
    .map_err(|error| format!("Native comparison subscription task failed: {error}"))?
}

#[tauri::command]
async fn comparison_close(
    state: tauri::State<'_, NativeState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let native = native(&state, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        native.fail("Native comparison transport closed.".into())
    })
    .await
    .map_err(|error| format!("Native comparison close task failed: {error}"))?;
    Ok(())
}

// Tauri's channel protocol includes sequence numbers because large IPC
// messages can arrive out of order. Keep the page callback in send order.
const NATIVE_INITIALIZATION: &str = r#"
(() => {
  const internals = window.__TAURI_INTERNALS__
  const invoke = (command, args) => internals.invoke(command, args).catch(error => { throw error instanceof Error ? error : new Error(String(error)) })
  let subscribed = false
  window.__comparisonNative = {
    request: (path, payload) => invoke('comparison_request', { path, payload }),
    subscribe: async callback => {
      if (typeof callback !== 'function') throw new Error('Native comparison subscriber must be a function.')
      if (subscribed) throw new Error('Native comparison events are already subscribed.')
      subscribed = true
      let next = 0, end, id, buffered = 0
      const pending = new Map()
      const cleanup = () => internals.unregisterCallback(id)
      const deliver = payload => {
        try { callback(payload) } catch (error) { queueMicrotask(() => { throw error }) }
      }
      id = internals.transformCallback(item => {
        if (item.end) end = item.index
        else if (item.index === next) { next++; deliver(item.message) }
        else {
          if (typeof item.message !== 'string' || pending.size >= 4096 || buffered + item.message.length > 128 * 1024 * 1024) {
            cleanup(); void invoke('comparison_close').catch(() => {})
            queueMicrotask(() => { throw new Error('Native comparison channel reorder buffer is full.') })
            return
          }
          pending.set(item.index, item.message); buffered += item.message.length
        }
        while (pending.has(next)) {
          const payload = pending.get(next); pending.delete(next++); buffered -= payload.length
          deliver(payload)
        }
        if (next === end) cleanup()
      })
      try { await invoke('comparison_subscribe', { onEvent: `__CHANNEL__:${id}` }) }
      catch (error) { cleanup(); subscribed = false; throw error }
    },
    close: () => invoke('comparison_close')
  }
})()
"#;

struct Settings {
    url: tauri::Url,
    width: u32,
    height: u32,
    native: Option<Arc<NativeTransport>>,
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

    let native = if env::var("RADAR_COMPARE_TRANSPORT").ok().as_deref() == Some("native") {
        let socket = env::var("RADAR_COMPARE_SOCKET")
            .map_err(|_| invalid("RADAR_COMPARE_SOCKET is required for native transport"))?;
        let token = env::var("RADAR_COMPARE_NATIVE_TOKEN")
            .map_err(|_| invalid("RADAR_COMPARE_NATIVE_TOKEN is required for native transport"))?;
        Some(NativeTransport::connect(&socket, &token)?)
    } else {
        None
    };

    Ok(Settings {
        url,
        native,
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

    let native_mode = settings.native.is_some();
    let page_url = settings.url.clone();
    let mut builder =
        WebviewWindowBuilder::new(app, "comparison", WebviewUrl::External(settings.url))
            .title("Radar Tauri Comparison")
            .inner_size(f64::from(settings.width), f64::from(settings.height))
            .decorations(false)
            .visible(false)
            .focused(false)
            .focusable(false)
            .incognito(true)
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .on_new_window(|_, _| NewWindowResponse::Deny);
    if native_mode {
        builder = builder
            .initialization_script(NATIVE_INITIALIZATION)
            .on_navigation(move |destination| destination == &page_url);
    }
    let window = builder.build()?;

    // Tauri's show() can make a window key on macOS. Check AppKit's
    // actual window capabilities first, then order it front without activation.
    let native = window.ns_window()?;
    if native.is_null() {
        return Err(invalid("could not obtain the native comparison window").into());
    }
    // This callback runs on AppKit's main thread, and Tauri retains the window.
    let native = unsafe { &*native.cast::<NSWindow>() };
    // Experiment only: keep native RAF/render scheduling active under full
    // occlusion, matching Chromium's disable-backgrounding-occluded-windows.
    // The actual window stays behind the user, nonfocusable and mouse-transparent.
    window.with_webview(|platform| unsafe {
        let view = &*platform.inner().cast::<objc2::runtime::AnyObject>();
        let supported: bool = msg_send![view, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
        assert!(supported, "WebKit occlusion scheduling override is unavailable; cannot measure equal active workloads behind user windows");
        let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
    })?;
    let application = NSApplication::sharedApplication(native.mtm());
    native.setIgnoresMouseEvents(true);
    native.setLevel(-1);
    native.setCollectionBehavior(
        native.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllApplications
            | NSWindowCollectionBehavior::Stationary,
    );
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
            "occlusionScheduling": "disabled-experiment-only-private-WebKit-SPI",
            "placement": "behind-user-windows"
        })
    );
    Ok(())
}

fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn allow_native_commands(
    context: &mut tauri::Context<tauri::Wry>,
    page: &tauri::Url,
) -> Result<(), io::Error> {
    // The comparison shell has one window. Restrict its custom commands to
    // the configured loopback page, and independently check its label in the
    // handlers. No plugin APIs or production permissions are granted.
    let origin = ExecutionContext::Remote {
        url: page
            .as_str()
            .parse()
            .map_err(|_| invalid("invalid native comparison capability URL"))?,
    };
    for command in [
        "comparison_request",
        "comparison_subscribe",
        "comparison_close",
    ] {
        context
            .runtime_authority_mut()
            .__allow_command(command.into(), origin.clone());
    }
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
        || application.isActive()
    {
        return Err(invalid("could not establish the inactive launch policy").into());
    }

    let native = settings.native.clone();
    let mut context = context();
    if native.is_some() {
        allow_native_commands(&mut context, &settings.url)?;
    }
    let mut app = tauri::Builder::default()
        .manage(NativeState(native.clone()))
        .invoke_handler(tauri::generate_handler![
            comparison_request,
            comparison_subscribe,
            comparison_close
        ])
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
        .build(context)?;
    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    app.run(|_, _| {});
    if let Some(native) = native {
        native.fail("Native comparison transport closed.".into());
    }
    Ok(())
}

fn main() {
    let result = settings().map_err(Box::<dyn Error>::from).and_then(run);
    if let Err(error) = result {
        eprintln!("RADAR_COMPARE event=error message={error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::net::UnixListener,
        sync::mpsc,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::ipc::InvokeResponseBody;

    fn read_envelope(reader: &mut BufReader<UnixStream>) -> serde_json::Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn native_commands_only_allow_the_configured_loopback_page() {
        let mut context = context();
        let page = tauri::Url::parse("http://127.0.0.1:31234/session/").unwrap();
        let origin = |url: &str| tauri::ipc::Origin::Remote {
            url: tauri::Url::parse(url).unwrap(),
        };
        assert!(context
            .runtime_authority_mut()
            .resolve_access(
                "comparison_request",
                "comparison",
                "comparison",
                &origin(page.as_str())
            )
            .is_none());
        allow_native_commands(&mut context, &page).unwrap();
        let acl = context.runtime_authority_mut();
        for command in [
            "comparison_request",
            "comparison_subscribe",
            "comparison_close",
        ] {
            assert!(acl
                .resolve_access(command, "comparison", "comparison", &origin(page.as_str()))
                .is_some());
            assert!(acl
                .resolve_access(
                    command,
                    "comparison",
                    "comparison",
                    &origin("http://127.0.0.1:31235/session/")
                )
                .is_none());
            assert!(acl
                .resolve_access(
                    command,
                    "comparison",
                    "comparison",
                    &origin("http://127.0.0.1:31234/other/")
                )
                .is_none());
            assert!(acl
                .resolve_access(
                    command,
                    "comparison",
                    "comparison",
                    &tauri::ipc::Origin::Local
                )
                .is_none());
        }
        assert!(acl
            .resolve_access(
                "plugin:window|show",
                "comparison",
                "comparison",
                &origin(page.as_str())
            )
            .is_none());
    }

    #[test]
    fn native_transport_buffers_events_multiplexes_and_rejects_on_disconnect() {
        let socket = env::temp_dir().join(format!(
            "radar-ipc-{}-{}.sock",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let listener = UnixListener::bind(&socket).unwrap();
        let broker = thread::spawn(move || {
            let (mut writer, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(writer.try_clone().unwrap());
            assert_eq!(
                read_envelope(&mut reader),
                serde_json::json!({"kind": "hello", "token": "secret"})
            );
            let event =
                serde_json::json!({"channel": "chart", "detail": {"value": "雪"}}).to_string();
            writeln!(
                writer,
                "{}",
                serde_json::json!({"kind": "event", "payload": event})
            )
            .unwrap();
            let first = read_envelope(&mut reader);
            let second = read_envelope(&mut reader);
            assert_eq!(first["payload"], "{\"large\":1}");
            assert_eq!(second["path"], "second");
            writeln!(writer, "{}", serde_json::json!({"kind": "response", "id": second["id"], "result": "{\"value\":2}"})).unwrap();
            writeln!(
                writer,
                "{}",
                serde_json::json!({"kind": "response", "id": first["id"], "error": "rejected"})
            )
            .unwrap();
            let _third = read_envelope(&mut reader);
            writer.shutdown(Shutdown::Both).unwrap();
        });
        let client = NativeTransport::connect(socket.to_str().unwrap(), "secret").unwrap();
        let mut first = client
            .begin_request("first".into(), "{\"large\":1}".into())
            .unwrap();
        let mut second = client.begin_request("second".into(), "{}".into()).unwrap();
        assert_eq!(first.blocking_recv().unwrap(), Err("rejected".into()));
        assert_eq!(second.blocking_recv().unwrap(), Ok("{\"value\":2}".into()));
        let (sender, receiver) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sender
                    .send(serde_json::from_str::<String>(&json).unwrap())
                    .unwrap();
            }
            Ok(())
        });
        client.subscribe(channel).unwrap();
        let payload = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap()["detail"]["value"],
            "雪"
        );
        let mut third = client.begin_request("third".into(), "{}".into()).unwrap();
        assert!(third
            .blocking_recv()
            .unwrap()
            .unwrap_err()
            .contains("socket"));
        broker.join().unwrap();
        fs::remove_file(socket).unwrap();
    }

    #[test]
    fn native_transport_enforces_frame_and_event_bounds() {
        assert!(
            NativeTransport::frame(serde_json::json!({"payload": "x".repeat(MAX_FRAME)})).is_err()
        );
        let (writer, _peer) = UnixStream::pair().unwrap();
        let client = NativeTransport {
            shutdown: writer.try_clone().unwrap(),
            writer: Mutex::new(writer),
            requests: Mutex::new(Requests::default()),
            events: Mutex::new(Events::default()),
        };
        assert!(client.receive_event("x".repeat(MAX_FRAME + 1)).is_err());
    }
}
