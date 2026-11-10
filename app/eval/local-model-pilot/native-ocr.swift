import Foundation
import Vision

let args = CommandLine.arguments.dropFirst()
if args.first == "traditional" {
    while let line = readLine() {
        let text = try JSONDecoder().decode(String.self, from: Data(line.utf8))
        let converted = text.applyingTransform(StringTransform("Simplified-Traditional"), reverse: false) ?? text
        let bytes = try JSONEncoder().encode(converted)
        print(String(decoding: bytes, as: UTF8.self))
    }
} else {
    for name in args {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hant", "en-US"]
        request.usesLanguageCorrection = false
        let start = Date()
        let file = URL(fileURLWithPath: name)
        try VNImageRequestHandler(url: file).perform([request])
        let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            let box = observation.boundingBox
            return ["text": text, "x": box.minX, "y": box.minY, "w": box.width, "h": box.height]
        }
        let report: [String: Any] = ["image": file.lastPathComponent, "seconds": Date().timeIntervalSince(start),
                                    "visionRevision": request.revision, "lines": lines]
        let bytes = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(decoding: bytes, as: UTF8.self))
    }
}
