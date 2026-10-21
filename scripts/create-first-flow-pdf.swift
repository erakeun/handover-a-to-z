// Generates a fully synthetic two-page PDF using only system CoreText fonts.
// No existing document, network service, account or user data is read.
import Foundation
import CoreGraphics
import CoreText

guard CommandLine.arguments.count == 2 else {
  fatalError("Usage: swift create-first-flow-pdf.swift output.pdf")
}
let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let pageWidth: CGFloat = 595.28
let pageHeight: CGFloat = 841.89
var mediaBox = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
let metadata: [CFString: Any] = [
  kCGPDFContextTitle: "완전가상 검토자료 — 처음 한 건 따라 하기",
  kCGPDFContextAuthor: "Synthetic Review Fixture",
  kCGPDFContextCreator: "Handover A to Z synthetic fixture generator"
]
guard let context = CGContext(outputURL as CFURL, mediaBox: &mediaBox, metadata as CFDictionary) else {
  fatalError("Cannot create synthetic PDF")
}
let ink = CGColor(gray: 0.12, alpha: 1)
let muted = CGColor(gray: 0.35, alpha: 1)
let blue = CGColor(red: 0.10, green: 0.26, blue: 0.41, alpha: 1)
let pale = CGColor(red: 0.94, green: 0.97, blue: 0.99, alpha: 1)

func text(_ value: String, x: CGFloat = 46, top: CGFloat, width: CGFloat = 503, height: CGFloat = 40,
          size: CGFloat = 11, color: CGColor = ink, bold: Bool = false) {
  // Arial Unicode embeds a TrueType subset and ToUnicode mapping. Apple's CFF
  // Korean font relies on external Adobe Korea CMaps, which the app blocks.
  let name = "ArialUnicodeMS"
  let font = CTFontCreateWithName(name as CFString, size, nil)
  let attributes: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
  ]
  let string = NSAttributedString(string: value, attributes: attributes)
  let setter = CTFramesetterCreateWithAttributedString(string)
  let rect = CGRect(x: x, y: pageHeight - top - height, width: width, height: height)
  let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
  context.textMatrix = .identity
  CTFrameDraw(frame, context)
}

func rect(x: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat, fill: CGColor? = nil) {
  let box = CGRect(x: x, y: pageHeight - top - height, width: width, height: height)
  if let fill = fill { context.setFillColor(fill); context.fill(box) }
  context.setStrokeColor(CGColor(gray: 0.7, alpha: 1))
  context.setLineWidth(0.6)
  context.stroke(box)
}

func header(_ number: Int, _ title: String) {
  text("완전가상 · 검토 연습용", top: 38, height: 24, size: 12, color: blue, bold: true)
  text(title, top: 72, height: 40, size: 23, bold: true)
  text("실제 기관의 자료·규칙·허가 절차가 아닙니다. 이 문서는 검토를 위해 직접 만들었습니다.",
       top: 119, height: 40, size: 10.5, color: muted)
  text("가상 자료 | SYNTHETIC REVIEW ONLY | \(number) / 2", top: 790, height: 22, size: 9, color: muted)
}

context.beginPDFPage(nil)
header(1, "촬영 요청 한 건의 다음 행동 찾기")
text("가상 상황", top: 176, height: 24, size: 15, bold: true)
text("촬영 요청 A에는 구역 이름 ‘파랑방’이 있지만 희망 날짜는 비어 있습니다.\n이 연습에서 접수는 최종 허가와 다릅니다.", top: 207, height: 58, size: 12)
text("가상 조건표", top: 284, height: 24, size: 15, bold: true)
let left: CGFloat = 46
let middle: CGFloat = 278
let right: CGFloat = 549
let rows: [(String, String)] = [
  ("조건", "다음 행동"),
  ("날짜와 구역 이름이 모두 있음", "가상 검토 목록에 추가"),
  ("날짜가 없음", "요청자 역할에게 날짜를 질문"),
  ("구역 이름이 없음", "구역 이름 확인까지 판단 보류"),
]
for (index, row) in rows.enumerated() {
  let top: CGFloat = 321 + CGFloat(index) * 48
  rect(x: left, top: top, width: middle - left, height: 48, fill: index == 0 ? pale : nil)
  rect(x: middle, top: top, width: right - middle, height: 48, fill: index == 0 ? pale : nil)
  text(row.0, x: left + 10, top: top + 13, width: middle - left - 20, height: 28, size: 11, bold: index == 0)
  text(row.1, x: middle + 10, top: top + 13, width: right - middle - 20, height: 28, size: 11, bold: index == 0)
}
text("조건이 겹치거나 표에 없으면", top: 542, height: 24, size: 15, bold: true)
text("두 항목이 모두 없으면 둘 다 확인합니다.\n표에 없는 조건은 임의로 승인하지 않고 모르는 점을 남깁니다.", top: 576, height: 60, size: 12)
text("검토해 볼 행동", top: 663, height: 24, size: 15, bold: true)
text("요청 A의 다음 행동을 고른 뒤, 진행건 화면으로 돌아가 보세요.\n외운 순서가 아니라 필요한 조건을 원문에서 찾을 수 있는지 살펴봅니다.", top: 695, height: 56, size: 11.5)
context.endPDFPage()

context.beginPDFPage(nil)
header(2, "날짜·원문·권한을 구분하기")
text("날짜 표현은 서로 다릅니다", top: 174, height: 26, size: 15, bold: true)
text("월초 요청 목록 확인: 정확한 날짜 미확정\n월말 미완료 요청 확인: 정확한 날짜 미확정\n매월 말일 연습 기록: 그 달의 마지막 날짜로 확정", top: 210, height: 88, size: 12)
rect(x: 46, top: 324, width: 503, height: 143, fill: pale)
text("뜻이 정해지지 않은 원문 메모", x: 60, top: 338, width: 475, height: 26, size: 14, bold: true)
text("노란 표시 ? 먼저 담당 확인", x: 60, top: 379, width: 475, height: 28, size: 14)
text("이 가상 메모는 뜻이 불명확합니다. 원문을 남기고 확인할 점으로 표시합니다.\n내용을 지우거나 실행 단계로 추측하지 않습니다.", x: 60, top: 418, width: 475, height: 40, size: 10.5)
text("자료함이 열리지 않을 때", top: 509, height: 24, size: 15, bold: true)
text("본인 계정으로 열리는지 확인합니다.\n권한이 없으면 접근 담당 역할에게 필요한 자료 이름을 알려줍니다.\n비밀번호를 이 문서에 적거나 다른 사람에게 받지 않습니다.", top: 544, height: 87, size: 12)
text("현재 진행 상태도 확인 전에는 모릅니다", top: 658, height: 26, size: 15, bold: true)
text("자료함 접근 확인을 했는지는 아직 모르는 가상 상황입니다.\n이 상태를 ‘시작 전’이나 ‘완료’로 바꾸지 말고 미확인으로 두세요.", top: 695, height: 56, size: 11.5)
context.endPDFPage()
context.closePDF()
print("Created fully synthetic two-page PDF")
