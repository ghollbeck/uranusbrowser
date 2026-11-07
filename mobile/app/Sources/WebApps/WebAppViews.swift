import SwiftUI
import UIKit

// MARK: - Share sheet with "Save as Web App"

/// The page menu's Share: the system share sheet plus our own "Save as Web App" action.
enum PageShare {
    @MainActor
    static func present(_ url: URL, store: BrowserStore) {
        var saving = false
        let save = SaveWebAppActivity { saving = true }
        // Private pages are never saved: a web app keeps cookies and is tracked by the Diet.
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: store.isPrivate ? nil : [save])
        vc.completionWithItemsHandler = { _, _, _, _ in
            guard saving else { return }
            Task { @MainActor in store.sheet = .saveWebApp }
        }
        guard let top = WebAppPresenter.topController() else { return }
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }
}

final class SaveWebAppActivity: UIActivity {
    private let onSave: () -> Void
    init(onSave: @escaping () -> Void) { self.onSave = onSave }

    override class var activityCategory: UIActivity.Category { .action }
    override var activityType: UIActivity.ActivityType? { UIActivity.ActivityType("dev.oprimo.anus.saveWebApp") }
    override var activityTitle: String? { "Save as Web App" }
    override var activityImage: UIImage? { UIImage(systemName: "apps.iphone.badge.plus") }
    override func canPerform(withActivityItems items: [Any]) -> Bool {
        items.contains { ["http", "https"].contains(($0 as? URL)?.scheme ?? "") }
    }
    override func perform() {
        onSave()
        activityDidFinish(true)
    }
}

// MARK: - Save sheet

struct SaveWebAppSheet: View {
    @Environment(BrowserStore.self) private var store
    @State private var draft: WebAppDraft?
    @State private var name = ""
    @State private var failed = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Layout.gap) {
                    if let draft {
                        form(draft)
                    } else if failed {
                        Text("This page can't be saved as a web app.").foregroundStyle(.secondary).padding(.top, 40)
                    } else {
                        ProgressView("Reading the site…").padding(.top, 40)
                    }
                }
                .padding(.horizontal, Layout.sheetInset)
                .padding(.top, Layout.tight)
            }
            .navigationTitle("Save as Web App")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { store.sheet = nil } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") { save(open: false) }.disabled(draft == nil || name.isEmpty) }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            guard let webView = store.selectedTab?.webView, let d = await WebAppManifestReader.draft(from: webView) else { failed = true; return }
            print("[webapp] draft \(d.name) start=\(d.start.absoluteString) scope=\(d.scope) manifest=\(d.hasManifest) icon=\(d.icon.map { "\(Int($0.size.width * $0.scale))px" } ?? "none") theme=\(d.themeColor ?? "-")")
            draft = d
            name = d.name
        }
    }

    @ViewBuilder
    private func form(_ d: WebAppDraft) -> some View {
        HStack(spacing: Layout.gap) {
            WebAppIcon(image: d.icon, name: name.isEmpty ? d.name : name, size: 64)
            VStack(alignment: .leading, spacing: 4) {
                TextField("Name", text: $name)
                    .font(.title3.weight(.semibold))
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                Text(d.start.host ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(Layout.sheetInset)
        .cardBackground()

        CardGroup {
            info(d.hasManifest ? "checkmark.seal.fill" : "globe", d.hasManifest ? .green : .blue,
                 d.hasManifest ? "Web app manifest found" : "No manifest: saved as a full-screen site",
                 "Opens at \(d.start.path.isEmpty ? "/" : d.start.path), without browser bars.")
            Divider().padding(.leading, Layout.dividerInset)
            info("fork.knife", .green, "Algorithm Diet tracks it",
                 "Time and videos count like in the browser. Uses \(store.currentSpace.name)'s logins.")
        }

        Button { save(open: true) } label: {
            Text("Add and Open").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: Layout.control)
        }
        .buttonStyle(.glassProminent)
        .disabled(name.isEmpty)

        Text("Open it from the new tab page or Settings › Web Apps. For a Home Screen icon: Shortcuts › + › Open Web App › pick it › Add to Home Screen.")
            .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Layout.tight)
    }

    private func info(_ symbol: String, _ color: Color, _ title: String, _ sub: String) -> some View {
        HStack(spacing: Layout.gap) {
            IconTile(symbol: symbol, color: color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(sub).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Layout.sheetInset)
        .padding(.vertical, Layout.tight + 2)
    }

    private func save(open: Bool) {
        guard let d = draft, !store.isPrivate else { return }
        let app = WebApp(name: name.trimmingCharacters(in: .whitespacesAndNewlines), startURL: d.start.absoluteString, scope: d.scope,
                         themeColor: d.themeColor, spaceID: store.currentSpaceID, hasManifest: d.hasManifest)
        WebAppStore.shared.add(app, icon: d.icon)
        print("[webapp] saved \(app.name) id=\(app.id)")
        store.sheet = nil
        if open {
            WebAppPresenter.shared.open(app, store: store)
        } else {
            store.showToast("Added \(app.name) to Web Apps")
        }
    }
}

struct WebAppIcon: View {
    let image: UIImage?
    let name: String
    var size: CGFloat = 56
    var body: some View {
        if let image {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: size, height: size)
                .background(.white)
                .clipShape(.rect(cornerRadius: size * 0.225))
        } else {
            LetterTile(text: name, size: size)
        }
    }
}

// MARK: - New tab page grid

/// Saved web apps on the new tab page: tap to open full screen, long-press for more.
struct WebAppGrid: View {
    @Environment(BrowserStore.self) private var store
    private var apps: [WebApp] { WebAppStore.shared.apps }

    var body: some View {
        if !store.isPrivate, !apps.isEmpty {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Layout.tight), count: 4), spacing: Layout.gap) {
                ForEach(apps.prefix(8)) { app in
                    Button { WebAppPresenter.shared.open(app, store: store) } label: {
                        VStack(spacing: 6) {
                            WebAppIcon(image: WebAppStore.shared.icon(for: app), name: app.name, size: 56)
                                .shadow(color: .black.opacity(0.25), radius: 4, y: 2)
                            Text(app.name).font(.caption).lineLimit(1)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .contextMenu { WebAppMenu(app: app) }
                    .accessibilityLabel("Open web app \(app.name)")
                }
            }
            .padding(.vertical, Layout.gap)
            .padding(.horizontal, Layout.tight)
            .glassEffect(.regular, in: .rect(cornerRadius: Layout.cardRadius))
        }
    }
}

struct WebAppMenu: View {
    @Environment(BrowserStore.self) private var store
    let app: WebApp
    var body: some View {
        Button { WebAppPresenter.shared.open(app, store: store) } label: { Label("Open", systemImage: "arrow.up.forward.app") }
        Button {
            if let u = app.start { store.newTab(url: u) }
        } label: { Label("Open in Browser Tab", systemImage: "safari") }
        Button(role: .destructive) {
            WebAppPresenter.shared.forget(app.id)
            WebAppStore.shared.remove(app)
        } label: { Label("Remove", systemImage: "trash") }
    }
}

// MARK: - Settings › Web Apps

struct WebAppsList: View {
    @Environment(BrowserStore.self) private var store
    @State private var renaming: WebApp?
    @State private var newName = ""
    @State private var isDefault: Bool?

    var body: some View {
        List {
            Section {
                ForEach(WebAppStore.shared.apps) { app in
                    Button { WebAppPresenter.shared.open(app, store: store) } label: {
                        HStack(spacing: Layout.gap) {
                            WebAppIcon(image: WebAppStore.shared.icon(for: app), name: app.name, size: Layout.iconTile)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(app.name).foregroundStyle(.primary)
                                Text(app.host).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let space = store.spaces.first(where: { $0.id == app.spaceID }), store.spaces.count > 1 {
                                Text(space.name).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button("Remove", role: .destructive) {
                            WebAppPresenter.shared.forget(app.id)
                            WebAppStore.shared.remove(app)
                        }
                        Button("Rename") { newName = app.name; renaming = app }.tint(.indigo)
                    }
                }
            } footer: {
                if WebAppStore.shared.apps.isEmpty {
                    Text("On any page: menu › Share › Save as Web App.")
                } else {
                    Text("Web apps open full screen inside UrAnus Browser with the logins of the Space you saved them from, and the Algorithm Diet tracks them like the browser.")
                }
            }
            Section {
                if WebAppHomeScreen.available {
                    LabeledContent("Default browser", value: isDefault.map { $0 ? "UrAnus Browser" : "Another app" } ?? "Unknown")
                    if isDefault != true {
                        Button { if let u = URL(string: UIApplication.openDefaultApplicationsSettingsURLString) { UIApplication.shared.open(u) } } label: {
                            Label("Make UrAnus Browser the Default Browser", systemImage: "safari")
                        }
                    }
                }
                Button { if let u = URL(string: "shortcuts://") { UIApplication.shared.open(u) } } label: {
                    Label("Add to Home Screen with Shortcuts", systemImage: "square.grid.3x3.square")
                }
            } header: {
                Text("Home Screen")
            } footer: {
                if WebAppHomeScreen.available {
                    Text("In a web app: … › Add to Home Screen. The icon opens the app full screen here, tracked by the Algorithm Diet, as long as UrAnus Browser is your default browser.")
                } else {
                    Text("Home Screen icons like Safari's need Apple's browser permission (requested). Until then: Shortcuts › + › Open Web App › pick the app › Add to Home Screen.")
                }
            }
        }
        .environment(\.defaultMinListRowHeight, Layout.rowHeight)
        .task { if WebAppHomeScreen.available { isDefault = WebAppHomeScreen.isDefaultBrowser() } }
        .navigationTitle("Web Apps")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Rename Web App", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") { if let r = renaming { WebAppStore.shared.rename(r, to: newName) }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }
}
