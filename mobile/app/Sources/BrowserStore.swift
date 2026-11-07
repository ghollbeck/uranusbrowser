import SwiftUI
import WebKit
import Observation

enum AppSheet: Identifiable, Equatable {
    case search(editing: Bool)
    case pageMenu, siteSettings, settings, spaces, saveWebApp
    var id: String {
        switch self {
        case .search: "search"
        case .pageMenu: "menu"
        case .siteSettings: "site"
        case .settings: "settings"
        case .spaces: "spaces"
        case .saveWebApp: "saveWebApp"
        }
    }
}

/// A Space: its own tabs, archive, history and its own persistent cookie/storage container.
@MainActor @Observable
final class Space: Identifiable {
    let id: UUID
    var name: String
    var palette: SpacePalette
    var tabs: [Tab] = []
    var archive: [ArchivedTab] = []
    var history: [HistoryItem] = []
    var selectedTabID: UUID?

    init(id: UUID = UUID(), name: String, palette: SpacePalette) {
        self.id = id
        self.name = name
        self.palette = palette
    }

    /// One isolated website data store per Space (cookies, localStorage, caches).
    func dataStore() -> WKWebsiteDataStore { WKWebsiteDataStore(forIdentifier: id) }
}

@MainActor @Observable
final class BrowserStore {
    var spaces: [Space] = []
    var currentSpaceID = UUID()
    var settings = AppSettings()
    /// EXPERIMENT: launch-argument override (`-topStyle pillFlowers`) for screenshots. Never saved; the Settings row clears it.
    var topStyleOverride: TopStyle?
    var topStyle: TopStyle { topStyleOverride ?? settings.topStyle }
    /// EXPERIMENT: pill edit mode (not persisted) and the selected flower while editing.
    var editingPill = false
    var selectedFlower: UUID?
    var privateTabs: [Tab] = []
    var privateSelectedID: UUID?
    var isPrivate = false
    var showSwitcher = false
    var findActive = false
    var sheet: AppSheet?
    var toast: String?

    @ObservationIgnored private var privateStore: WKWebsiteDataStore?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    init() {
        if let rec = Self.readState() {
            settings = rec.settings
            currentSpaceID = rec.currentSpaceID
            spaces = rec.spaces.map { r in
                let s = Space(id: r.id, name: r.name, palette: r.palette)
                s.archive = r.archive
                s.history = r.history
                s.selectedTabID = r.selectedTabID
                s.tabs = r.tabs.map { Tab(record: $0, spaceID: r.id, store: self) }
                return s
            }
        }
        if spaces.isEmpty {
            let s = Space(name: "Home", palette: .dusk)
            spaces = [s]
            currentSpaceID = s.id
        }
        if !spaces.contains(where: { $0.id == currentSpaceID }) { currentSpaceID = spaces[0].id }
        for s in spaces where s.tabs.isEmpty {
            let t = Tab(url: nil, spaceID: s.id, store: self)
            s.tabs = [t]
            s.selectedTabID = t.id
        }
        topStyleOverride = UserDefaults.standard.string(forKey: "topStyle").flatMap(TopStyle.init(rawValue:))
        if UserDefaults.standard.bool(forKey: "editPill") {   // EXPERIMENT: `-editPill 1` starts in pill edit mode
            if topStyle == .blur { topStyleOverride = .pillFlowers }
            editingPill = true
        }
        archiveInactive()
        applyMotionScale()
    }

    // MARK: current state

    var currentSpace: Space { spaces.first { $0.id == currentSpaceID } ?? spaces[0] }
    var palette: SpacePalette { isPrivate ? .graphite : currentSpace.palette }
    var tabs: [Tab] { isPrivate ? privateTabs : currentSpace.tabs }
    var orderedTabs: [Tab] { tabs.filter(\.isPinned) + tabs.filter { !$0.isPinned } }
    var selectedTab: Tab? {
        let id = isPrivate ? privateSelectedID : currentSpace.selectedTabID
        return tabs.first { $0.id == id } ?? tabs.first
    }

    // MARK: tabs

    @discardableResult
    func newTab(url: URL? = nil, configuration: WKWebViewConfiguration? = nil, select doSelect: Bool = true) -> Tab {
        let t = Tab(url: url, spaceID: isPrivate ? nil : currentSpaceID, store: self)
        if isPrivate { privateTabs.append(t) } else { currentSpace.tabs.append(t) }
        if let configuration { t.adopt(configuration) }
        if doSelect { select(t) }
        scheduleSave()
        return t
    }

    func select(_ tab: Tab) {
        if isPrivate { privateSelectedID = tab.id } else { currentSpace.selectedTabID = tab.id }
        tab.lastActive = .now
        findActive = false
        evictIfNeeded(keeping: tab)
        scheduleSave()
    }

    func close(_ tab: Tab) {
        let wasSelected = selectedTab === tab
        let idx = tabs.firstIndex { $0 === tab }
        tab.releaseWebView()
        if isPrivate {
            privateTabs.removeAll { $0 === tab }
            if privateTabs.isEmpty { setPrivate(false); return }
        } else {
            currentSpace.tabs.removeAll { $0 === tab }
            removeSnapshot(for: tab.id)
            if currentSpace.tabs.isEmpty {
                let t = Tab(url: nil, spaceID: currentSpaceID, store: self)
                currentSpace.tabs = [t]
            }
        }
        if wasSelected {
            let list = tabs
            let next = list.indices.contains(idx ?? 0) ? list[idx ?? 0] : list.last
            if let next { select(next) }
        }
        scheduleSave()
    }

    func togglePin(_ tab: Tab) {
        tab.isPinned.toggle()
        scheduleSave()
    }

    func openSwitcher() {
        Task {
            await selectedTab?.captureSnapshot()
            showSwitcher = true
        }
    }

    /// "+" in the switcher: a blank tab, then the keyboard if the user wants it.
    func newBlankTabFromSwitcher() {
        beginNewTabFlow()   // PageMotion.swift: element 6, lets the page layer animate the swap to the blank tab
        let t = selectedTab?.isBlank == true ? selectedTab! : newTab()
        select(t)
        showSwitcher = false
        if settings.autoOpenKeyboard { presentSearchForNewTab() }   // PageMotion.swift: sheet with element 6's timing
    }

    private func evictIfNeeded(keeping keep: Tab) {
        let live = (spaces.flatMap(\.tabs) + privateTabs).filter { $0.hasWebView && $0 !== keep }
        let maxBackground = 5
        guard live.count > maxBackground else { return }
        for t in live.sorted(by: { $0.lastActive < $1.lastActive }).prefix(live.count - maxBackground) { t.suspend() }
    }

    // MARK: address input

    func resolve(_ raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.contains("://") { return URL(string: s) }
        if !s.contains(" "), s.contains(".") || s.hasPrefix("localhost") {
            let local = s.hasPrefix("localhost") || s.hasPrefix("127.") || s.hasPrefix("192.168.") || s.hasPrefix("10.")
            if let u = URL(string: (local ? "http://" : "https://") + s), u.host != nil { return u }
        }
        return settings.searchEngine.url(for: s)
    }

    func commit(_ raw: String, editing: Bool) {
        guard let url = resolve(raw) else { return }
        if let tab = selectedTab, editing || tab.isBlank { tab.load(url) } else { newTab(url: url) }
    }

    func handle(deepLink url: URL) {
        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            // As the default browser: web links, and Home Screen icons of saved web apps (`#anus-app=<id>`).
            showSwitcher = false
            sheet = nil
            if let id = WebAppHomeScreen.appID(in: url), let app = WebAppStore.shared.app(id: id) {
                WebAppPresenter.shared.open(app, store: self)
            } else {
                if isPrivate { setPrivate(false) }
                newTab(url: WebAppHomeScreen.stripped(url))
            }
            return
        }
        if url.scheme == "flecha", url.host == "diet" {   // flecha://diet opens the Algorithm Diet
            showSwitcher = false
            sheet = nil
            DietEngine.shared.isPresented = true
            return
        }
        if url.scheme == "flecha", url.host == "app" {   // flecha://app?id=<uuid> opens a saved web app
            let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
            if let app = id.flatMap(UUID.init(uuidString:)).flatMap(WebAppStore.shared.app(id:)) { WebAppPresenter.shared.open(app, store: self) }
            return
        }
        guard url.scheme == "flecha", url.host == "open",
              let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value
        else { return }
        showSwitcher = false
        sheet = nil
        if let u = URL(string: target), ["http", "https"].contains(u.scheme?.lowercased() ?? ""), u.host != nil { newTab(url: u) }
    }

    // MARK: spaces + private mode

    func switchSpace(_ id: UUID) {
        if isPrivate { setPrivate(false) }
        currentSpaceID = id
        findActive = false
        scheduleSave()
    }

    func addSpace(name: String) {
        let used = Set(spaces.map(\.palette))
        let palette = SpacePalette.allCases.first { !used.contains($0) && $0 != .graphite } ?? .dusk
        let s = Space(name: name.isEmpty ? "Space \(spaces.count + 1)" : name, palette: palette)
        let t = Tab(url: nil, spaceID: s.id, store: self)
        s.tabs = [t]
        s.selectedTabID = t.id
        spaces.append(s)
        switchSpace(s.id)
    }

    func deleteSpace(_ space: Space) {
        guard spaces.count > 1 else { return }
        let wasCurrent = space.id == currentSpaceID
        space.tabs.forEach { $0.releaseWebView(); removeSnapshot(for: $0.id) }
        spaces.removeAll { $0.id == space.id }
        if wasCurrent { currentSpaceID = spaces[0].id }
        Task { try? await WKWebsiteDataStore.remove(forIdentifier: space.id) }
        scheduleSave()
    }

    func setPrivate(_ on: Bool) {
        guard on != isPrivate else { return }
        findActive = false
        if on {
            isPrivate = true
            if privateTabs.isEmpty { newTab() }
        } else {
            privateTabs.forEach { $0.releaseWebView() }
            privateTabs = []
            privateSelectedID = nil
            privateStore = nil   // drops every private cookie and cache
            FaviconStore.shared.clearPrivate()
            isPrivate = false
        }
    }

    func makeConfiguration(spaceID: UUID?) -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        if let spaceID, let space = spaces.first(where: { $0.id == spaceID }) {
            c.websiteDataStore = space.dataStore()
        } else {
            if privateStore == nil { privateStore = .nonPersistent() }
            c.websiteDataStore = privateStore!
        }
        c.allowsInlineMediaPlayback = true
        // Sites key their mobile layout off "Safari/"; a bare WKWebView user agent lacks it.
        c.applicationNameForUserAgent = "Version/26.0 Mobile/15E148 Safari/604.1"
        return c
    }

    // MARK: site settings

    func siteSettings(for url: URL?) -> SiteSettings {
        guard let key = url?.siteKey else { return settings.defaultSite }
        return settings.perSite[key] ?? settings.defaultSite
    }

    func setSiteSettings(_ s: SiteSettings, for url: URL?) {
        guard let key = url?.siteKey else { return }
        settings.perSite[key] = s
        scheduleSave()
    }

    func applyBlocking(to webView: WKWebView, url: URL) {
        ContentBlocker.apply(siteSettings(for: url), to: webView.configuration.userContentController)
    }

    // MARK: history + archive

    func recordVisit(_ tab: Tab) {
        guard let spaceID = tab.spaceID, let space = spaces.first(where: { $0.id == spaceID }),
              let url = tab.url, url.scheme?.hasPrefix("http") == true else { return }
        space.history.removeAll { $0.url == url.absoluteString }
        space.history.insert(HistoryItem(url: url.absoluteString, title: tab.title, date: .now), at: 0)
        if space.history.count > 500 { space.history.removeLast(space.history.count - 500) }
        scheduleSave()
    }

    func archiveInactive(now: Date = .now) {
        guard let interval = settings.archiveAfter.interval else { return }
        for space in spaces {
            let stale = space.tabs.filter {
                !$0.isPinned && $0.id != space.selectedTabID && $0.url != nil && now.timeIntervalSince($0.lastActive) > interval
            }
            for t in stale {
                space.archive.insert(ArchivedTab(id: t.id, url: t.url!.absoluteString, title: t.displayTitle, archivedAt: now), at: 0)
                t.releaseWebView()
                space.tabs.removeAll { $0 === t }
            }
            if space.archive.count > 500 { space.archive.removeLast(space.archive.count - 500) }
        }
        scheduleSave()
    }

    func restore(_ item: ArchivedTab) {
        guard let url = URL(string: item.url) else { return }
        if isPrivate { setPrivate(false) }
        currentSpace.archive.removeAll { $0.id == item.id }
        let t = Tab(id: item.id, url: url, title: item.title, spaceID: currentSpaceID, store: self)
        currentSpace.tabs.append(t)
        select(t)
    }

    func clearBrowsingData() async {
        let space = currentSpace
        await space.dataStore().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        space.history = []
        FaviconStore.shared.clearAll()   // the icon cache would reveal which sites were visited
        showToast("Cleared data for \(space.name)")
        scheduleSave()
    }

    func exportText() -> String {
        let s = currentSpace
        return ([s.name] + s.tabs.compactMap { $0.url?.absoluteString }).joined(separator: "\n")
    }

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { toast = nil }
        }
    }

    // MARK: persistence

    private static var supportDir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static var stateURL: URL { supportDir.appendingPathComponent("state.json") }
    private static var snapshotDir: URL {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("snapshots")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private static func readState() -> StateRecord? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(StateRecord.self, from: data)
    }

    func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { save() }
        }
    }

    func save() {
        let rec = StateRecord(
            spaces: spaces.map { s in
                SpaceRecord(id: s.id, name: s.name, palette: s.palette,
                            tabs: s.tabs.map { TabRecord(id: $0.id, url: $0.url?.absoluteString, title: $0.title, pinned: $0.isPinned, lastActive: $0.lastActive) },
                            archive: s.archive, history: s.history, selectedTabID: s.selectedTabID)
            },
            currentSpaceID: currentSpaceID, settings: settings)
        if let data = try? JSONEncoder().encode(rec) { try? data.write(to: Self.stateURL, options: .atomic) }
    }

    func loadSnapshot(for id: UUID) -> UIImage? {
        UIImage(contentsOfFile: Self.snapshotDir.appendingPathComponent("\(id.uuidString).jpg").path)
    }

    func persistSnapshot(_ image: UIImage, for id: UUID) {
        guard !isPrivate || !privateTabs.contains(where: { $0.id == id }) else { return }   // nothing private on disk
        try? image.jpegData(compressionQuality: 0.7)?.write(to: Self.snapshotDir.appendingPathComponent("\(id.uuidString).jpg"))
    }

    private func removeSnapshot(for id: UUID) {
        try? FileManager.default.removeItem(at: Self.snapshotDir.appendingPathComponent("\(id.uuidString).jpg"))
    }
}
