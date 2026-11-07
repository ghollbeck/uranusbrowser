import SwiftUI

/// Chat with your history. Answers come from Woof 2B on this device (or the Mac bridge in the Simulator); without a
/// model they come straight from the numbers.
struct DietChatView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var session = DietChatSession()
    @State private var draft = ""
    @State private var modelLabel: String?
    @FocusState private var focused: Bool
    private let engine = DietEngine.shared

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Layout.gap) {
                        if session.messages.isEmpty { intro }
                        ForEach(session.messages) { m in
                            bubble(m).id(m.id)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                    .padding(.horizontal, Layout.sheetInset)
                    .padding(.bottom, Layout.gap)
                    .animation(.smooth(duration: 0.3), value: session.messages.count)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: session.messages.last?.text) { _, _ in
                    if let id = session.messages.last?.id { withAnimation(.smooth) { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle("Ask your history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                modelLabel = await LocalModels.current().map { "\($0.label) · \(LocalModels.where_)" }
                if let q = UserDefaults.standard.string(forKey: "dietAsk"), session.messages.isEmpty { session.ask(q, engine: engine) }
            }
            .onDisappear { session.stop() }
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: Layout.gap) {
            HStack(spacing: Layout.tight) {
                Image(systemName: modelLabel == nil ? "chart.bar.doc.horizontal" : "cpu")
                Text(modelLabel ?? "Quick answers from your numbers (no model on this device yet)")
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.card, in: .capsule)
            .padding(.top, Layout.gap)
            Text("What do you want to know about your browsing?").font(.title3.weight(.semibold))
            ForEach(DietChatContext.suggestions, id: \.self) { s in
                Button { session.ask(s, engine: engine) } label: {
                    HStack {
                        Text(s).multilineTextAlignment(.leading)
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, Layout.sheetInset)
                    .frame(minHeight: Layout.rowHeight - 6)
                    .background(Theme.card, in: .rect(cornerRadius: Layout.cardRadius))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private func bubble(_ m: DietChatSession.Message) -> some View {
        switch m.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(m.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .foregroundStyle(.white)
                    .background(Theme.accent.gradient, in: .rect(cornerRadius: 20))
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                if m.text.isEmpty && m.streaming {
                    ThinkingDots()
                } else {
                    Text(Self.markdown(m.text))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !m.sources.isEmpty, !m.streaming {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(m.sources) { source in
                                Link(destination: source.url) {
                                    Text("[\(source.number)] \(source.title)").lineLimit(1)
                                        .font(.caption2).padding(.horizontal, 8).padding(.vertical, 6)
                                        .background(Theme.card, in: .capsule)
                                }
                                .accessibilityLabel("Source \(source.number): \(source.title)")
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .padding(14)
            .background(Theme.card, in: .rect(cornerRadius: 20))
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if !session.messages.isEmpty, !session.busy {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(DietChatContext.suggestions, id: \.self) { s in
                            Button(s) { session.ask(s, engine: engine) }
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .glassEffect(.regular.interactive(), in: .capsule)
                                .contentShape(Capsule())   // the whole glass shape is tappable, not just the glyph
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, Layout.sheetInset)
                }
                .scrollIndicators(.hidden)
            }
            HStack(spacing: Layout.tight) {
                TextField("Ask about your history", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.leading, Layout.capsuleInset(Layout.fieldHeight))
                Button {
                    session.busy ? session.stop() : send()
                } label: {
                    Image(systemName: session.busy ? "stop.fill" : "arrow.up")
                        .font(.body.weight(.bold))
                        .frame(width: Layout.control, height: Layout.control)
                        .foregroundStyle(.white)
                        .background(Theme.accent, in: .circle)
                }
                .disabled(!session.busy && draft.trimmingCharacters(in: .whitespaces).isEmpty)
                .padding(Layout.fieldSlotInset)
            }
            .frame(minHeight: Layout.fieldHeight)
            .glassEffect(.regular, in: .rect(cornerRadius: Layout.fieldHeight / 2))
            .padding(.horizontal, Layout.sheetInset)
        }
        .padding(.bottom, 8)
    }

    private func send() {
        let q = draft
        draft = ""
        session.ask(q, engine: engine)
    }

    static func markdown(_ s: String) -> AttributedString {
        // Small models write "- " or "* " bullets; show them as real bullets.
        let text = s.replacingOccurrences(of: #"(?m)^\s*[-*]\s+"#, with: "• ", options: .regularExpression)
        return (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Three dots that pulse while Woof is reading the notes.
struct ThinkingDots: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: 6) {
                ForEach(0..<3) { i in
                    Circle()
                        .frame(width: 8, height: 8)
                        .opacity(0.3 + 0.7 * max(0, sin(t * 5 - Double(i) * 0.7)))
                        .scaleEffect(0.8 + 0.3 * max(0, sin(t * 5 - Double(i) * 0.7)))
                }
            }
            .foregroundStyle(.secondary)
        }
        .frame(height: 20)
    }
}
