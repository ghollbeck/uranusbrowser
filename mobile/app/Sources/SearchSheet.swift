import SwiftUI
import UIKit
import WebKit

/// UITextField wrapper so the whole URL can be selected when the sheet opens (reference 15).
struct AddressField: UIViewRepresentable {
    @Binding var text: String
    var selectAll: Bool
    var onSubmit: () -> Void

    func makeUIView(context: Context) -> UITextField {
        let f = UITextField()
        f.placeholder = "Search or enter address"
        f.autocapitalizationType = .none
        f.autocorrectionType = .no
        f.keyboardType = .webSearch
        f.returnKeyType = .go
        f.clearButtonMode = .whileEditing
        f.font = .preferredFont(forTextStyle: .body)
        f.text = text
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        // Summoning the keyboard while the sheet grows stalled the animation for ~200 ms and resized the sheet mid-flight
        // (frame audit, Oct 30). Wait until the 0.4 s spring has landed.
        DispatchQueue.main.asyncAfter(deadline: .now() + Motion.scaled(0.38)) {
            f.becomeFirstResponder()
            if selectAll { f.selectedTextRange = f.textRange(from: f.beginningOfDocument, to: f.endOfDocument) }
        }
        return f
    }

    func updateUIView(_ f: UITextField, context: Context) {
        if f.text != text, f.markedTextRange == nil { f.text = text }
    }

    /// Take the width the layout offers; a long URL must never make the field (and the sheet around it) wider than the sheet.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 240, height: uiView.intrinsicContentSize.height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: AddressField
        init(_ p: AddressField) { parent = p }
        @objc func changed(_ f: UITextField) { parent.text = f.text ?? "" }
        func textFieldShouldReturn(_ f: UITextField) -> Bool { parent.onSubmit(); return true }
    }
}

struct SearchSheet: View {
    @Environment(BrowserStore.self) private var store
    let editing: Bool
    @State private var text = ""
    @State private var started = false

    private struct Suggestion: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let target: String
        let isSearch: Bool
    }

    private var suggestions: [Suggestion] {
        let q = text.trimmingCharacters(in: .whitespaces).lowercased()
        var out: [Suggestion] = []
        var seen = Set<String>()
        func add(_ s: Suggestion) { if seen.insert(s.target).inserted { out.append(s) } }
        if !q.isEmpty {
            add(Suggestion(id: "search", title: "Search \(store.settings.searchEngine.title) for “\(text)”", subtitle: "", target: text, isSearch: true))
        }
        for t in store.tabs {
            guard let u = t.url?.absoluteString else { continue }
            if q.isEmpty || u.lowercased().contains(q) || t.title.lowercased().contains(q) {
                add(Suggestion(id: "tab-\(t.id)", title: t.displayTitle, subtitle: "Open tab · \(t.url?.host ?? "")", target: u, isSearch: false))
            }
        }
        if !store.isPrivate {
            for h in store.currentSpace.history where q.isEmpty || h.url.lowercased().contains(q) || h.title.lowercased().contains(q) {
                add(Suggestion(id: "h-\(h.url)", title: h.title.isEmpty ? h.host : h.title, subtitle: h.host, target: h.url, isSearch: false))
            }
        }
        return Array(out.prefix(8))
    }

    var body: some View {
        VStack(spacing: Layout.gap) {
            HStack(spacing: Layout.tight) {
                Image(systemName: store.isPrivate ? "eyes" : "magnifyingglass").foregroundStyle(.secondary)
                    .frame(width: Layout.glyph, height: Layout.glyph)
                AddressField(text: $text, selectAll: editing, onSubmit: commit)
                    .frame(height: 24)
            }
            .padding(.horizontal, Layout.capsuleInset(Layout.fieldHeight))
            .frame(height: Layout.fieldHeight)
            .background(Theme.card, in: .capsule)

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(suggestions) { s in
                        Button { store.commit(s.target, editing: editing); store.sheet = nil } label: {
                            HStack(spacing: Layout.gap) {
                                if s.isSearch {
                                    Image(systemName: "magnifyingglass").frame(width: Layout.iconTile, height: Layout.iconTile).foregroundStyle(.secondary)
                                } else {
                                    SiteIcon(host: URL(string: s.target)?.host)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.title).lineLimit(1)
                                    if !s.subtitle.isEmpty { Text(s.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(height: Layout.rowHeight)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .reportsSheetScroll()
            .scrollDismissesKeyboard(.interactively)
        }
        .padding(.horizontal, Layout.sheetInset)
        .padding(.top, Layout.sheetTop)
        .onAppear {
            guard !started else { return }
            started = true
            if editing { text = store.selectedTab?.url?.absoluteString ?? "" }
        }
        .presentationDetents([.fraction(0.7)])
        .presentationDragIndicator(.visible)
    }

    private func commit() {
        store.commit(text, editing: editing)
        store.sheet = nil
    }
}

/// Replaces the bottom bar while finding text on the page (reference 13).
/// Same system as `BottomBar`: 44 pt controls, close circle at the left `Layout.edge` inset, up/down capsule (2 x 44) at the
/// right inset, `Layout.gap` between siblings and above. Bottom: `Layout.edge` above the physical screen bottom while the
/// keyboard is hidden; while the keyboard is up it replaces the bottom safe area, so the bar sits `Layout.gap` above it
/// (otherwise a 24 pt hole would show between bar and keyboard).
struct FindBar: View {
    @Environment(BrowserStore.self) private var store
    let tab: Tab
    /// Element 11 B/C: the controls are clipped to a centred capsule (the width of the "+" capsule) that stretches to full width
    /// as `reveal` goes 0 -> 1, and their contents fade in with `content`. Defaults draw the bar plainly.
    var reveal: Double = 1
    var content: Double = 1
    @State private var text = ""
    @State private var keyboardUp = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Layout.gap) {
            Button { close() } label: {
                Image(systemName: "xmark").font(.system(size: Layout.barControl * 0.4, weight: .semibold))
                    .opacity(content)
                    .frame(width: Layout.barControl, height: Layout.barControl)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .contentShape(Circle())   // the whole glass shape is tappable, not just the glyph
            }
            .buttonStyle(.plain)
            HStack(spacing: Layout.tight) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    .frame(width: Layout.glyph, height: Layout.glyph)
                TextField("Find on page", text: $text)
                    .focused($focused)
                    .submitLabel(.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { find(forward: true) }
                    .onChange(of: text) { _, _ in find(forward: true) }
            }
            .opacity(content)
            .padding(.horizontal, Layout.capsuleInset(Layout.barControl))
            .frame(height: Layout.barControl)
            .glassEffect(.regular, in: .capsule)
            HStack(spacing: 0) {
                Button { find(forward: false) } label: { Image(systemName: "chevron.up").frame(width: Layout.barControl, height: Layout.barControl).contentShape(Rectangle()) }
                Button { find(forward: true) } label: { Image(systemName: "chevron.down").frame(width: Layout.barControl, height: Layout.barControl).contentShape(Rectangle()) }
            }
            .opacity(content)
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
        }
        .clipShape(FindRevealShape(reveal: reveal, minWidth: Layout.barControl * 2))
        .floatingBarInsets(keyboardUp: keyboardUp)
        .onAppear { focused = true }
        .onChange(of: store.findActive) { _, on in if !on { focused = false } }   // hide the keyboard as the bar leaves
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
    }

    private func find(forward: Bool) {
        guard !text.isEmpty else { return }
        let cfg = WKFindConfiguration()
        cfg.backwards = !forward
        cfg.wraps = true
        tab.webView?.find(text, configuration: cfg) { _ in }
    }

    private func close() {
        tab.webView?.evaluateJavaScript("window.getSelection().removeAllRanges()")
        focused = false
        store.findActive = false
    }
}
