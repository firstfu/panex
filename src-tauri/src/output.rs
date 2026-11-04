//! Hands PTY output to the webview in batches. Every send crosses three processes (panex, the
//! webview's browser process, its renderer) and wakes the terminal's parser, so the cost is per
//! chunk, not per byte, and a stream of small chunks was most of what a busy tab cost.
//!
//! The first output after a pause goes out at once, so typing feels the same and a program's
//! terminal query is answered without delay. Only what follows within the gap waits, briefly on
//! the visible tab and longer on the others. Nothing runs while there is no output: the flusher
//! thread sleeps on a condvar until a batch has something waiting.

use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

/// One frame: the terminal can't show more often than this anyway.
const VISIBLE_GAP: Duration = Duration::from_millis(16);
/// Nobody is watching. Long enough to merge a stream, short enough for a notification or a bell.
const HIDDEN_GAP: Duration = Duration::from_millis(250);
/// Past this a batch goes out early, so a flood doesn't grow one huge buffer.
const MAX_PENDING: usize = 1 << 20;

/// When output is sent. Separate from the channel and the clock so it can be tested alone.
struct Batch {
    pending: Vec<u8>,
    last_sent: Option<Instant>,
}

impl Batch {
    fn new() -> Self {
        Batch { pending: Vec::new(), last_sent: None }
    }

    /// Takes new output. Returns what to send now, if anything.
    fn offer(&mut self, data: &[u8], now: Instant, gap: Duration) -> Option<Vec<u8>> {
        self.pending.extend_from_slice(data);
        let paused = self.last_sent.is_none_or(|t| now.duration_since(t) >= gap);
        if paused || self.pending.len() >= MAX_PENDING {
            return self.take(now);
        }
        None
    }

    /// When the waiting output is due; None when nothing waits.
    fn due(&self, gap: Duration, now: Instant) -> Option<Instant> {
        if self.pending.is_empty() {
            return None;
        }
        Some(self.last_sent.map_or(now, |t| t + gap))
    }

    fn take(&mut self, now: Instant) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            return None;
        }
        self.last_sent = Some(now);
        Some(std::mem::take(&mut self.pending))
    }
}

struct State {
    channel: Channel<InvokeResponseBody>,
    batch: Batch,
}

impl State {
    fn send(&self, data: Vec<u8>) {
        // A send error means the webview is gone (reload/crash); the reader keeps draining.
        let _ = self.channel.send(InvokeResponseBody::Raw(data));
    }
}

/// One tab's way to the webview.
pub struct Outlet {
    id: String,
    state: Mutex<State>,
}

#[derive(Default)]
struct Shared {
    outlets: Vec<Weak<Outlet>>,
    visible: Option<String>,
}

impl Shared {
    fn gap(&self, id: &str) -> Duration {
        if self.visible.as_deref() == Some(id) { VISIBLE_GAP } else { HIDDEN_GAP }
    }
}

#[derive(Default)]
struct Flusher {
    shared: Mutex<Shared>,
    wake: Condvar,
}

fn flusher() -> &'static Flusher {
    static FLUSHER: OnceLock<&'static Flusher> = OnceLock::new();
    FLUSHER.get_or_init(|| {
        let f: &'static Flusher = Box::leak(Box::default());
        std::thread::spawn(move || f.run());
        f
    })
}

impl Flusher {
    fn run(&self) {
        let mut shared = self.shared.lock().unwrap();
        loop {
            shared.outlets.retain(|o| o.strong_count() > 0);
            let now = Instant::now();
            let mut next: Option<Instant> = None;
            for outlet in shared.outlets.iter().filter_map(Weak::upgrade) {
                let mut state = outlet.state.lock().unwrap();
                let Some(due) = state.batch.due(shared.gap(&outlet.id), now) else { continue };
                if due > now {
                    next = Some(next.map_or(due, |n| n.min(due)));
                } else if let Some(data) = state.batch.take(now) {
                    state.send(data);
                }
            }
            shared = match next {
                Some(at) => self.wake.wait_timeout(shared, at.saturating_duration_since(now)).unwrap().0,
                None => self.wake.wait(shared).unwrap(),
            };
        }
    }

    /// Under the lock the flusher holds while it looks, so it can't miss what was just added.
    fn notify(&self) {
        let _shared = self.shared.lock().unwrap();
        self.wake.notify_one();
    }
}

impl Outlet {
    pub fn new(id: String, channel: Channel<InvokeResponseBody>) -> Arc<Self> {
        let outlet = Arc::new(Outlet { id, state: Mutex::new(State { channel, batch: Batch::new() }) });
        flusher().shared.lock().unwrap().outlets.push(Arc::downgrade(&outlet));
        outlet
    }

    /// The webview reloaded and handed a new channel for the running shell.
    pub fn replace_channel(&self, channel: Channel<InvokeResponseBody>) {
        self.state.lock().unwrap().channel = channel;
    }

    pub fn write(&self, data: &[u8]) {
        let flusher = flusher();
        let gap = flusher.shared.lock().unwrap().gap(&self.id);
        let mut state = self.state.lock().unwrap();
        match state.batch.offer(data, Instant::now(), gap) {
            Some(out) => state.send(out),
            None => {
                drop(state);
                flusher.notify();
            }
        }
    }

    /// Sends what's waiting now: the shell ended, or the tab came on screen.
    pub fn flush(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(data) = state.batch.take(Instant::now()) {
            state.send(data);
        }
    }
}

/// The tab on screen gets its output sooner. Whatever it had waiting goes out right away.
#[tauri::command]
pub fn pty_set_visible(id: Option<String>) {
    let flusher = flusher();
    let outlet = {
        let mut shared = flusher.shared.lock().unwrap();
        shared.visible.clone_from(&id);
        id.and_then(|id| shared.outlets.iter().filter_map(Weak::upgrade).find(|o| o.id == id))
    };
    if let Some(outlet) = outlet {
        outlet.flush();
    }
    flusher.notify();
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAP: Duration = Duration::from_millis(100);

    #[test]
    fn output_after_a_pause_goes_out_at_once() {
        let mut b = Batch::new();
        let t = Instant::now();
        assert_eq!(b.offer(b"a", t, GAP).as_deref(), Some(&b"a"[..]));
        assert_eq!(b.offer(b"b", t + GAP * 2, GAP).as_deref(), Some(&b"b"[..]));
    }

    #[test]
    fn a_stream_waits_for_the_gap_and_keeps_its_order() {
        let mut b = Batch::new();
        let t = Instant::now();
        b.offer(b"a", t, GAP);
        assert_eq!(b.offer(b"b", t + GAP / 4, GAP), None);
        assert_eq!(b.offer(b"c", t + GAP / 2, GAP), None);
        assert_eq!(b.due(GAP, t + GAP / 2), Some(t + GAP));
        assert_eq!(b.take(t + GAP).as_deref(), Some(&b"bc"[..]));
        assert_eq!(b.due(GAP, t + GAP), None);
    }

    #[test]
    fn a_flood_goes_out_before_the_gap() {
        let mut b = Batch::new();
        let t = Instant::now();
        b.offer(b"a", t, GAP);
        let big = vec![0u8; MAX_PENDING];
        assert_eq!(b.offer(&big, t, GAP).map(|d| d.len()), Some(MAX_PENDING));
    }
}
