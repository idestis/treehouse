//! The computer's sound for screen sharing on macOS.
//!
//! The macOS web view's `getDisplayMedia` shares only the picture, so the
//! sound is captured here with ScreenCaptureKit (macOS 13+) and streamed to
//! the web view, which publishes it into the call as the screen-share audio
//! track. Windows keeps using `getDisplayMedia`'s own system audio.
//!
//! Wire format: each channel message is one binary chunk of 20 ms of
//! 48 kHz stereo sound, as interleaved signed 16-bit little-endian samples
//! (L R L R …, 3840 bytes). A JSON message `"stopped"` means capture ended
//! on its own (for example the permission was taken away).
//!
//! Errors are short codes the UI maps to its own copy:
//! `permission` (Screen Recording not allowed), `unsupported` (not macOS 13+),
//! `failed` (anything else).

use std::sync::Mutex;

use tauri::AppHandle;
use tauri::ipc::Channel;

/// Sample rate of the chunks sent to the web view.
pub const SAMPLE_RATE: usize = 48_000;
/// Frames (one sample per channel) in each chunk: 20 ms.
pub const CHUNK_FRAMES: usize = SAMPLE_RATE / 50;
/// Bytes in each chunk: stereo, 16 bits per sample.
pub const CHUNK_BYTES: usize = CHUNK_FRAMES * 2 * 2;

/// The running capture, if any. One at a time.
#[derive(Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct SystemAudio(Mutex<Option<imp::Capture>>);

/// Start sending the computer's sound to `channel`. Replaces a capture already running.
#[tauri::command]
pub async fn system_audio_start(app: AppHandle, channel: Channel) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::start(&app, channel))
        .await
        .map_err(|_| "failed".to_string())?
}

/// Stop sending the computer's sound. Does nothing when nothing is running.
#[tauri::command]
pub async fn system_audio_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::stop(&app))
        .await
        .map_err(|_| "failed".to_string())
}

/// Turns captured float samples into fixed 20 ms chunks of interleaved i16 LE.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Framer {
    pending: Vec<u8>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Framer {
    pub fn new() -> Self {
        Self {
            pending: Vec::with_capacity(CHUNK_BYTES),
        }
    }

    /// Two planar channels (mono input: pass the same slice twice).
    pub fn push_planar(&mut self, left: &[f32], right: &[f32], out: &mut impl FnMut(Vec<u8>)) {
        for (l, r) in left.iter().zip(right) {
            self.push_frame(*l, *r, out);
        }
    }

    /// Interleaved samples with `channels` per frame; the first two are kept.
    pub fn push_interleaved(
        &mut self,
        samples: &[f32],
        channels: usize,
        out: &mut impl FnMut(Vec<u8>),
    ) {
        if channels == 0 {
            return;
        }
        for frame in samples.chunks_exact(channels) {
            let l = frame[0];
            let r = frame.get(1).copied().unwrap_or(l);
            self.push_frame(l, r, out);
        }
    }

    fn push_frame(&mut self, l: f32, r: f32, out: &mut impl FnMut(Vec<u8>)) {
        self.pending.extend_from_slice(&to_i16(l).to_le_bytes());
        self.pending.extend_from_slice(&to_i16(r).to_le_bytes());
        if self.pending.len() >= CHUNK_BYTES {
            let full = std::mem::replace(&mut self.pending, Vec::with_capacity(CHUNK_BYTES));
            out(full);
        }
    }
}

/// Float sample in [-1, 1] to i16; louder is clipped, NaN is silence.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn to_i16(x: f32) -> i16 {
    if x.is_nan() {
        return 0;
    }
    (x.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;
    use tauri::ipc::Channel;

    pub type Capture = ();

    pub fn start(_app: &AppHandle, _channel: Channel) -> Result<(), String> {
        Err("unsupported".into())
    }

    pub fn stop(_app: &AppHandle) {}
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::{self, NonNull};
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use dispatch2::{DispatchQueue, DispatchRetained};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
    use objc2_core_audio_types::{
        AudioBuffer, AudioBufferList, kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved,
    };
    use objc2_core_foundation::CFRetained;
    use objc2_core_media::{
        CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    };
    use objc2_foundation::{
        NSArray, NSError, NSObject, NSObjectProtocol, NSOperatingSystemVersion, NSProcessInfo,
    };
    use objc2_screen_capture_kit::{
        SCContentFilter, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration,
        SCStreamDelegate, SCStreamErrorCode, SCStreamOutput, SCStreamOutputType,
    };
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::{AppHandle, Manager};

    use super::{Framer, SAMPLE_RATE, SystemAudio};

    const WAIT: Duration = Duration::from_secs(10);

    /// Objective-C objects handed between ScreenCaptureKit's queues and ours.
    /// ScreenCaptureKit objects may be used from any thread.
    struct Shared<T>(T);
    // SAFETY: only immutable ScreenCaptureKit objects and SCStream (documented
    // as callable from any queue) are wrapped.
    unsafe impl<T> Send for Shared<T> {}

    pub struct Capture {
        stream: Shared<Retained<SCStream>>,
        output: Shared<Retained<Output>>,
        _queue: Shared<DispatchRetained<DispatchQueue>>,
    }

    pub struct Ivars {
        sink: Mutex<Option<(Framer, Channel)>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; Output has no Drop.
        #[unsafe(super(NSObject))]
        #[name = "TreehouseSystemAudioOutput"]
        #[ivars = Ivars]
        pub struct Output;

        unsafe impl NSObjectProtocol for Output {}

        unsafe impl SCStreamOutput for Output {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            fn did_output(
                &self,
                _stream: &SCStream,
                sample: &CMSampleBuffer,
                kind: SCStreamOutputType,
            ) {
                if kind != SCStreamOutputType::Audio {
                    return; // the tiny picture ScreenCaptureKit insists on is ignored
                }
                let Ok(mut sink) = self.ivars().sink.lock() else {
                    return;
                };
                let Some((framer, channel)) = sink.as_mut() else {
                    return;
                };
                // SAFETY: `sample` is a valid sample buffer for the duration of this call.
                unsafe { read_audio(sample, framer, channel) };
            }
        }

        unsafe impl SCStreamDelegate for Output {
            #[unsafe(method(stream:didStopWithError:))]
            fn did_stop(&self, _stream: &SCStream, _error: &NSError) {
                self.report_stop();
            }
        }
    );

    impl Output {
        pub(super) fn new(channel: Channel) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                sink: Mutex::new(Some((Framer::new(), channel))),
            });
            // SAFETY: NSObject's init on a freshly allocated object.
            unsafe { msg_send![super(this), init] }
        }

        /// Capture ended on its own: tell the web view once.
        pub(super) fn report_stop(&self) {
            if let Ok(mut sink) = self.ivars().sink.lock()
                && let Some((_, channel)) = sink.take()
            {
                let _ = channel.send(InvokeResponseBody::Json("\"stopped\"".into()));
            }
        }

        fn close(&self) {
            if let Ok(mut sink) = self.ivars().sink.lock() {
                sink.take();
            }
        }
    }

    /// Copy one ScreenCaptureKit audio buffer (32-bit float, planar or
    /// interleaved) into the framer, sending every full chunk.
    unsafe fn read_audio(sample: &CMSampleBuffer, framer: &mut Framer, channel: &Channel) {
        // SAFETY (whole function): CoreMedia calls on a valid sample buffer; the
        // buffer list memory is ours and outlives the slices made from it, and
        // the audio data is kept alive by the retained block buffer.
        unsafe {
            if !sample.data_is_ready() {
                return;
            }
            let Some(format) = sample.format_description() else {
                return;
            };
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(&format);
            let Some(asbd) = asbd.as_ref() else { return };
            if asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
                return;
            }
            let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;

            let mut needed = 0usize;
            let status = sample.audio_buffer_list_with_retained_block_buffer(
                &mut needed,
                ptr::null_mut(),
                0,
                None,
                None,
                0,
                ptr::null_mut(),
            );
            if status != 0 || needed == 0 {
                return;
            }
            // u64 storage keeps the list 8-byte aligned, as AudioBufferList needs.
            let mut storage = vec![0u64; needed.div_ceil(8)];
            let list = storage.as_mut_ptr().cast::<AudioBufferList>();
            let mut block: *mut CMBlockBuffer = ptr::null_mut();
            let status = sample.audio_buffer_list_with_retained_block_buffer(
                ptr::null_mut(),
                list,
                needed,
                None,
                None,
                kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                &mut block,
            );
            let Some(block) = NonNull::new(block) else {
                return;
            };
            let _block: CFRetained<CMBlockBuffer> = CFRetained::from_raw(block);
            if status != 0 {
                return;
            }

            let count = (*list).mNumberBuffers as usize;
            let buffers: &[AudioBuffer] =
                std::slice::from_raw_parts(ptr::addr_of!((*list).mBuffers).cast(), count);
            let floats = |b: &AudioBuffer| -> &[f32] {
                if b.mData.is_null() {
                    return &[];
                }
                std::slice::from_raw_parts(b.mData.cast::<f32>(), b.mDataByteSize as usize / 4)
            };
            let mut send = |chunk: Vec<u8>| {
                let _ = channel.send(InvokeResponseBody::Raw(chunk));
            };
            match (planar, buffers) {
                (true, [left, right, ..]) => {
                    framer.push_planar(floats(left), floats(right), &mut send)
                }
                (true, [mono]) => framer.push_planar(floats(mono), floats(mono), &mut send),
                (false, [one, ..]) => {
                    framer.push_interleaved(floats(one), one.mNumberChannels as usize, &mut send)
                }
                _ => {}
            }
        }
    }

    fn state(app: &AppHandle) -> &Mutex<Option<Capture>> {
        &app.state::<SystemAudio>().inner().0
    }

    pub fn stop(app: &AppHandle) {
        let Ok(mut current) = state(app).lock() else {
            return;
        };
        if let Some(capture) = current.take() {
            shut(capture);
        }
    }

    fn shut(capture: Capture) {
        capture.output.0.close();
        let (tx, rx) = mpsc::channel::<()>();
        let done = RcBlock::new(move |_err: *mut NSError| {
            let _ = tx.send(());
        });
        // SAFETY: stopping a stream we started; the block is valid until called.
        unsafe {
            capture
                .stream
                .0
                .stopCaptureWithCompletionHandler(Some(&done))
        };
        let _ = rx.recv_timeout(WAIT);
    }

    fn code_of(err: &NSError) -> String {
        if err.code() == SCStreamErrorCode::UserDeclined.0 {
            "permission".into()
        } else {
            "failed".into()
        }
    }

    /// Sound at 48 kHz stereo, never Treehouse's own; the picture
    /// ScreenCaptureKit always captures too is kept tiny and rare.
    pub(super) fn configuration() -> Retained<SCStreamConfiguration> {
        // SAFETY: plain property setters on a new configuration object.
        unsafe {
            let config = SCStreamConfiguration::new();
            config.setCapturesAudio(true);
            config.setSampleRate(SAMPLE_RATE as isize);
            config.setChannelCount(2);
            config.setExcludesCurrentProcessAudio(true);
            config.setWidth(2);
            config.setHeight(2);
            config.setMinimumFrameInterval(CMTime::new(1, 1));
            config.setShowsCursor(false);
            config.setQueueDepth(3);
            config
        }
    }

    pub fn start(app: &AppHandle, channel: Channel) -> Result<(), String> {
        let at_least_13 = NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(
            NSOperatingSystemVersion {
                majorVersion: 13,
                minorVersion: 0,
                patchVersion: 0,
            },
        );
        if !at_least_13 {
            return Err("unsupported".into());
        }
        let mut current = state(app).lock().map_err(|_| "failed".to_string())?;
        if let Some(old) = current.take() {
            shut(old);
        }

        // What can be captured. Fails with "user declined" without Screen Recording permission.
        let (tx, rx) = mpsc::channel::<Result<Shared<Retained<SCShareableContent>>, String>>();
        let got = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            // SAFETY: ScreenCaptureKit passes valid (or null) objects to the handler.
            let result = match unsafe { (Retained::retain(content), err.as_ref()) } {
                (Some(content), _) => Ok(Shared(content)),
                (None, Some(err)) => Err(code_of(err)),
                (None, None) => Err("failed".to_string()),
            };
            let _ = tx.send(result);
        });
        // SAFETY: the block lives until ScreenCaptureKit calls it.
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&got) };
        let content = rx.recv_timeout(WAIT).map_err(|_| "failed".to_string())??.0;

        // SAFETY (rest of the function): plain ScreenCaptureKit configuration calls.
        unsafe {
            let displays = content.displays();
            let display = displays.firstObject().ok_or_else(|| "failed".to_string())?;

            // Never send Treehouse's own sound (the call) back into the call.
            let own_id = app.config().identifier.clone();
            let pid = std::process::id() as i32;
            let apps = content.applications();
            let own: Vec<Retained<SCRunningApplication>> = apps
                .iter()
                .filter(|a| a.processID() == pid || a.bundleIdentifier().to_string() == own_id)
                .collect();
            let own = NSArray::from_retained_slice(&own);
            let filter = SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &own,
                &NSArray::new(),
            );

            let config = configuration();

            let output = Output::new(channel);
            let delegate = ProtocolObject::<dyn SCStreamDelegate>::from_ref(&*output);
            let stream = SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(delegate),
            );
            let queue = DispatchQueue::new("app.treehouse.system-audio", None);
            let as_output = ProtocolObject::<dyn SCStreamOutput>::from_ref(&*output);
            for kind in [SCStreamOutputType::Audio, SCStreamOutputType::Screen] {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(as_output, kind, Some(&queue))
                    .map_err(|_| "failed".to_string())?;
            }

            let (tx, rx) = mpsc::channel::<Result<(), String>>();
            let started = RcBlock::new(move |err: *mut NSError| {
                let _ = tx.send(match err.as_ref() {
                    Some(err) => Err(code_of(err)),
                    None => Ok(()),
                });
            });
            stream.startCaptureWithCompletionHandler(Some(&started));
            let capture = Capture {
                stream: Shared(stream),
                output: Shared(output),
                _queue: Shared(queue),
            };
            match rx.recv_timeout(WAIT) {
                Ok(Ok(())) => {
                    *current = Some(capture);
                    Ok(())
                }
                Ok(Err(code)) => {
                    capture.output.0.close();
                    Err(code)
                }
                Err(_) => {
                    shut(capture);
                    Err("failed".into())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(f: impl FnOnce(&mut Framer, &mut dyn FnMut(Vec<u8>))) -> (Vec<Vec<u8>>, Framer) {
        let mut chunks = Vec::new();
        let mut framer = Framer::new();
        f(&mut framer, &mut |c| chunks.push(c));
        (chunks, framer)
    }

    fn samples(chunk: &[u8]) -> Vec<i16> {
        chunk
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    #[test]
    fn chunk_is_20ms_of_stereo_i16() {
        assert_eq!(CHUNK_FRAMES, 960);
        assert_eq!(CHUNK_BYTES, 3840);
    }

    #[test]
    fn planar_is_interleaved_left_right() {
        let left = vec![0.5f32; CHUNK_FRAMES];
        let right = vec![-0.5f32; CHUNK_FRAMES];
        let (chunks, _) = collect(|f, out| f.push_planar(&left, &right, &mut |c| out(c)));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), CHUNK_BYTES);
        let s = samples(&chunks[0]);
        assert_eq!(&s[..4], &[16384, -16384, 16384, -16384]);
    }

    #[test]
    fn partial_chunks_wait_for_more() {
        let half = vec![0.0f32; CHUNK_FRAMES / 2];
        let (chunks, mut framer) = collect(|f, out| f.push_planar(&half, &half, &mut |c| out(c)));
        assert!(chunks.is_empty());
        let mut more = Vec::new();
        // One chunk more: one full chunk out (half old, half new), a half left over.
        let rest = vec![0.25f32; CHUNK_FRAMES];
        framer.push_planar(&rest, &rest, &mut |c| more.push(c));
        assert_eq!(more.len(), 1);
        let s = samples(&more[0]);
        assert_eq!(s[0], 0); // the first half chunk comes first, in order
        assert_eq!(s[CHUNK_FRAMES], 8192);
        assert_eq!(framer.pending.len(), CHUNK_BYTES / 2);
    }

    #[test]
    fn interleaved_keeps_first_two_channels_and_mono_duplicates() {
        let stereo: Vec<f32> = (0..CHUNK_FRAMES).flat_map(|_| [1.0, -1.0, 0.3]).collect();
        let (chunks, _) = collect(|f, out| f.push_interleaved(&stereo, 3, &mut |c| out(c)));
        assert_eq!(&samples(&chunks[0])[..2], &[32767, -32767]);

        let mono = vec![0.5f32; CHUNK_FRAMES];
        let (chunks, _) = collect(|f, out| f.push_interleaved(&mono, 1, &mut |c| out(c)));
        assert_eq!(&samples(&chunks[0])[..2], &[16384, 16384]);
    }

    #[test]
    fn loud_and_broken_samples_are_safe() {
        assert_eq!(to_i16(2.0), i16::MAX);
        assert_eq!(to_i16(-2.0), -i16::MAX);
        assert_eq!(to_i16(f32::NAN), 0);
    }

    /// The Objective-C side builds and the selectors exist at runtime
    /// (no permission needed: nothing is captured).
    #[cfg(target_os = "macos")]
    #[test]
    fn capture_objects_build_and_report_a_stop() {
        use std::sync::{Arc, Mutex};
        use tauri::ipc::{Channel, InvokeResponseBody};

        let config = imp::configuration();
        // SAFETY: plain property getters.
        unsafe {
            assert!(config.capturesAudio());
            assert!(config.excludesCurrentProcessAudio());
            assert_eq!(config.sampleRate(), 48_000);
            assert_eq!(config.channelCount(), 2);
        }

        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = got.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                seen.lock().map(|mut v| v.push(s)).ok();
            }
            Ok(())
        });
        let output = imp::Output::new(channel);
        output.report_stop();
        output.report_stop(); // only once
        let got = got.lock().map(|v| v.clone()).unwrap_or_default();
        assert_eq!(got, vec!["\"stopped\"".to_string()]);
    }
}
