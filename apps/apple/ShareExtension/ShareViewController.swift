import CompanionCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let controller = UIHostingController(rootView: ShareDraftView(context: extensionContext))
    addChild(controller)
    view.addSubview(controller.view)
    controller.view.frame = view.bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    controller.didMove(toParent: self)
  }
}
struct ShareDraftView: View {
  let context: NSExtensionContext?
  @State private var text = ""
  @State private var target = ""
  @State private var image: Data?
  @State private var mime = "image/png"
  @State private var error = ""
  var body: some View {
    NavigationStack {
      Form {
        Text("仅保存到 Echo 草稿。明确发送前不会调用模型。")
        Picker("目标对话", selection: $target) {
          ForEach(SystemInbox.targets()["targets"].array, id: \.self) { t in
            Text(t["name"].string).tag(t["room"].string)
          }
        }
        TextEditor(text: $text).accessibilityLabel("分享附言")
        if image != nil { Text("已选择图片") }
        Text(error)
        Button("保存草稿") {
          do {
            let all = SystemInbox.targets()
            guard let t = all["targets"].array.first(where: { $0["room"].string == target }) else {
              throw APIError(status: 409, code: "share_target")
            }
            try SystemInbox.store(
              SystemInboxItem(
                namespace: all["namespace"].string, actor: t["actor"].string, room: target,
                content: text, image: image, mime: mime))
            context?.completeRequest(returningItems: nil)
          } catch { self.error = error.localizedDescription }
        }
        Button("取消") { context?.cancelRequest(withError: NSError(domain: "EchoShare", code: 1)) }
      }.navigationTitle("保存到 Echo").task {
        target = SystemInbox.targets()["targets"].array.first?["room"].string ?? ""
        await read()
      }
    }
  }
  private func read() async {
    for item in (context?.inputItems as? [NSExtensionItem]) ?? [] {
      if let string = item.attributedContentText?.string { text = string }
      for provider in (item.attachments ?? []).prefix(8) {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), image == nil {
          do {
            let data = try await withCheckedThrowingContinuation {
              (c: CheckedContinuation<Data, Error>) in
              provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) {
                data, error in
                if let data {
                  c.resume(returning: data)
                } else {
                  c.resume(throwing: error ?? NSError(domain: "EchoShare", code: 2))
                }
              }
            }
            guard data.count <= 1_048_576 else {
              throw APIError(status: 413, code: "invalid_asset")
            }
            guard let converted = UIImage(data: data)?.pngData(), converted.count <= 1_048_576
            else { throw APIError(status: 413, code: "invalid_asset") }
            image = converted
            mime = "image/png"
          } catch { self.error = error.localizedDescription }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          if let data = try? await withCheckedThrowingContinuation({
            (c: CheckedContinuation<Data, Error>) in
            provider.loadDataRepresentation(forTypeIdentifier: UTType.plainText.identifier) {
              data, error in
              if let data {
                c.resume(returning: data)
              } else {
                c.resume(throwing: error ?? NSError(domain: "EchoShare", code: 3))
              }
            }
          }), data.count <= 16000 {
            text = String(decoding: data, as: UTF8.self)
          }
        }
      }
    }
  }
}
