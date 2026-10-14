import SwiftUI

// JSON must preserve ASCII quotes, punctuation and whitespace exactly on both platforms.
#if os(iOS)
  import UIKit
  struct JSONSourceEditor: UIViewRepresentable {
    @Binding var text: String
    var accessibilityTitle = String(localized: "角色卡或设定集 JSON")
    var identifier = "import-json"
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextView {
      let view = UITextView()
      view.delegate = context.coordinator
      view.font = .preferredFont(forTextStyle: .body)
      view.adjustsFontForContentSizeCategory = true
      view.backgroundColor = .clear
      view.smartQuotesType = .no
      view.smartDashesType = .no
      view.autocorrectionType = .no
      view.autocapitalizationType = .none
      view.accessibilityLabel = accessibilityTitle
      view.accessibilityIdentifier = identifier
      return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
      context.coordinator.parent = self
      if view.text != text { view.text = text }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
      var parent: JSONSourceEditor
      init(_ parent: JSONSourceEditor) { self.parent = parent }
      func textViewDidChange(_ view: UITextView) { parent.text = view.text }
    }
  }
#else
  import AppKit
  struct JSONSourceEditor: NSViewRepresentable {
    @Binding var text: String
    var accessibilityTitle = String(localized: "角色卡或设定集 JSON")
    var identifier = "import-json"
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
      let scroll = NSTextView.scrollableTextView()
      let view = scroll.documentView as! NSTextView
      scroll.drawsBackground = false
      view.drawsBackground = false
      view.textColor = .labelColor
      view.delegate = context.coordinator
      view.font = .systemFont(ofSize: NSFont.systemFontSize)
      view.isRichText = false
      view.isAutomaticQuoteSubstitutionEnabled = false
      view.isAutomaticDashSubstitutionEnabled = false
      view.isAutomaticTextReplacementEnabled = false
      view.isAutomaticSpellingCorrectionEnabled = false
      view.setAccessibilityLabel(accessibilityTitle)
      view.setAccessibilityIdentifier(identifier)
      return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
      context.coordinator.parent = self
      let view = scroll.documentView as! NSTextView
      if view.string != text { view.string = text }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
      var parent: JSONSourceEditor
      init(_ parent: JSONSourceEditor) { self.parent = parent }
      func textDidChange(_ notification: Notification) {
        if let view = notification.object as? NSTextView { parent.text = view.string }
      }
    }
  }
#endif
