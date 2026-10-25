// On-device dictation on macOS 26+, via SpeechAnalyzer + DictationTranscriber.
//
// SpeechAnalyzer is a Swift-only async API, so it can't be reached through
// objc2 like the older SFSpeechRecognizer path in dictation.rs. build.rs
// compiles this file into a static library and Rust drives it through the
// four @_cdecl entry points below. Everything flows back through a single C
// callback; the Rust side turns those into `dictation://*` events.
//
// Compared to SFSpeechRecognizer this is the model macOS 26's own dictation
// uses: markedly better accuracy, punctuation, and it is built for long-form
// audio — it doesn't give up after a pause or cap the session length.

import AVFoundation
import Foundation
import Speech

public typealias AgdCallback = @convention(c) (Int32, UnsafePointer<CChar>?, Float) -> Void

// Event kinds — keep in sync with `analyzer` in dictation.rs.
private let EV_PARTIAL: Int32 = 0  // text: everything heard so far
private let EV_FINAL: Int32 = 1  // text: the finished phrase; session over
private let EV_ERROR: Int32 = 2  // text: message; session over
private let EV_LEVEL: Int32 = 3  // level: mic loudness, 0...1
private let EV_LISTENING: Int32 = 4  // mic is live
private let EV_STATUS: Int32 = 5  // text: progress note, e.g. model download

nonisolated(unsafe) private var callback: AgdCallback?

private func emit(_ kind: Int32, _ text: String? = nil, level: Float = 0) {
    guard let cb = callback else { return }
    if let text {
        text.withCString { cb(kind, $0, level) }
    } else {
        cb(kind, nil, level)
    }
}

/// Join two transcript fragments with exactly one space between them.
private func joined(_ left: String, _ right: String) -> String {
    let l = left.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    let r = right.trimmingCharacters(in: .whitespacesAndNewlines)
    if l.isEmpty { return r }
    if r.isEmpty { return l }
    return l + " " + r
}

private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/// Whether this Mac can dictate with SpeechAnalyzer in the user's language.
/// Blocks briefly; Rust caches the answer.
@_cdecl("agd_available")
public func agd_available() -> Bool {
    guard #available(macOS 26.0, *) else { return false }
    let ok = Box(false)
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        ok.value = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current) != nil
        done.signal()
    }
    _ = done.wait(timeout: .now() + 3)
    return ok.value
}

@_cdecl("agd_start")
public func agd_start(_ cb: AgdCallback) {
    callback = cb
    guard #available(macOS 26.0, *) else {
        emit(EV_ERROR, "Dictation needs macOS 26.")
        return
    }
    Task { @MainActor in
        // Idempotent: a held key that repeats can't stack sessions.
        if Recorder.current != nil { return }
        let recorder = Recorder()
        Recorder.current = recorder
        await recorder.run()
    }
}

/// Stop listening and deliver the finished phrase as EV_FINAL.
@_cdecl("agd_stop")
public func agd_stop() {
    guard #available(macOS 26.0, *) else { return }
    Task { @MainActor in await Recorder.current?.stop() }
}

/// Abandon the phrase; nothing further is emitted.
@_cdecl("agd_cancel")
public func agd_cancel() {
    guard #available(macOS 26.0, *) else { return }
    Task { @MainActor in
        let recorder = Recorder.current
        Recorder.current = nil
        await recorder?.cancel()
    }
}

private struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@available(macOS 26.0, *)
@MainActor
private final class Recorder {
    static var current: Recorder?
    /// Resolved once per launch — the lookup is async and never changes.
    static var locale: Locale?

    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var reader: Task<Void, Never>?
    private var finalized = ""
    private var volatile = ""
    private var micOpen = false
    private var ready = false
    private var stopRequested = false
    private var stopping = false
    private var cancelled = false

    func run() async {
        do {
            try await start()
        } catch {
            guard !cancelled, Recorder.current === self else { return }
            Recorder.current = nil
            shutMic()
            input?.finish()
            reader?.cancel()
            await analyzer?.cancelAndFinishNow()
            emit(EV_ERROR, error.localizedDescription)
        }
    }

    private func checkCancelled() throws {
        if cancelled { throw CancellationError() }
    }

    private func start() async throws {
        try await authorize()
        try checkCancelled()

        if Recorder.locale == nil {
            Recorder.locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current)
        }
        guard let locale = Recorder.locale else {
            throw Failure("Dictation doesn't support your language.")
        }
        var preset = DictationTranscriber.Preset.progressiveLongDictation
        preset.transcriptionOptions.insert(.punctuation)
        let transcriber = DictationTranscriber(locale: locale, preset: preset)

        let mic = engine.inputNode
        let hardware = mic.outputFormat(forBus: 0)
        guard hardware.channelCount > 0 else {
            throw Failure("No microphone input is available.")
        }
        let format =
            await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber], considering: hardware) ?? hardware
        try checkCancelled()

        // Open the mic before anything slow (model check, analyzer warm-up):
        // people start talking the instant they press, and the stream buffers
        // audio until the analyzer is ready to read it, so no words are lost.
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        input = continuation
        let tap = Tap(from: hardware, to: format, into: continuation)
        mic.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in
            tap.push(buffer)
        }
        engine.prepare()
        try engine.start()
        micOpen = true
        emit(EV_LISTENING)

        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(EV_STATUS, "downloading speech model…")
            try await request.downloadAndInstall()
        }
        try checkCancelled()

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        reader = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    self?.take(String(result.text.characters), final: result.isFinal)
                }
            } catch {
                self?.readerFailed(error)
            }
        }
        try await analyzer.start(inputSequence: stream)
        try checkCancelled()
        ready = true
        if stopRequested { await stop() }
    }

    /// The Speech Recognition consent. Already granted for the older engine
    /// in the same app, so this is normally instant.
    private func authorize() async throws {
        let status = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard status == .authorized else {
            throw Failure(
                "Speech recognition is not allowed. Enable AgentBench under System Settings → Privacy & Security → Speech Recognition."
            )
        }
    }

    /// A volatile result is the current guess at the words still being
    /// spoken and replaces the previous guess; a final one is settled text.
    private func take(_ text: String, final: Bool) {
        guard !cancelled else { return }
        if final {
            finalized = joined(finalized, text)
            volatile = ""
        } else {
            volatile = text
        }
        emit(EV_PARTIAL, joined(finalized, volatile))
    }

    private func readerFailed(_ error: Error) {
        guard !cancelled, !stopping, Recorder.current === self else { return }
        Recorder.current = nil
        shutMic()
        input?.finish()
        emit(EV_ERROR, error.localizedDescription)
    }

    func stop() async {
        // Still starting (a quick tap, or the model downloading): finish
        // starting first, then stop — start() checks this flag at the end.
        guard ready else {
            stopRequested = true
            return
        }
        guard !stopping, !cancelled else { return }
        stopping = true
        shutMic()
        input?.finish()
        // Let the recognizer settle the last words rather than taking the
        // volatile guess as-is.
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await reader?.value
        if Recorder.current === self { Recorder.current = nil }
        guard !cancelled else { return }
        emit(EV_FINAL, joined(finalized, volatile))
    }

    func cancel() async {
        cancelled = true
        shutMic()
        input?.finish()
        reader?.cancel()
        await analyzer?.cancelAndFinishNow()
    }

    private func shutMic() {
        guard micOpen else { return }
        micOpen = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

/// Runs on the audio thread: meters each buffer and hands the analyzer a
/// converted copy (the engine reuses its buffers once the tap returns).
@available(macOS 26.0, *)
private final class Tap: @unchecked Sendable {
    private let converter: AVAudioConverter?
    private let target: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var lastLevel: UInt64 = 0

    init(
        from source: AVAudioFormat, to target: AVAudioFormat,
        into continuation: AsyncStream<AnalyzerInput>.Continuation
    ) {
        self.target = target
        self.continuation = continuation
        converter = source == target ? nil : AVAudioConverter(from: source, to: target)
    }

    func push(_ buffer: AVAudioPCMBuffer) {
        meter(buffer)
        if let out = convert(buffer) {
            continuation.yield(AnalyzerInput(buffer: out))
        }
    }

    private func meter(_ buffer: AVAudioPCMBuffer) {
        // ~30 updates a second is plenty for a meter and keeps IPC quiet.
        let now = DispatchTime.now().uptimeNanoseconds
        guard now - lastLevel >= 33_000_000 else { return }
        lastLevel = now
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += samples[i] * samples[i] }
        let rms = (sum / Float(n)).squareRoot()
        // -55 dB (room tone) ... -10 dB (close, loud speech) → 0 ... 1
        let db = 20 * log10(max(rms, 1e-7))
        emit(EV_LEVEL, level: min(max((db + 55) / 45, 0), 1))
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return copy(buffer) }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return nil
        }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }

    private func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength)
        else { return nil }
        out.frameLength = buffer.frameLength
        let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        for (s, d) in zip(src, dst) {
            if let from = s.mData, let to = d.mData {
                memcpy(to, from, Int(min(s.mDataByteSize, d.mDataByteSize)))
            }
        }
        return out
    }
}
