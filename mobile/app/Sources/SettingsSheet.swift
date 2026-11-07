import SwiftUI

/// Settings (references 09, 10) with the Archive (reference 08) and Spaces pushed inside it.
struct SettingsSheet: View {
    @Environment(BrowserStore.self) private var store
    @State private var confirmClear = false
    @State private var adding = false
    @State private var newName = ""

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section {
                    NavigationLink { ArchiveView() } label: {
                        row("archivebox.fill", .purple, "Archive", detail: "\(store.currentSpace.archive.count)")
                    }
                    NavigationLink { SpacesList(adding: $adding) } label: {
                        row("square.grid.2x2.fill", .indigo, "Spaces", detail: store.currentSpace.name)
                    }
                    NavigationLink { WebAppsList() } label: {
                        row("apps.iphone", .orange, "Web Apps", detail: "\(WebAppStore.shared.apps.count)")
                    }
                    NavigationLink { GlobalSiteSettings() } label: {
                        row("globe", .black, "Global Site Settings")
                    }
                    Button { store.sheet = nil; DietEngine.shared.isPresented = true } label: {
                        row("fork.knife", .green, "Algorithm Diet", sub: "What you browse, scored A to E, on this device")
                    }
                    .foregroundStyle(.primary)
                }
                Section {
                    Picker(selection: $store.settings.searchEngine) {
                        ForEach(SearchEngine.allCases) { Text($0.title).tag($0) }
                    } label: { row("magnifyingglass", .blue, "Search Engine") }
                    Picker(selection: $store.settings.appearance) {
                        ForEach(AppearanceMode.allCases) { Text($0.title).tag($0) }
                    } label: { row("circle.lefthalf.filled", .teal, "Appearance") }
                    Picker(selection: Binding(get: { store.topStyle },
                                              set: { store.topStyleOverride = nil; store.settings.topStyle = $0 })) {
                        ForEach(TopStyle.allCases) { Text($0.title).tag($0) }
                    } label: { row("capsule.fill", .black, "Top bar style", sub: "Experiment") }
                    NavigationLink { MotionSettingsView() } label: {
                        row("sparkles", .indigo, "Motion", sub: "Pick A, B or C for each animation")
                    }
                    Button { store.beginPillEditingFromSettings() } label: {
                        row("hand.draw.fill", .pink, "Edit pill and flowers",
                            sub: store.topStyle == .blur || store.topStyle == .twinPills ? "Switches to Black pill + flowers" : "Drag flowers, resize the bar")
                    }
                    .foregroundStyle(.primary)
                }
                Section {
                    Toggle(isOn: $store.settings.autoOpenKeyboard) { row("keyboard", .yellow, "Auto-Open Keyboard") }
                    Picker(selection: $store.settings.archiveAfter) {
                        ForEach(ArchiveAfter.allCases) { Text($0.title).tag($0) }
                    } label: { row("archivebox", .purple, "Archive Inactive Tabs") }
                    Button { confirmClear = true } label: { row("eraser.fill", .red, "Clear Browsing Data…") }
                        .foregroundStyle(.primary)
                    ShareLink(item: store.exportText()) { row("square.and.arrow.up", .blue, "Export Data", sub: "Share your open tab URLs") }
                        .foregroundStyle(.primary)
                } footer: {
                    Text("Flecha \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") · prototype")
                        .frame(maxWidth: .infinity).padding(.top, Layout.gap)
                }
            }
            .environment(\.defaultMinListRowHeight, Layout.rowHeight)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { store.sheet = nil } } }
            .confirmationDialog("Clear data for \(store.currentSpace.name)?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear cookies, cache and history", role: .destructive) { Task { await store.clearBrowsingData() } }
            } message: { Text("Other Spaces are not affected.") }
            .alert("New Space", isPresented: $adding) {
                TextField("Name", text: $newName)
                Button("Create") { store.addSpace(name: newName); newName = ""; store.sheet = nil; store.showSwitcher = false }
                Button("Cancel", role: .cancel) { newName = "" }
            }
            .onChange(of: store.settings) { _, _ in store.scheduleSave() }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ symbol: String, _ color: Color, _ title: String, sub: String? = nil, detail: String? = nil) -> some View {
        HStack(spacing: Layout.gap) {
            IconTile(symbol: symbol, color: color)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                if let sub { Text(sub).font(.caption).foregroundStyle(.secondary) }
            }
            if let detail { Spacer(); Text(detail).foregroundStyle(.secondary) }
        }
    }
}

struct GlobalSiteSettings: View {
    @Environment(BrowserStore.self) private var store
    var body: some View {
        @Bindable var store = store
        List {
            Section {
                Toggle(isOn: $store.settings.defaultSite.blockAds) { HStack(spacing: Layout.gap) { IconTile(symbol: "hand.raised.fill", color: .red); Text("Block Ads") } }
                Toggle(isOn: $store.settings.defaultSite.blockCookieBanners) { HStack(spacing: Layout.gap) { IconTile(symbol: "shield.lefthalf.filled", color: .orange); Text("Block Cookie Banners") } }
                Toggle(isOn: $store.settings.defaultSite.blockTrackers) { HStack(spacing: Layout.gap) { IconTile(symbol: "eyeglasses", color: .yellow); Text("Block Trackers") } }
            } footer: { Text("Defaults for every site. A site you changed in Site Settings keeps its own choice.") }
            if !store.settings.perSite.isEmpty {
                Section("Sites with their own settings") {
                    ForEach(store.settings.perSite.keys.sorted(), id: \.self) { host in
                        Text(host)
                            .swipeActions { Button("Reset", role: .destructive) { store.settings.perSite[host] = nil } }
                    }
                }
            }
        }
        .environment(\.defaultMinListRowHeight, Layout.rowHeight)
        .navigationTitle("Global Site Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: store.settings) { _, _ in store.scheduleSave() }
    }
}

/// Tabs left idle for the chosen time, grouped by day (reference 08). Tap to bring one back.
/// The list, its row animations (element 12) and the count pill live in `ArchiveScreen` (ArchiveMotion.swift).
struct ArchiveView: View {
    var body: some View { ArchiveScreen() }
}
