#if os(macOS)
  import AppKit
  import SwiftUI

  /// Native text input preserves marked Chinese text: Return submits only after IME composition ends.
  struct MacChatInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var placeholder: String
    var focusRequest: Int
    var onSend: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
      let scroll = NSScrollView()
      scroll.drawsBackground = false
      scroll.hasVerticalScroller = true
      let input = ChatTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 36))
      input.minSize = NSSize(width: 0, height: 36)
      input.maxSize = NSSize(
        width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
      input.delegate = context.coordinator
      input.isRichText = false
      input.drawsBackground = false
      input.font = .preferredFont(forTextStyle: .body)
      input.textColor = NSColor(Color.echo.textPrimary)
      input.insertionPointColor = NSColor(Color.echo.primary)
      input.isVerticallyResizable = true
      input.isHorizontallyResizable = false
      input.textContainer?.widthTracksTextView = true
      input.autoresizingMask = [.width]
      input.textContainerInset = NSSize(width: 0, height: 8)
      input.setAccessibilityIdentifier("chat-input")
      input.setAccessibilityLabel(String(localized: "消息"))
      input.string = text
      scroll.documentView = input
      return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
      context.coordinator.parent = self
      guard let input = scroll.documentView as? ChatTextView else { return }
      if !input.hasMarkedText(), input.string != text {
        context.coordinator.isApplyingModelChange = true
        input.string = text
        input.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        context.coordinator.isApplyingModelChange = false
      }
      input.placeholder = placeholder
      input.needsDisplay = true
      if context.coordinator.lastFocusRequest != focusRequest {
        context.coordinator.lastFocusRequest = focusRequest
        input.requestFocus()
      }
      input.textColor = NSColor(Color.echo.textPrimary)
      input.insertionPointColor = NSColor(Color.echo.primary)
      let coordinator = context.coordinator
      Task { @MainActor in coordinator.updateHeight(input) }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context)
      -> CGSize?
    {
      guard let input = nsView.documentView as? NSTextView,
        let container = input.textContainer, let layout = input.layoutManager
      else { return nil }
      let width = proposal.width ?? 400
      container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
      layout.ensureLayout(for: container)
      return CGSize(
        width: width, height: min(140, max(36, layout.usedRect(for: container).height + 16)))
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, NSTextViewDelegate {
      var lastFocusRequest = 0
      var isApplyingModelChange = false
      var parent: MacChatInput
      init(_ parent: MacChatInput) { self.parent = parent }
      func textDidChange(_ notification: Notification) {
        guard !isApplyingModelChange, let input = notification.object as? NSTextView else { return }
        if parent.text != input.string { parent.text = input.string }
        updateHeight(input)
      }
      func updateHeight(_ input: NSTextView) {
        guard let layout = input.layoutManager, let container = input.textContainer else { return }
        layout.ensureLayout(for: container)
        let measured = min(
          CGFloat(140), max(CGFloat(36), layout.usedRect(for: container).height + 16))
        if abs(parent.height - measured) > 1 { parent.height = measured }
      }
      func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)),
          !textView.hasMarkedText(), NSApp.currentEvent?.modifierFlags.contains(.shift) != true
        {
          parent.onSend()
          return true
        }
        return false
      }
    }
  }
  private final class ChatTextView: NSTextView {
    var placeholder = ""
    private var focusWhenAttached = false

    func requestFocus() {
      guard let window else {
        focusWhenAttached = true
        return
      }
      focusWhenAttached = false
      window.makeFirstResponder(self)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if focusWhenAttached, window != nil { requestFocus() }
    }

    override func draw(_ dirtyRect: NSRect) {
      super.draw(dirtyRect)
      if string.isEmpty {
        (placeholder as NSString).draw(
          at: NSPoint(x: 5, y: textContainerInset.height),
          withAttributes: [
            .font: font ?? NSFont.preferredFont(forTextStyle: .body),
            .foregroundColor: NSColor(Color.echo.textSecondary),
          ])
      }
    }
  }
#endif
