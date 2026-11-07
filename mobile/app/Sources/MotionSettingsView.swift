import SwiftUI

/// Settings > Motion: pick A / B / C for each of the twelve moments, live. Same numbering as design/animations.html.
struct MotionSettingsView: View {
    @Environment(BrowserStore.self) private var store

    /// Short honest notes where an alternative is limited by iOS (filled in as variants are implemented).
    static var notes: [MotionElement: String] {
        SwitcherMotion.notes.merging(PageMotion.notes) { a, _ in a }.merging(ArchiveMotion.notes) { a, _ in a }
    }

    var body: some View {
        @Bindable var store = store
        List {
            Section {
                HStack(spacing: Layout.gap) {
                    ForEach(MotionVariant.allCases) { v in
                        Button("All \(v.letter)") { store.settings.motion.setAll(v) }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity)
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                Toggle(isOn: $store.settings.motion.slowMotion) {
                    HStack(spacing: Layout.gap) { IconTile(symbol: "tortoise.fill", color: .orange); Text("Slow motion ×4") }
                }
            } footer: {
                Text("★ marks your picks from the design page (the defaults). A is calm, B is snappy, C is expressive. Try one, go back to the page, and watch the moment. Slow motion makes every duration four times longer so you can see the details.")
            }
            ForEach(MotionElement.allCases) { e in
                Section {
                    Picker(selection: Binding(get: { store.settings.motion.variant(e) },
                                              set: { store.settings.motion.set($0, for: e) })) {
                        ForEach(MotionVariant.allCases) { v in Text(v.letter + (MotionSettings.ownerPicks[e] == v ? " ★" : "")).tag(v) }
                    } label: { EmptyView() }
                    .pickerStyle(.segmented)
                } header: {
                    Text("\(e.rawValue). \(e.title)")
                } footer: {
                    Text(e.hint + (Self.notes[e].map { " · " + $0 } ?? ""))
                }
            }
            Section {
                Button("Back to my picks (1C 2A 3C 4C 5A 6C 7C 8C 9C 10A 11B 12B)") { store.settings.motion.picks = [:] }
            }
        }
        .navigationTitle("Motion")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: store.settings.motion) { _, _ in
            store.applyMotionScale()
            store.scheduleSave()
        }
    }
}
