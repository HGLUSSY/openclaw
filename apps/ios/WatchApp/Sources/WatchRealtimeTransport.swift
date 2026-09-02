import Darwin
import Foundation
import Network
import OpenClawWatchRTC

enum WatchRealtimeMediaEvent: Sendable {
    case connected
    case audio(Data, timestamp: UInt64)
    case ended(WatchRealtimeMediaFailure)
}

struct WatchRealtimeMediaFailure: LocalizedError, Sendable {
    enum Kind: Sendable { case network, audio, sessionEnded, protocolError }
    let kind: Kind
    let message: String
    var errorDescription: String? {
        self.message
    }
}

enum WatchRealtimeMediaError: LocalizedError {
    case unavailable(String)
    var errorDescription: String? {
        switch self {
        case let .unavailable(message): message
        }
    }
}

/// The native engine, timer and Network callbacks have one serial queue owner.
final class WatchRealtimeTransport: @unchecked Sendable {
    private struct Route: Hashable {
        let source: NWEndpoint
        let destination: NWEndpoint
    }

    private let queue = DispatchQueue(label: "ai.openclaw.watch.realtime.media", qos: .userInitiated)
    private let onEvent: @Sendable (WatchRealtimeMediaEvent) -> Void
    private let cancellationLock = NSLock()
    private var cancelled = false
    private var started = false
    private var rtc: OpaquePointer?
    private var listener: NWListener?
    private var timer: DispatchSourceTimer?
    private var connections: [Route: NWConnection] = [:]
    private var failedRoutes: Set<Route> = []
    private var activeRoute: Route?
    private var generation: UInt64 = 0
    private var offerContinuation: CheckedContinuation<String, Error>?

    init(onEvent: @escaping @Sendable (WatchRealtimeMediaEvent) -> Void) {
        self.onEvent = onEvent
    }

    deinit {
        self.timer?.cancel()
        self.listener?.cancel()
        self.connections.values.forEach { $0.cancel() }
        if let rtc { openclaw_rtc_free(rtc) }
    }

    func makeOffer() async throws -> String {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.queue.async { self.begin(continuation) }
            }
        } onCancel: { self.cancel() }
    }

    func applyAnswer(_ answer: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.queue.async {
                do {
                    let data = Data(answer.utf8)
                    try data.withUnsafeBytes { bytes in
                        try self.mutate { openclaw_rtc_answer(
                            $0,
                            bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                            bytes.count) }
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error)
                    self.fail(error)
                }
            }
        }
    }

    func sendOpus(_ data: Data, timestamp: UInt64) {
        self.queue.async {
            guard self.rtc != nil else { return }
            do {
                try data.withUnsafeBytes { bytes in
                    try self.mutate { openclaw_rtc_send_opus(
                        $0,
                        bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        bytes.count,
                        timestamp) }
                }
            } catch { self.fail(error) }
        }
    }

    func cancel() {
        // Cancellation can arrive before begin is enqueued. A stopped session is never reused.
        self.cancellationLock.withLock { self.cancelled = true }
        self.queue.async { self.tearDown() }
    }

    func stop() async {
        self.cancellationLock.withLock { self.cancelled = true }
        await withCheckedContinuation { continuation in
            self.queue.async {
                self.tearDown()
                continuation.resume()
            }
        }
    }

    private func begin(_ continuation: CheckedContinuation<String, Error>) {
        guard !self.cancellationLock.withLock({ self.cancelled }) else {
            continuation.resume(throwing: CancellationError())
            return
        }
        guard !self.started else {
            continuation.resume(throwing: WatchRealtimeMediaError.unavailable("Voice is already connecting."))
            return
        }
        self.started = true
        self.generation &+= 1
        let generation = self.generation
        self.offerContinuation = continuation
        guard let rtc = openclaw_rtc_create()
        else { self.fail(WatchRealtimeMediaError.unavailable("Unable to initialize secure voice."))
            return
        }
        self.rtc = rtc
        do {
            try self.drain()
            let parameters = NWParameters.udp
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters, on: .any)
            self.listener = listener
            // ICE checks originate on the explicit candidate flows below. The listener only
            // reserves their shared local port; unsolicited peers do not own a media route.
            listener.newConnectionHandler = { connection in connection.cancel() }
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self, let listener, self.generation == generation else { return }
                switch state {
                case .ready:
                    do {
                        guard let port = listener.port
                        else { throw WatchRealtimeMediaError.unavailable("Voice has no local network port.") }
                        let addresses = try Self.localAddresses(port: port)
                        guard !addresses.isEmpty
                        else {
                            throw WatchRealtimeMediaError.unavailable("No network connection is available for voice.")
                        }
                        for address in addresses {
                            let native = try Self.nativeAddress(address)
                            try self.mutate { openclaw_rtc_add_candidate($0, native) }
                        }
                        try self.mutate { openclaw_rtc_offer($0) }
                        var length = 0
                        guard let rtc = self.rtc,
                              let bytes = openclaw_rtc_description(rtc, &length),
                              let offer = String(data: Data(bytes: bytes, count: length), encoding: .utf8)
                        else { throw WatchRealtimeMediaError.unavailable("Voice negotiation could not be created.") }
                        let pending = self.offerContinuation
                        self.offerContinuation = nil
                        pending?.resume(returning: offer)
                    } catch { self.fail(error) }
                case let .failed(error), let .waiting(error):
                    self.fail(WatchRealtimeMediaFailure(kind: .network, message: error.localizedDescription))
                default: break
                }
            }
            listener.start(queue: self.queue)
        } catch { self.fail(error) }
    }

    private func mutate(_ operation: (OpaquePointer) -> Int32) throws {
        guard let rtc, operation(rtc) == 0 else {
            throw WatchRealtimeMediaError.unavailable("The secure voice connection failed.")
        }
        try self.drain()
    }

    private func drain() throws {
        guard let rtc else { return }
        while true {
            var output = OpenClawRTCOutput()
            guard openclaw_rtc_poll(rtc, &output) == 0 else {
                throw WatchRealtimeMediaError.unavailable("The secure voice connection failed.")
            }
            switch output.kind {
            case 0:
                self.scheduleTimeout(milliseconds: output.time)
                return
            case 1:
                guard let bytes = output.bytes else { continue }
                let route = try Route(
                    source: Self.endpoint(output.source),
                    destination: Self.endpoint(output.destination))
                let data = Data(bytes: bytes, count: output.length)
                if data.first.map({ $0 >= 128 && $0 < 192 }) == true { self.activeRoute = route }
                self.transmit(data, route: route)
            case 2: self.onEvent(.connected)
            case 3:
                guard let bytes = output.bytes else { continue }
                self.onEvent(.audio(Data(bytes: bytes, count: output.length), timestamp: output.time))
            case 4: throw WatchRealtimeMediaFailure(kind: .network, message: "Voice lost its network connection.")
            case 5: throw WatchRealtimeMediaFailure(kind: .sessionEnded, message: "Voice ended.")
            default: break
            }
        }
    }

    private func scheduleTimeout(milliseconds: UInt64) {
        if let timer = self.timer {
            timer.schedule(deadline: .now() + .milliseconds(Int(max(1, milliseconds))))
            return
        }
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        let generation = self.generation
        timer.schedule(deadline: .now() + .milliseconds(Int(max(1, milliseconds))))
        timer.setEventHandler { [weak self] in
            guard let self, self.generation == generation else { return }
            do {
                try self.mutate { openclaw_rtc_timeout($0) }
            } catch {
                self.fail(error)
            }
        }
        self.timer = timer
        timer.resume()
    }

    private func transmit(_ data: Data, route: Route) {
        guard !self.failedRoutes.contains(route) else { return }
        let generation = self.generation
        let connection: NWConnection
        if let existing = self.connections[route] {
            connection = existing
        } else {
            let parameters = NWParameters.udp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = route.source
            connection = NWConnection(to: route.destination, using: parameters)
            self.connections[route] = connection
            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard let self, let connection, self.generation == generation else { return }
                switch state {
                case .ready:
                    guard connection.currentPath?.localEndpoint == route.source else {
                        self.routeFailed(route, message: "Voice could not retain its network address.")
                        return
                    }
                    self.receive(connection, route: route, generation: generation)
                case let .failed(error), let .waiting(error): self.routeFailed(
                        route,
                        message: error.localizedDescription)
                default: break
                }
            }
            connection.start(queue: self.queue)
        }
        let context = NWConnection.ContentContext(identifier: "voice", expiration: 1000)
        connection.send(content: data, contentContext: context, completion: .contentProcessed { [weak self] error in
            guard let self, self.generation == generation, let error else { return }
            self.routeFailed(route, message: error.localizedDescription)
        })
    }

    private func receive(_ connection: NWConnection, route: Route, generation: UInt64) {
        connection.receiveMessage { [weak self, weak connection] data, _, _, error in
            guard let self, let connection, self.generation == generation else { return }
            if let error { self.routeFailed(route, message: error.localizedDescription)
                return
            }
            if let data, !data.isEmpty, data.count <= 2000 {
                do {
                    let source = try Self.nativeAddress(route.destination)
                    let destination = try Self.nativeAddress(route.source)
                    try data.withUnsafeBytes { bytes in
                        try self.mutate { openclaw_rtc_receive(
                            $0,
                            source,
                            destination,
                            bytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                            bytes.count) }
                    }
                } catch { self.fail(error)
                    return
                }
            }
            self.receive(connection, route: route, generation: generation)
        }
    }

    private func routeFailed(_ route: Route, message: String) {
        self.failedRoutes.insert(route)
        self.connections.removeValue(forKey: route)?.cancel()
        if self.activeRoute == route { self.fail(WatchRealtimeMediaFailure(kind: .network, message: message)) }
    }

    private func fail(_ error: Error) {
        let failure = error as? WatchRealtimeMediaFailure ??
            WatchRealtimeMediaFailure(kind: .protocolError, message: error.localizedDescription)
        self.cancellationLock.withLock { self.cancelled = true }
        self.tearDown(error: failure)
        self.onEvent(.ended(failure))
    }

    private func tearDown(error: Error = CancellationError()) {
        self.generation &+= 1
        self.timer?.cancel()
        self.timer = nil
        self.listener?.cancel()
        self.listener = nil
        self.connections.values.forEach { $0.cancel() }
        self.connections.removeAll()
        self.failedRoutes.removeAll()
        self.activeRoute = nil
        if let rtc { openclaw_rtc_free(rtc) }
        self.rtc = nil
        let pending = self.offerContinuation
        self.offerContinuation = nil
        pending?.resume(throwing: error)
    }

    private static func nativeAddress(_ endpoint: NWEndpoint) throws -> OpenClawRTCAddress {
        guard case let .hostPort(host, port) = endpoint else {
            throw WatchRealtimeMediaError.unavailable("Voice received an invalid network address.")
        }
        let bytes: Data
        var result = OpenClawRTCAddress()
        switch host {
        case let .ipv4(address): bytes = address.rawValue
            result.family = 4
        case let .ipv6(address): bytes = address.rawValue
            result.family = 6
        default: throw WatchRealtimeMediaError.unavailable("Voice requires a resolved network address.")
        }
        result.port = port.rawValue
        withUnsafeMutableBytes(of: &result.address) { $0.copyBytes(from: bytes) }
        return result
    }

    private static func endpoint(_ address: OpenClawRTCAddress) throws -> NWEndpoint {
        var address = address
        let data = withUnsafeBytes(of: &address.address) { Data($0.prefix(address.family == 4 ? 4 : 16)) }
        let host: NWEndpoint.Host
        if address.family == 4, let ip = IPv4Address(data) {
            host = .ipv4(ip)
        } else if address.family == 6, let ip = IPv6Address(data) {
            host = .ipv6(ip)
        } else {
            throw WatchRealtimeMediaError.unavailable("Voice received an invalid network address.")
        }
        guard let port = NWEndpoint.Port(rawValue: address.port) else {
            throw WatchRealtimeMediaError.unavailable("Voice received an invalid network port.")
        }
        return .hostPort(host: host, port: port)
    }

    private static func localAddresses(port: NWEndpoint.Port) throws -> [NWEndpoint] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else {
            throw WatchRealtimeMediaError.unavailable("Voice cannot read the active network addresses.")
        }
        defer { if let first { freeifaddrs(first) } }
        var endpoints: [NWEndpoint] = []
        var next = first
        while let interface = next?.pointee {
            next = interface.ifa_next
            guard interface.ifa_flags & UInt32(IFF_UP | IFF_RUNNING) == UInt32(IFF_UP | IFF_RUNNING),
                  interface.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
                  let address = interface.ifa_addr else { continue }
            let host: NWEndpoint.Host
            switch Int32(address.pointee.sa_family) {
            case AF_INET:
                var ip = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
                guard let parsed = IPv4Address(Data(bytes: &ip, count: 4)), !parsed.isLinkLocal else { continue }
                host = .ipv4(parsed)
            case AF_INET6:
                var ip = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
                guard let parsed = IPv6Address(Data(bytes: &ip, count: 16)), !parsed.isLinkLocal else { continue }
                host = .ipv6(parsed)
            default: continue
            }
            let endpoint = NWEndpoint.hostPort(host: host, port: port)
            if !endpoints.contains(endpoint) { endpoints.append(endpoint) }
        }
        return endpoints
    }
}
