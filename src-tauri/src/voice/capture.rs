//! The CPAL stream lives and is dropped on its owning OS thread, never on Tokio.
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat,
};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const FRAME: usize = 800; // 50 ms at Whisper's 16 kHz.
const MAX_SAMPLES: usize = 120 * 16_000;
/// Floor of the VAD threshold: frames quieter than this are silence whatever the noise floor.
const MIN_SPEECH_RMS: f32 = 0.008;
pub enum Control {
    Stop,
    Cancel,
}
pub struct Capture {
    pub control: mpsc::Sender<Control>,
    pub ready: oneshot::Receiver<Result<(), String>>,
    pub done: oneshot::Receiver<Result<Vec<f32>, String>>,
}

pub fn to_mono_16k(samples: &[f32], channels: usize, rate: u32) -> Vec<f32> {
    if channels == 0 || rate == 0 {
        return vec![];
    }
    let mono: Vec<f32> = samples
        .chunks_exact(channels)
        .map(|frame| {
            frame
                .iter()
                .map(|x| if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 })
                .sum::<f32>()
                / channels as f32
        })
        .collect();
    let len = (mono.len() as u64 * 16_000 / rate as u64) as usize;
    (0..len)
        .map(|i| {
            let position = i as f64 * rate as f64 / 16_000.0;
            let a = position as usize;
            let b = (a + 1).min(mono.len() - 1);
            mono[a] + (mono[b] - mono[a]) * (position - a as f64) as f32
        })
        .collect()
}
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples
        .iter()
        .map(|x| if x.is_finite() { (*x as f64).powi(2) } else { 0.0 })
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt() as f32
}
pub fn level(samples: &[f32]) -> f32 {
    (rms(samples) * 4.0).clamp(0.0, 1.0)
}

/// Sample-count based so VAD is deterministic regardless of callback packet sizes.
pub struct Vad {
    total: usize,
    silence: usize,
    limit: usize,
    noise: f32,
    noise_frames: usize,
    pub speech: bool,
}
impl Vad {
    pub fn new(silence_ms: u32) -> Self {
        Self {
            total: 0,
            silence: 0,
            limit: silence_ms as usize * 16,
            noise: 0.0,
            noise_frames: 0,
            speech: false,
        }
    }
    pub fn push(&mut self, samples: &[f32], handsfree: bool) -> bool {
        let energy = rms(samples);
        // Limit calibration's influence when the user starts talking immediately.
        if self.total < 4800 {
            self.noise += energy.min(0.02);
            self.noise_frames += 1;
        }
        let floor = self.noise / self.noise_frames.max(1) as f32;
        let threshold = (floor * 3.0).clamp(MIN_SPEECH_RMS, 0.05);
        if energy > threshold {
            self.speech = true;
            self.silence = 0;
        } else if self.speech {
            self.silence += samples.len();
        }
        self.total += samples.len();
        self.total >= MAX_SAMPLES || (handsfree && self.speech && self.silence >= self.limit)
    }
}

pub fn devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let mut names: Vec<_> = host
        .input_devices()
        .map_err(|e| format!("no microphone: {e}"))?
        .filter_map(|d| d.description().ok().map(|d| d.name().to_owned()))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}
fn mic_error(error: cpal::Error) -> String {
    if matches!(error.kind(), cpal::ErrorKind::PermissionDenied) || error.to_string().to_lowercase().contains("access is denied")
    {
        "microphone blocked: turn on \"Let desktop apps access your microphone\" in Windows Settings > Privacy & security > Microphone"
            .into()
    } else {
        format!("no microphone: {error}")
    }
}
fn stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    tx: mpsc::SyncSender<Result<Vec<f32>, String>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let errors = tx.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data, _| {
                let data = data.iter().map(|s| s.to_sample::<f32>()).collect();
                let _ = tx.try_send(Ok(data));
            },
            move |e| {
                if !matches!(
                    e.kind(),
                    cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied
                ) {
                    let _ = errors.try_send(Err(mic_error(e)));
                }
            },
            None,
        )
        .map_err(mic_error)
}
fn open(name: &str, tx: mpsc::SyncSender<Result<Vec<f32>, String>>) -> Result<(cpal::Stream, usize, u32), String> {
    let host = cpal::default_host();
    let device = if name.is_empty() {
        host.default_input_device()
    } else {
        host.input_devices()
            .map_err(mic_error)?
            .find(|d| d.description().is_ok_and(|d| d.name() == name))
    }
    .ok_or_else(|| format!("no microphone: {}", if name.is_empty() { "no default input device" } else { name }))?;
    let supported = device.default_input_config().map_err(mic_error)?;
    let config = supported.config();
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    let stream = match supported.sample_format() {
        SampleFormat::I8 => stream::<i8>(&device, config, tx),
        SampleFormat::I16 => stream::<i16>(&device, config, tx),
        SampleFormat::I24 => stream::<cpal::I24>(&device, config, tx),
        SampleFormat::I32 => stream::<i32>(&device, config, tx),
        SampleFormat::I64 => stream::<i64>(&device, config, tx),
        SampleFormat::U8 => stream::<u8>(&device, config, tx),
        SampleFormat::U16 => stream::<u16>(&device, config, tx),
        SampleFormat::U24 => stream::<cpal::U24>(&device, config, tx),
        SampleFormat::U32 => stream::<u32>(&device, config, tx),
        SampleFormat::U64 => stream::<u64>(&device, config, tx),
        SampleFormat::F32 => stream::<f32>(&device, config, tx),
        SampleFormat::F64 => stream::<f64>(&device, config, tx),
        _ => Err("no microphone: unsupported DSD input format".into()),
    }?;
    stream.play().map_err(mic_error)?;
    Ok((stream, channels, rate))
}

pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(crate::err)?;
    let spec = reader.spec();
    let max = spec.sample_rate as usize * spec.channels as usize * 120;
    let samples: Result<Vec<f32>, _> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().take(max).collect(),
        hound::SampleFormat::Int => {
            let scale = 2.0f32.powi(spec.bits_per_sample as i32 - 1);
            reader.samples::<i32>().take(max).map(|s| s.map(|s| s as f32 / scale)).collect()
        }
    };
    Ok(to_mono_16k(&samples.map_err(crate::err)?, spec.channels as usize, spec.sample_rate))
}

pub fn spawn(device: String, handsfree: bool, silence_ms: u32, mut on_level: impl FnMut(f32) + Send + 'static) -> Result<Capture, String> {
    let (control, controls) = mpsc::channel();
    let (ready_tx, ready) = oneshot::channel();
    let (done_tx, done) = oneshot::channel();
    std::thread::Builder::new()
        .name("orbit-microphone".into())
        .spawn(move || {
            let (tx, rx) = mpsc::sync_channel(64);
            let fake = std::env::var_os("ORBIT_VOICE_FAKE_WAV");
            // The stream stays in this stack frame for its entire lifetime.
            let source = if let Some(path) = fake {
                read_wav(Path::new(&path)).map(|wav| (None, 1, 16_000, Some(wav)))
            } else {
                open(&device, tx).map(|(s, c, r)| (Some(s), c, r, None))
            };
            let (stream, channels, rate, wav) = match source {
                Ok(source) => {
                    let _ = ready_tx.send(Ok(()));
                    source
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.clone()));
                    let _ = done_tx.send(Err(e));
                    return;
                }
            };
            let mut vad = Vad::new(silence_ms);
            let mut audio = Vec::new();
            let mut pending = Vec::new();
            let mut offset = 0;
            let start = Instant::now();
            let result = 'capture: loop {
                match controls.try_recv() {
                    Ok(Control::Cancel) | Err(mpsc::TryRecvError::Disconnected) => break Ok(vec![]),
                    Ok(Control::Stop) => {
                        // Preserve the last partial 50 ms packet, including final consonants.
                        let tail = to_mono_16k(&pending, channels, rate);
                        vad.push(&tail, false);
                        audio.extend_from_slice(&tail[..tail.len().min(MAX_SAMPLES - audio.len())]);
                        break Ok(audio);
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if start.elapsed() >= Duration::from_secs(120) {
                    break Ok(audio);
                }
                if let Some(wav) = &wav {
                    // Wait before each packet, keeping fake input real-time and cancel responsive.
                    match controls.recv_timeout(Duration::from_millis(50)) {
                        Ok(Control::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(vec![]),
                        Ok(Control::Stop) => break Ok(audio),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    let mut frame = vec![0.0; FRAME];
                    let end = (offset + FRAME).min(wav.len());
                    if offset < end {
                        frame[..end - offset].copy_from_slice(&wav[offset..end]);
                    }
                    offset = end;
                    pending.extend(frame);
                } else {
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(Ok(data)) => pending.extend(data),
                        Ok(Err(e)) => break Err(e),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break Err("no microphone: input stream disconnected".into()),
                    }
                }
                let frame_len = (rate as usize / 20).max(1) * channels;
                while pending.len() >= frame_len {
                    let frame = to_mono_16k(&pending[..frame_len], channels, rate);
                    pending.drain(..frame_len);
                    on_level(level(&frame));
                    let ended = vad.push(&frame, handsfree);
                    audio.extend_from_slice(&frame[..frame.len().min(MAX_SAMPLES - audio.len())]);
                    if ended {
                        break 'capture Ok(audio);
                    }
                }
            };
            drop(stream); // Close the mic before transcription/result publication.
            // Hands-free needs the VAD to have heard speech. Dictation is deliberate (and push-to-talk often
            // starts mid-word, inside the noise calibration), so it only drops recordings that are near silent.
            let heard = |audio: &[f32]| vad.speech || (!handsfree && audio.chunks(FRAME).any(|f| rms(f) > MIN_SPEECH_RMS));
            let result = result.map(|audio| if heard(&audio) { audio } else { vec![] });
            let _ = done_tx.send(result);
        })
        .map_err(crate::err)?;
    Ok(Capture { control, ready, done })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mono_resampling() {
        assert_eq!(to_mono_16k(&[1.0, -1.0, 0.5, 0.5], 2, 16_000), [0.0, 0.5]);
        assert_eq!(to_mono_16k(&[0.0, 0.5], 1, 8000), [0.0, 0.25, 0.5, 0.5]);
        assert_eq!(to_mono_16k(&[0.0, 0.1, 0.2, 0.3, 0.4, 0.5], 1, 48_000), [0.0, 0.3]);
        assert_eq!(to_mono_16k(&vec![0.25; 44_100 * 2], 2, 44_100).len(), 16_000);
        assert!(to_mono_16k(&[], 1, 48_000).is_empty());
        assert!(to_mono_16k(&[1.0], 0, 0).is_empty());
    }
    #[test]
    fn rms_scaling() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; FRAME]), 0.0);
        assert_eq!(level(&[0.125; FRAME]), 0.5);
        assert_eq!(level(&[-1.0; FRAME]), 1.0);
        assert_eq!(rms(&[0.5, -0.5]), 0.5);
    }
    #[test]
    fn vad_speech_then_silence() {
        let mut v = Vad::new(300);
        for _ in 0..6 {
            assert!(!v.push(&[0.001; FRAME], true));
        }
        assert!(!v.push(&[0.2; FRAME], true));
        for _ in 0..5 {
            assert!(!v.push(&[0.0; FRAME], true));
        }
        assert!(v.push(&[0.0; FRAME], true));
    }
    #[test]
    fn vad_silence_only_caps() {
        let mut v = Vad::new(300);
        for _ in 0..2399 {
            assert!(!v.push(&[0.0; FRAME], true));
        }
        assert!(v.push(&[0.0; FRAME], true));
        assert!(!v.speech);
    }
    #[test]
    fn vad_short_pauses_and_dictation() {
        let mut v = Vad::new(300);
        for _ in 0..20 {
            assert!(!v.push(&[0.2; FRAME], true));
            for _ in 0..4 {
                assert!(!v.push(&[0.0; FRAME], true));
            }
        }
        for _ in 0..10 {
            assert!(!v.push(&[0.0; FRAME], false));
        }
    }
}
