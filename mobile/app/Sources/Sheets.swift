import SwiftUI
import WebKit

// MARK: - Page menu (references 12, 14)

struct MenuTile: View {
    let symbol: String
    let title: String
    var dimmed = false
    var body: some View {
        VStack(spacing: Layout.tight) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .regular))
                .frame(maxWidth: .infinity)
                .frame(height: Layout.tileHeight)
                .cardBackground()
            Text(title).font(.caption).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .opacity(dimmed ? 0.4 : 1)
        .contentShape(Rectangle())
    }
}

struct PageMenuSheet: View {
    @Environment(BrowserStore.self) private var store
    @State private var showDisplay = false

    var body: some View {
        Group {
            if let tab = store.selectedTab { content(tab) } else { Color.clear }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func content(_ tab: Tab) -> some View {
        let site = store.siteSettings(for: tab.url)
        ScrollView {
            VStack(spacing: Layout.gap) {
                // URL capsule: 44 pt buttons sit `fieldSlotInset` inside the 54 pt capsule, so each end glyph is centred on the cap arc.
                HStack(spacing: 0) {
                    Button { tab.webView?.goBack() } label: { Image(systemName: "chevron.left").frame(width: Layout.control, height: Layout.control).contentShape(Rectangle()) }
                        .disabled(!tab.canGoBack)
                    Button { tab.webView?.goForward() } label: { Image(systemName: "chevron.right").frame(width: Layout.control, height: Layout.control).contentShape(Rectangle()) }
                        .disabled(!tab.canGoForward)
                    Button { store.sheet = .search(editing: true) } label: {
                        Text(tab.url?.host ?? "New Tab").font(.body.weight(.medium)).lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: Layout.control)
                    }
                    Button {
                        if let u = tab.url { UIPasteboard.general.string = u.absoluteString; store.showToast("Link copied") }
                    } label: { Image(systemName: "link").frame(width: Layout.control, height: Layout.control).contentShape(Rectangle()) }
                    Button { tab.reloadOrStop() } label: { Image(systemName: tab.isLoading ? "xmark" : "arrow.clockwise").frame(width: Layout.control, height: Layout.control).contentShape(Rectangle()) }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Layout.fieldSlotInset)
                .frame(height: Layout.fieldHeight)
                .background(Theme.card, in: .capsule)

                // Tiles
                HStack(spacing: Layout.gap) {
                    Button { store.sheet = nil; store.findActive = true } label: { MenuTile(symbol: "doc.text.magnifyingglass", title: "Find on Page") }
                    MenuTile(symbol: "text.append", title: "Summarize", dimmed: true)
                    Button { store.togglePin(tab) } label: { MenuTile(symbol: tab.isPinned ? "pin.slash" : "pin", title: tab.isPinned ? "Unpin" : "Pin") }
                    if let u = tab.url {
                        // System share sheet plus "Save as Web App" (Sources/WebApps)
                        Button { PageShare.present(u, store: store) } label: { MenuTile(symbol: "square.and.arrow.up", title: "Share") }
                    } else {
                        MenuTile(symbol: "square.and.arrow.up", title: "Share", dimmed: true)
                    }
                }
                .buttonStyle(.plain)

                // Display options
                CardGroup {
                    Button { withAnimation(.smooth) { showDisplay.toggle() } } label: {
                        HStack(spacing: Layout.gap) {
                            Image(systemName: "textformat.size").frame(width: Layout.iconTile)
                            Text("Display Options")
                            Spacer()
                            Image(systemName: "chevron.down").rotationEffect(.degrees(showDisplay ? 180 : 0)).foregroundStyle(.secondary)
                        }
                        .sheetRow().contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if showDisplay {
                        Divider().padding(.leading, Layout.dividerInset)
                        HStack(spacing: Layout.gap) {
                            Image(systemName: "textformat.size.larger").frame(width: Layout.iconTile)
                            Text("Page Zoom")
                            Spacer()
                            Text("\(Int((tab.pageZoom * 100).rounded()))%").foregroundStyle(.secondary).monospacedDigit()
                            HStack(spacing: 0) {
                                Button { tab.setZoom(tab.pageZoom - 0.1) } label: { Image(systemName: "minus").frame(width: Layout.control, height: Layout.stepperHeight).contentShape(Rectangle()) }
                                Button { tab.setZoom(tab.pageZoom + 0.1) } label: { Image(systemName: "plus").frame(width: Layout.control, height: Layout.stepperHeight).contentShape(Rectangle()) }
                            }
                            .buttonStyle(.plain)
                            .background(Theme.card, in: .capsule)
                        }
                        .sheetRow()
                        Divider().padding(.leading, Layout.dividerInset)
                        Toggle(isOn: Binding(get: { tab.desktopMode }, set: { tab.setDesktopMode($0) })) {
                            HStack(spacing: Layout.gap) { Image(systemName: "laptopcomputer").frame(width: Layout.iconTile); Text("Request Desktop Site") }
                        }
                        .sheetRow()
                    }
                }

                CardGroup {
                    Button { store.sheet = .siteSettings } label: {
                        HStack(spacing: Layout.gap) {
                            Image(systemName: "gearshape").frame(width: Layout.iconTile)
                            Text("Site Settings")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                        .sheetRow().contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider().padding(.leading, Layout.dividerInset)
                    // Element 12: moves the tab to the Archive (BrowserStore.archive in ArchiveMotion.swift). The sheet
                    // closes first so the page change and the "Archived" toast are seen on the page.
                    Button {
                        store.sheet = nil
                        Task {
                            try? await Task.sleep(for: .milliseconds(380))
                            store.archive(tab)
                        }
                    } label: {
                        HStack(spacing: Layout.gap) {
                            Image(systemName: "archivebox").frame(width: Layout.iconTile)
                            Text("Archive Tab")
                            Spacer()
                        }
                        .sheetRow().contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!store.canArchive(tab))
                }

                if let host = tab.url?.siteKey {
                    Button {
                        var s = site; s.blockAds = false; s.blockTrackers = false; s.blockCookieBanners = false
                        store.setSiteSettings(s, for: tab.url)
                        tab.webView?.reload()
                        store.sheet = nil
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(site.anyBlocking ? "Blocking is on for \(host)" : "Blocking is off for \(host)").font(.subheadline.weight(.semibold))
                            Text(site.anyBlocking ? "Problems? Tap to reload without it." : "Turn it back on in Site Settings.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                        .padding(Layout.sheetInset)
                        .cardBackground()
                    }
                    .buttonStyle(.plain)
                    .disabled(!site.anyBlocking)
                }
            }
            .padding(.horizontal, Layout.sheetInset)
            .padding(.top, Layout.sheetTop)
            .padding(.bottom, Layout.sheetInset)
        }
        .reportsSheetScroll()
    }
}

// MARK: - Site settings (reference 11)

struct SiteToggleRow: View {
    let symbol: String
    let color: Color
    let title: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: Layout.gap) { IconTile(symbol: symbol, color: color); Text(title) }
        }
        .sheetRow()
    }
}

struct SiteSettingsSheet: View {
    @Environment(BrowserStore.self) private var store
    @State private var changed = false

    var body: some View {
        let tab = store.selectedTab
        let url = tab?.url
        let binding = Binding<SiteSettings>(
            get: { store.siteSettings(for: url) },
            set: { store.setSiteSettings($0, for: url); changed = true })
        ScrollView {
            VStack(alignment: .leading, spacing: Layout.gap) {
                HStack {
                    Text("\(url?.siteKey ?? "This site") settings".uppercased())
                        .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Done") { store.sheet = nil }.buttonStyle(.glass)
                }
                CardGroup {
                    SiteToggleRow(symbol: "hand.raised.fill", color: .red, title: "Block Ads", isOn: binding.blockAds)
                    Divider().padding(.leading, Layout.dividerInset)
                    SiteToggleRow(symbol: "shield.lefthalf.filled", color: .orange, title: "Block Cookie Banners", isOn: binding.blockCookieBanners)
                    Divider().padding(.leading, Layout.dividerInset)
                    SiteToggleRow(symbol: "eyeglasses", color: .yellow, title: "Block Trackers", isOn: binding.blockTrackers)
                }
                Text("Starter lists, not a full filter list. The page reloads when you close this.")
                    .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, Layout.sheetInset)
                CardGroup {
                    Button { store.sheet = .settings } label: {
                        HStack(spacing: Layout.gap) {
                            IconTile(symbol: "gearshape", color: .gray)
                            Text("App Settings")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }
                        .sheetRow().contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Layout.sheetInset)
            .padding(.top, Layout.sheetTop)
            .padding(.bottom, Layout.sheetInset)
        }
        .onDisappear { if changed { tab?.webView?.reload() } }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Spaces

struct SpacesSheet: View {
    @Environment(BrowserStore.self) private var store
    @State private var adding = false
    @State private var newName = ""

    var body: some View {
        NavigationStack { SpacesList(adding: $adding) }
            .alert("New Space", isPresented: $adding) {
                TextField("Name", text: $newName)
                Button("Create") { store.addSpace(name: newName); newName = ""; store.sheet = nil; store.showSwitcher = false }
                Button("Cancel", role: .cancel) { newName = "" }
            } message: { Text("Each Space keeps its own tabs, history, cookies and logins.") }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
    }
}

struct SpacesList: View {
    @Environment(BrowserStore.self) private var store
    @Binding var adding: Bool

    var body: some View {
        List {
            Section {
                ForEach(store.spaces) { space in
                    Button {
                        store.switchSpace(space.id)
                        store.sheet = nil
                        store.showSwitcher = false
                    } label: {
                        HStack(spacing: Layout.gap) {
                            Circle()
                                .fill(LinearGradient(colors: space.palette.colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(width: Layout.iconTile, height: Layout.iconTile)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(space.name).foregroundStyle(.primary)
                                Text("\(space.tabs.count) tabs").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if space.id == store.currentSpaceID && !store.isPrivate { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions { if store.spaces.count > 1 { Button("Delete", role: .destructive) { store.deleteSpace(space) } } }
                }
            } footer: { Text("Swipe a Space to delete it. Deleting a Space also removes its cookies and website data.") }
            Section {
                Button { adding = true } label: { Label("New Space", systemImage: "plus") }
            }
        }
        .environment(\.defaultMinListRowHeight, Layout.rowHeight)
        .navigationTitle("Spaces")
        .navigationBarTitleDisplayMode(.inline)
    }
}
