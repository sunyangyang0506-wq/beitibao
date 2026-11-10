import Foundation
import Vision

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])

let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
let answerHeading = #"^.{0,24}(?:(?:参考|试题|真题)答案(?:(?:及|与)?(?:解析|评分(?:标准|参考)))?|答案(?:及|与)(?:解析|评分(?:标准|参考))|评分标准|answer\s*key|suggested\s*answers)(?:$|[：:（(])"#
let answerHeadingDetected = lines.contains { line in
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.range(of: answerHeading, options: [.regularExpression, .caseInsensitive]) != nil
}
var report: [String: Any] = [
    "lines": lines.count,
    "characters": lines.joined().count,
    "answerHeadingDetected": answerHeadingDetected
]
let pageLabel = try NSRegularExpression(pattern: #"(?:第\s*)?([0-9]{1,2})\s*[-—]?\s*(?:页)?\s*[（(]\s*共\s*([0-9]{1,2})\s*页"#)
if let label = lines.reversed().compactMap({ line -> [Int]? in
    guard let match = pageLabel.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
    return (1...2).compactMap { Range(match.range(at: $0), in: line).flatMap { Int(line[$0]) } }
}).first, label.count == 2 {
    report["printedPage"] = label[0]
    report["printedTotal"] = label[1]
}
let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
