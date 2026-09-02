import AVFAudio
import Foundation
import Observation
import Synchronization
import Testing
import XCTest
@testable import OpenClawWatchApp

@MainActor
struct WatchRealtimeMediaTests {
    @Test func `invalidated call admission ends before microphone and network startup`() async throws {
        let controller = WatchRealtimeCallController()
        let connection = try WatchVoiceConnection(
            gatewayID: "watch-voice-test",
            websocketURLs: [#require(URL(string: "wss://gateway.invalid"))],
            setupSentAtMs: nil)
        let current = Mutex(true)
        controller.start(connection: connection, isCurrent: { current.withLock { $0 } })
        current.withLock { $0 = false }
        let changed = XCTestExpectation(description: "The queued call notices revoked admission")
        withObservationTracking {
            _ = controller.state
        } onChange: {
            changed.fulfill()
        }

        let result = await XCTWaiter.fulfillment(of: [changed], timeout: 3)
        #expect(result == .completed)
        #expect(controller.state == .failed)
        #expect(controller.errorText != nil)
        await controller.end().value
        #expect(controller.state == .idle)
    }

    @Test(arguments: [false, true])
    func `background startup cancellation keeps its reason without clearing a replacement error`(
        rejectReplacement: Bool) async throws
    {
        let controller = WatchRealtimeCallController()
        let connection = try WatchVoiceConnection(
            gatewayID: "watch-voice-test",
            websocketURLs: [#require(URL(string: "wss://gateway.invalid"))],
            setupSentAtMs: nil)
        controller.start(connection: connection, isCurrent: { true })
        controller.setMuted(true)
        let stopped = try #require(controller.sceneDidEnterBackground())
        #expect(controller.state == .stopping)
        #expect(controller.isMuted == false)
        #expect(controller.errorText?.isEmpty == false)
        if rejectReplacement {
            controller.start(connection: connection, isCurrent: { false })
            #expect(controller.state == .failed)
        }
        let visibleReason = controller.errorText

        await stopped.value
        #expect(controller.state == (rejectReplacement ? .failed : .idle))
        #expect(controller.errorText == visibleReason)
        await controller.end().value
        #expect(controller.state == .idle)
        #expect(controller.errorText == nil)
    }

    @Test func `cancelled and stopped transports cannot begin a network session`() async throws {
        let eventCount = Mutex(0)
        let transport = WatchRealtimeTransport { _ in eventCount.withLock { $0 += 1 } }
        let (gate, continuation) = AsyncStream<Void>.makeStream()
        let request = Task {
            for await _ in gate {}
            return try await transport.makeOffer()
        }
        request.cancel()
        continuation.finish()
        do {
            _ = try await request.value
            Issue.record("Canceled offer unexpectedly connected")
        } catch is CancellationError {}
        await transport.stop()
        do {
            _ = try await transport.makeOffer()
            Issue.record("Stopped transport unexpectedly restarted")
        } catch is CancellationError {}
        #expect(eventCount.withLock { $0 } == 0)
    }

    @Test func `native Opus encodes raw RTP and decodes variable packet durations`() throws {
        let codec = try WatchOpusCodec()
        var packets = 0
        var decodedFrames = 0
        var energy = 0.0
        for index in 0..<20 {
            let pcm = try #require(AVAudioPCMBuffer(pcmFormat: codec.pcmFormat, frameCapacity: 960))
            pcm.frameLength = 960
            let samples = try #require(pcm.floatChannelData)[0]
            for sample in 0..<960 {
                samples[sample] = Float(sin(Double(index * 960 + sample) * 2 * .pi * 440 / 48000) * 0.25)
            }
            guard let packet = try codec.encode(pcm) else { continue }
            let decoded = try codec.decode(packet)
            packets += 1
            decodedFrames += Int(decoded.frameLength)
            let output = try #require(decoded.floatChannelData)[0]
            for sample in 0..<Int(decoded.frameLength) {
                energy += Double(output[sample] * output[sample])
            }
        }
        #expect(packets >= 19)
        #expect(decodedFrames >= 18000)
        #expect(sqrt(energy / Double(max(1, decodedFrames))) > 0.01)

        // The CELT silence fixture is a 20 ms frame. RFC 6716 §3.2.3 permits
        // two equal-sized frames under code 1, independently of our encoder's framing.
        for (packet, frames) in [(Data([0xF8, 0xFF, 0xFE]), 960), (Data([0xF9, 0xFF, 0xFE, 0xFF, 0xFE]), 1920)] {
            let decoder = try WatchOpusCodec()
            var total = 0
            for _ in 0..<20 {
                try total += Int(decoder.decode(packet).frameLength)
            }
            #expect(total >= frames * 19)
        }
    }
}
