# Native Watch WebRTC

This module exposes a small C ABI over pinned `str0m` 0.23.1. It does not open
sockets: `WatchRealtimeTransport` owns UDP through Network.framework, and
`WatchRealtimeAudioIO` owns capture, native Opus conversion and playback.
The Gateway owns provider credentials, tools and transcripts through
`gateway-control-v1`; this module has no provider data channel.

## Build prerequisites

Install Xcode with the watchOS SDK and select it with `DEVELOPER_DIR` or the
normal Xcode command-line-tool setting. The device and simulator slices below
were compiled with the watchOS 27 SDK. The application deployment target remains
watchOS 11; older devices use the `arm64_32` slice. The newer `arm64` Watch ABI
starts at watchOS 26.

Install Rust with the official [rustup installer](https://rustup.rs/), then install
the exact toolchain used by the module:

```sh
rustup toolchain install nightly-2026-08-31 --profile minimal --component rust-src
```

The pinned nightly is required because Rust classifies `arm64_32` Watch and Intel
Watch Simulator as Tier 3; their standard libraries must be built from source.
`build.sh` uses the same pinned compiler for every slice and never installs or
changes a global toolchain. It honors the standard `CARGO_HOME`, `RUSTUP_HOME`
and `DEVELOPER_DIR` variables, so task-local installations work too.

Run from the repository root; put output in a build directory, not source control:

```sh
apps/shared/OpenClawWatchRTC/build.sh watchos /tmp/watch-rtc-device arm64 arm64_32
apps/shared/OpenClawWatchRTC/build.sh watchsimulator /tmp/watch-rtc-simulator arm64 x86_64
```

Each command writes `libopenclaw_watch_rtc.a` and its Cargo build cache to the
chosen output directory. A native macOS proof can use `macosx` with `arm64` or
`x86_64`; macOS execution does not verify Watch radio or background behavior.

| SDK | Xcode architecture | Rust target |
| --- | --- | --- |
| watchos | arm64 | aarch64-apple-watchos |
| watchos | arm64_32 | arm64_32-apple-watchos |
| watchsimulator | arm64 | aarch64-apple-watchos-sim |
| watchsimulator | x86_64 | x86_64-apple-watchos-sim |

Add `include/` to the Swift import/header search path and the selected output
directory to the library search path. Link `libopenclaw_watch_rtc.a`, Security,
Network and AVFAudio. Device and simulator outputs must stay in separate
directories; they are different platforms even when both contain `arm64`.

The `rust-crypto` feature still uses AWS-LC for DTLS and certificate generation.
On `arm64_32`, `AWS_LC_SYS_NO_ASM=1` selects its supported portable implementation
and Release optimization level 2 avoids incompatible AArch64/ILP32 limb code.
The script uses the documented CC builder; it does not patch dependencies or
suppress compiler errors. Other slices retain assembly. Cargo.lock fixes all
transitive versions.

## Ownership and limits

Every native RTC mutation must be followed by polling until the next timeout.
`WatchRealtimeTransport` enforces this on one serial queue. C byte pointers are
borrowed until the next bridge call and are copied before crossing the queue.
The transport advertises real local addresses and a reserved UDP port, and binds
outbound candidate flows to that port. It does not add an external STUN service,
TURN relay, TCP media fallback or BSD socket path.

Start and asynchronously activate the duplex audio session before opening any
low-level Watch connection. Watch audio uses `playAndRecord`, `voiceChat` and the
default route-sharing policy. Long-form routing is playback-only. The hardware
capture rate is read after activation and resampled to mono 48 kHz; outgoing Opus
frames are 20 ms. Watch input taps can deliver larger batches.

Await `WatchRealtimeMediaSession.stop()` before starting a replacement. The
process-global audio lease stays owned until an uncancellable activation callback
has drained. Permission denial, interruption and media-service reset end visibly.
Network reconnection belongs to the call controller, not the media queues.

Watch Simulator permits low-level networking that a device may reject. Native
provider interoperability and cross-compilation do not establish speaker routing,
wrist-down operation, Wi-Fi/cellular handoff, battery life or long-call reliability.
See [Apple TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos).

Third-party acknowledgements are in `apps/ios/Resources/Licenses/str0m.txt`, shared
by the phone and Watch bundles. Dependency or toolchain updates require auditing
both Cargo package notices and the Rust standard-library copyright notices.
