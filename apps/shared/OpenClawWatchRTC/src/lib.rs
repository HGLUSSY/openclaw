#![deny(unsafe_op_in_unsafe_fn)]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::time::Instant;
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct OpenClawRTCAddress {
    address: [u8; 16],
    port: u16,
    family: u16,
}

impl OpenClawRTCAddress {
    fn socket(self) -> Result<SocketAddr, i32> {
        let ip = match self.family {
            4 => IpAddr::V4(Ipv4Addr::new(
                self.address[0],
                self.address[1],
                self.address[2],
                self.address[3],
            )),
            6 => IpAddr::V6(Ipv6Addr::from(self.address)),
            _ => return Err(-2),
        };
        if self.port == 0 || ip.is_unspecified() || ip.is_multicast() {
            return Err(-2);
        }
        Ok(SocketAddr::new(ip, self.port))
    }
}

impl From<SocketAddr> for OpenClawRTCAddress {
    fn from(value: SocketAddr) -> Self {
        let mut result = Self {
            port: value.port(),
            ..Self::default()
        };
        match value.ip() {
            IpAddr::V4(ip) => {
                result.family = 4;
                result.address[..4].copy_from_slice(&ip.octets());
            }
            IpAddr::V6(ip) => {
                result.family = 6;
                result.address = ip.octets();
            }
        }
        result
    }
}

#[repr(C)]
pub struct OpenClawRTCOutput {
    kind: u32,
    bytes: *const u8,
    length: usize,
    source: OpenClawRTCAddress,
    destination: OpenClawRTCAddress,
    time: u64,
}

pub struct OpenClawRTC {
    rtc: Option<Rtc>,
    pending: Option<SdpPendingOffer>,
    mid: Option<Mid>,
    description: Vec<u8>,
    output_bytes: Vec<u8>,
}

// A panic must not cross the C ABI. A failed engine is discarded, never reused.
unsafe fn operate(
    pointer: *mut OpenClawRTC,
    operation: impl FnOnce(&mut OpenClawRTC) -> Result<(), i32>,
) -> i32 {
    let Some(state) = (unsafe { pointer.as_mut() }) else {
        return -1;
    };
    if state.rtc.is_none() {
        return -1;
    }
    match catch_unwind(AssertUnwindSafe(|| operation(state))) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => {
            state.rtc = None;
            -1
        }
    }
}

unsafe fn input<'a>(bytes: *const u8, length: usize, maximum: usize) -> Result<&'a [u8], i32> {
    if bytes.is_null() || length == 0 || length > maximum {
        return Err(-2);
    }
    Ok(unsafe { std::slice::from_raw_parts(bytes, length) })
}

#[unsafe(no_mangle)]
pub extern "C" fn openclaw_rtc_create() -> *mut OpenClawRTC {
    catch_unwind(|| {
        let rtc = Rtc::builder()
            .clear_codecs()
            .enable_opus(true)
            .build(Instant::now());
        Box::into_raw(Box::new(OpenClawRTC {
            rtc: Some(rtc),
            pending: None,
            mid: None,
            description: Vec::new(),
            output_bytes: Vec::new(),
        }))
    })
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_free(pointer: *mut OpenClawRTC) {
    if !pointer.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { Box::from_raw(pointer) })));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_add_candidate(
    pointer: *mut OpenClawRTC,
    address: OpenClawRTCAddress,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let candidate = Candidate::host(address.socket()?, Protocol::Udp).map_err(|_| -2)?;
            state.rtc.as_mut().ok_or(-1)?.add_local_candidate(candidate);
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_offer(pointer: *mut OpenClawRTC) -> i32 {
    unsafe {
        operate(pointer, |state| {
            if state.pending.is_some() || state.mid.is_some() {
                return Err(-1);
            }
            let mut changes = state.rtc.as_mut().ok_or(-1)?.sdp_api();
            state.mid =
                Some(changes.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None));
            let (offer, pending) = changes.apply().ok_or(-1)?;
            state.pending = Some(pending);
            state.description = offer.to_sdp_string().into_bytes();
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_description(
    pointer: *const OpenClawRTC,
    length: *mut usize,
) -> *const u8 {
    let (Some(state), Some(length)) = (unsafe { pointer.as_ref() }, unsafe { length.as_mut() })
    else {
        return ptr::null();
    };
    *length = state.description.len();
    state.description.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_answer(
    pointer: *mut OpenClawRTC,
    bytes: *const u8,
    length: usize,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let text = std::str::from_utf8(input(bytes, length, 65_536)?).map_err(|_| -2)?;
            let answer = SdpAnswer::from_sdp_string(text).map_err(|_| -2)?;
            let pending = state.pending.take().ok_or(-1)?;
            state
                .rtc
                .as_mut()
                .ok_or(-1)?
                .sdp_api()
                .accept_answer(pending, answer)
                .map_err(|_| -1)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_receive(
    pointer: *mut OpenClawRTC,
    source: OpenClawRTCAddress,
    destination: OpenClawRTCAddress,
    bytes: *const u8,
    length: usize,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let bytes = input(bytes, length, 2_000)?;
            let Ok(receive) = Receive::new(
                Protocol::Udp,
                source.socket()?,
                destination.socket()?,
                bytes,
            ) else {
                return Ok(()); // Unrelated/invalid UDP is not a session failure.
            };
            let rtc = state.rtc.as_mut().ok_or(-1)?;
            let input = Input::Receive(Instant::now(), receive);
            if rtc.accepts(&input) {
                rtc.handle_input(input).map_err(|_| -1)?;
            }
            Ok(())
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_send_opus(
    pointer: *mut OpenClawRTC,
    bytes: *const u8,
    length: usize,
    timestamp: u64,
) -> i32 {
    unsafe {
        operate(pointer, |state| {
            let bytes = input(bytes, length, 1_275)?;
            let rtc = state.rtc.as_mut().ok_or(-1)?;
            if !rtc.is_connected() {
                return Ok(());
            }
            let writer = rtc.writer(state.mid.ok_or(-1)?).ok_or(-1)?;
            let pt = writer
                .payload_params()
                .find(|p| p.spec().codec == Codec::Opus)
                .ok_or(-1)?
                .pt();
            writer
                .write(
                    pt,
                    Instant::now(),
                    MediaTime::new(timestamp, Frequency::FORTY_EIGHT_KHZ),
                    bytes,
                )
                .map_err(|_| -1)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_timeout(pointer: *mut OpenClawRTC) -> i32 {
    unsafe {
        operate(pointer, |state| {
            state
                .rtc
                .as_mut()
                .ok_or(-1)?
                .handle_input(Input::Timeout(Instant::now()))
                .map_err(|_| -1)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn openclaw_rtc_poll(
    pointer: *mut OpenClawRTC,
    output: *mut OpenClawRTCOutput,
) -> i32 {
    let Some(output) = (unsafe { output.as_mut() }) else {
        return -2;
    };
    unsafe {
        operate(pointer, |state| {
            *output = OpenClawRTCOutput {
                kind: 0,
                bytes: ptr::null(),
                length: 0,
                source: OpenClawRTCAddress::default(),
                destination: OpenClawRTCAddress::default(),
                time: 0,
            };
            loop {
                match state
                    .rtc
                    .as_mut()
                    .ok_or(-1)?
                    .poll_output()
                    .map_err(|_| -1)?
                {
                    Output::Timeout(deadline) => {
                        output.time = deadline
                            .saturating_duration_since(Instant::now())
                            .as_millis()
                            .min(60_000) as u64;
                        return Ok(());
                    }
                    Output::Transmit(packet) => {
                        output.kind = 1;
                        output.source = packet.source.into();
                        output.destination = packet.destination.into();
                        state.output_bytes.clear();
                        state.output_bytes.extend_from_slice(&packet.contents);
                    }
                    Output::Event(Event::Connected) => output.kind = 2,
                    Output::Event(Event::MediaData(media))
                        if media.params.spec().codec == Codec::Opus =>
                    {
                        output.kind = 3;
                        output.time = media.time.rebase(Frequency::FORTY_EIGHT_KHZ).numer();
                        state.output_bytes.clear();
                        state.output_bytes.extend_from_slice(&media.data);
                    }
                    Output::Event(Event::IceConnectionStateChange(
                        IceConnectionState::Disconnected,
                    )) => output.kind = 4,
                    Output::Event(Event::Closed) => output.kind = 5,
                    _ => continue,
                }
                if output.kind == 1 || output.kind == 3 {
                    output.bytes = state.output_bytes.as_ptr();
                    output.length = state.output_bytes.len();
                }
                return Ok(());
            }
        })
    }
}
