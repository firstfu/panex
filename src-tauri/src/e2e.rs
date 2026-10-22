//! End-to-end test hook, compiled only with `--features e2e`: runs a piece of JavaScript in
//! the window and returns its result, so a test script can drive the real app (real backend,
//! real shells) on macOS, where WKWebView has no WebDriver or remote debugging port.
//!
//! Running arbitrary JS is as powerful as it gets, so three locks: the feature is off in every
//! shipped build, the request must carry PANEX_E2E_TOKEN that the test set when it launched this
//! instance, and the released identifier refuses it even if someone built it in by mistake.

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// `{"op":"e2e-eval","e2e":"<token>","js":"<body>"}` → whatever the body returns.
/// The body is an async function body: use `return` and `await`; the value must be JSON-able.
pub async fn eval(app: &AppHandle, req: &Value) -> Result<Value, String> {
    let token = std::env::var("PANEX_E2E_TOKEN").unwrap_or_default();
    if token.is_empty() || req["e2e"].as_str() != Some(token.as_str()) || app.config().identifier == crate::hooks::RELEASE_ID {
        return Err("refused".into());
    }
    let body = req["js"].as_str().ok_or("missing js")?;
    let win = app.get_webview_window("main").ok_or("no window")?;
    crate::control::ask_frontend(app, |id| {
        let _ = win.eval(script(id, body));
    })
    .await
}

/// Wraps the body so its result (or error) comes back through the existing `ctl_reply`. The
/// body is pasted in as code: the window's CSP blocks `new Function`, and whoever may send it
/// can run anything anyway.
fn script(id: u64, body: &str) -> String {
    format!(
        r#"(async () => {{
  const reply = (ok, value) => window.__TAURI_INTERNALS__.invoke("ctl_reply", {{ req: {id}, ok, value }});
  try {{
    const v = await (async () => {{
{body}
}})();
    reply(true, v === undefined ? null : JSON.parse(JSON.stringify(v)));
  }} catch (e) {{
    // WebKit's stack leaves out the message.
    reply(false, `${{e}}\n${{(e && e.stack) || ""}}`);
  }}
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_runs_inside_the_reply_wrapper() {
        let s = script(7, "return 1;");
        assert!(s.contains("req: 7"));
        assert!(s.contains("(async () => {\nreturn 1;\n})()"));
    }
}
