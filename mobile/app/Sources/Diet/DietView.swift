import SwiftUI
import UniformTypeIdentifiers

/// Algorithm Diet: your browsing as a diet. Score, plate, nutrition facts, categories, days, sites, topics and a plan,
/// plus the animated classification run and the chat with your history.
struct DietView: View {
    @Environment(BrowserStore.self) private var store
    @State private var engine = DietEngine.shared
    @State private var importing = false
    @State private var chatting = false
    @State private var confirmErase = false
    @State private var showingHistory = false
    @State private var downloader = WoofDownloader()
    @State private var tracking = DietTracker.shared.enabled

    var body: some View {
        @Bindable var engine = engine
        NavigationStack {
            ZStack {
                background
                ScrollView {
                    VStack(spacing: Layout.gap) {
                        if !engine.loaded || engine.importing {
                            VStack(spacing: Layout.gap) {
                                ProgressView()
                                if engine.importing { Text("Importing your history…").font(.subheadline).foregroundStyle(.secondary) }
                            }
                            .padding(.top, 120)
                        } else if !engine.hasData {
                            emptyState
                        } else {
                            if !engine.classifiedOnce, !engine.isRunning, engine.visits.contains(where: { !$0.isMeasured }) { classifyHero }
                            Picker("Range", selection: $engine.range) {
                                ForEach(DietRange.allCases) { Text($0.title).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            if engine.stats.visits == 0 {
                                DietCard(title: "Nothing in this range") {
                                    Text("Pick a longer range, or browse a bit: pages you open here are added as you go.")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                }
                            } else {
                                scoreCard
                                consumptionCard
                                NutritionFacts(stats: engine.stats, range: engine.range)
                                categoriesCard
                                if engine.stats.days.count > 1 { daysCard }
                                sitesCard
                                if !engine.stats.topics.isEmpty { topicsCard }
                                planCard
                            }
                            modelCard
                        }
                        if !engine.hasData { modelCard }
                        footer
                    }
                    .padding(.horizontal, Layout.sheetInset)
                    .padding(.bottom, 120)
                }
                .scrollIndicators(.hidden)

                if let run = engine.run {
                    Color.black.opacity(0.35).ignoresSafeArea().transition(.opacity)
                    DietRunCard(run: run) { engine.cancelRun() }
                        .padding(.horizontal, Layout.sheetInset)
                        .transition(.scale(scale: 0.92).combined(with: .opacity))
                }
            }
            .animation(.smooth(duration: 0.35), value: engine.run != nil)
            .navigationTitle("Algorithm Diet")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { engine.isPresented = false } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close Algorithm Diet")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { chatting = true } label: { Image(systemName: "bubble.left.and.text.bubble.right.fill") }
                        .disabled(!engine.hasData)
                        .accessibilityLabel("Chat with history")
                    Menu {
                        Button { importing = true } label: { Label("Import History…", systemImage: "square.and.arrow.down") }
                        Button { engine.startRun() } label: { Label("Classify Again", systemImage: "wand.and.stars") }
                            .disabled(!engine.hasData || engine.isRunning)
                        Toggle(isOn: $tracking) { Label("Track Browsing", systemImage: "record.circle") }
                        Divider()
                        Button(role: .destructive) { confirmErase = true } label: { Label("Erase Diet Data", systemImage: "trash") }
                            .disabled(!engine.loaded || engine.importing)
                    } label: { Image(systemName: "ellipsis") }
                        .accessibilityLabel("Diet options")
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                guard case .success(let url) = result else { return }
                let ok = url.startAccessingSecurityScopedResource()
                defer { if ok { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url)
                    Task { await engine.importHistory(data) }
                } catch { engine.importMessage = "Couldn't read that history file: \(error.localizedDescription)" }
            }
            .confirmationDialog("Erase every visit and label?", isPresented: $confirmErase, titleVisibility: .visible) {
                Button("Erase Diet Data", role: .destructive) { engine.eraseAll() }
            } message: { Text("Your tabs and browser history are not touched.") }
            .sheet(isPresented: $chatting) { DietChatView().presentationDetents([.large]) }
            .sheet(isPresented: $showingHistory) { DietHistoryView().presentationDetents([.large]) }
            .onChange(of: tracking) { _, on in DietTracker.shared.enabled = on }
            .overlay(alignment: .bottom) {
                if let msg = engine.importMessage {
                    Text(msg).font(.subheadline.weight(.medium))
                        .padding(.horizontal, Layout.sheetInset).frame(height: Layout.control)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.bottom, Layout.edge)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .task { try? await Task.sleep(for: .seconds(3)); withAnimation { engine.importMessage = nil } }
                }
            }
            .animation(.smooth, value: engine.importMessage)
        }
        .task {
            await engine.loadIfNeeded()
            engine.refreshStats()
            if UserDefaults.standard.bool(forKey: "dietAutoRun"), engine.hasData, !engine.isRunning { engine.startRun() }
            if UserDefaults.standard.bool(forKey: "dietChat") { chatting = true }
        }
        .environment(\.openURL, OpenURLAction { url in
            store.commit(url.absoluteString, editing: false)
            engine.isPresented = false
            return .handled
        })
    }

    // MARK: background

    private var background: some View {
        ZStack(alignment: .top) {
            Color(.systemGroupedBackground)
            LinearGradient(colors: [engine.stats.grade.color.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: 420)
                .animation(.smooth(duration: 0.8), value: engine.stats.grade)
        }
        .ignoresSafeArea()
    }

    // MARK: states

    private var emptyState: some View {
        VStack(spacing: Layout.gap) {
            Image(systemName: "fork.knife")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 96, height: 96)
                .background(LinearGradient(colors: [NutriGrade.a.color, NutriGrade.c.color], startPoint: .topLeading, endPoint: .bottomTrailing), in: .circle)
                .padding(.top, 40)
            Text("You are what you browse").font(.title2.weight(.bold))
            Text("Pages and videos you open in Uranus Browser are sorted into a diet and scored A to E, all on this device. Private tabs are never recorded.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button { engine.isPresented = false } label: {
                Label("Start browsing", systemImage: "globe")
                    .font(.headline).frame(maxWidth: .infinity).frame(height: Layout.fieldHeight)
            }
            .buttonStyle(.glassProminent)
            Text("Tracking and classification happen automatically as you browse. Importing desktop history is optional.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Import past history…") { importing = true }.font(.subheadline)
        }
        .padding(.horizontal, Layout.gap)
    }

    private var classifyHero: some View {
        DietCard {
            HStack(spacing: Layout.gap) {
                Image(systemName: "wand.and.stars").font(.title2).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(engine.visits.count.formatted()) visits ready").font(.headline)
                    Text(engine.modelLabel.map { "Rules first, then \($0) for what they can't place." } ?? "Rules sort them on this device. Add Woof 2B below for the unknown ones.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Button { engine.startRun() } label: {
                Text("Classify my history").font(.headline).frame(maxWidth: .infinity).frame(height: Layout.control + 4)
            }
            .buttonStyle(.glassProminent)
            .tint(Theme.accent)
        }
    }

    // MARK: cards

    private var consumptionCard: some View {
        let stats = engine.stats
        return DietCard(title: "Your consumption", subtitle: "\(engine.range.title) · this browser and imported history") {
            LabeledContent("Measured browsing", value: stats.measuredSeconds.dietDuration)
            LabeledContent("Estimated from imports", value: stats.estimatedSeconds.dietDuration)
            LabeledContent("Video playback", value: stats.watchSeconds.dietDuration)
            Text("Playback follows the video's clock, so 2× speed adds 2× playback. Imported history has no watch-time measurement.")
                .font(.caption).foregroundStyle(.secondary)
            Button { showingHistory = true } label: {
                Label("Explore pages & videos", systemImage: "list.bullet.rectangle").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
    }

    private var scoreCard: some View {
        let s = engine.stats
        return DietCard {
            HStack(alignment: .center, spacing: Layout.sheetInset) {
                DietPlate(slices: s.slices, health: s.health, grade: s.grade)
                    .frame(width: 140, height: 140)
                VStack(alignment: .leading, spacing: 6) {
                    Text(s.grade.verdict).font(.title2.weight(.bold))
                    Text("\(s.seconds.dietDuration) · \(s.visits.formatted()) pages").font(.subheadline).foregroundStyle(.secondary)
                    if let top = s.slices.first {
                        Label("Mostly \(top.category.title.lowercased())", systemImage: top.category.symbol)
                            .font(.caption.weight(.semibold)).foregroundStyle(top.category.color)
                    }
                }
                Spacer(minLength: 0)
            }
            DietScoreStrip(grade: s.grade)
        }
    }

    private var categoriesCard: some View {
        DietCard(title: "On your plate", subtitle: "Time by category") {
            ForEach(engine.stats.slices.prefix(9)) { slice in
                HStack(spacing: Layout.gap) {
                    IconTile(symbol: slice.category.symbol, color: slice.category.color)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(slice.category.title).font(.subheadline.weight(.medium))
                            Spacer()
                            Text(slice.seconds.dietDuration).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        GeometryReader { g in
                            Capsule().fill(slice.category.color.gradient)
                                .frame(width: max(4, g.size.width * slice.share))
                        }
                        .frame(height: 6)
                    }
                    GradeChip(grade: slice.nutrients.grade)
                }
            }
        }
    }

    private var daysCard: some View {
        let days = Array(engine.stats.days.suffix(14))
        let peak = days.map(\.seconds).max() ?? 1
        return DietCard(title: "Day by day", subtitle: "Bar height is time, colour is the day's grade") {
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(days) { d in
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(d.nutrients.grade.color.gradient)
                            .frame(height: max(6, 96 * d.seconds / peak))
                        Text(d.day.formatted(.dateTime.weekday(.narrow))).font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 120, alignment: .bottom)
        }
    }

    private var sitesCard: some View {
        DietCard(title: "Top sites") {
            ForEach(engine.stats.sites.prefix(8)) { site in
                HStack(spacing: Layout.gap) {
                    SiteIcon(host: site.host)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(site.host).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text("\(site.category.title) · \(site.visits) visits").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(site.seconds.dietDuration).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                    GradeChip(grade: site.nutrients.grade)
                }
            }
        }
    }

    private var topicsCard: some View {
        DietCard(title: "Ingredients", subtitle: "Topics from what you learned, searched and watched") {
            DietFlow {
                ForEach(Array(engine.stats.topics.prefix(18).enumerated()), id: \.offset) { i, t in
                    Text(t.0)
                        .font(.subheadline.weight(i < 3 ? .semibold : .regular))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Theme.accent.opacity(i < 3 ? 0.22 : 0.1), in: .capsule)
                }
            }
        }
    }

    private var planCard: some View {
        DietCard(title: "Your diet plan", subtitle: "Swap half the time for learning and see your grade") {
            if engine.stats.swaps.isEmpty {
                Label("Nothing junky enough to cut. Keep it up.", systemImage: "checkmark.seal.fill")
                    .font(.subheadline).foregroundStyle(NutriGrade.a.color)
            }
            ForEach(engine.stats.swaps) { swap in
                HStack(spacing: Layout.gap) {
                    IconTile(symbol: swap.cut.symbol, color: swap.cut.color)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Halve \(swap.cut.title.lowercased())").font(.subheadline.weight(.medium))
                        Text("\(swap.cutSeconds.dietDuration) less").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    GradeChip(grade: swap.from)
                    Image(systemName: "arrow.right").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    GradeChip(grade: swap.to)
                }
            }
        }
    }

    @ViewBuilder private var modelCard: some View {
        DietCard(title: "On-device model", subtitle: "Underdog Woof 2B 1.1 · Apache-2.0 · private inference") {
            #if targetEnvironment(simulator)
            HStack(spacing: Layout.gap) {
                Image(systemName: engine.modelLabel == nil ? "bolt.horizontal.circle" : "bolt.horizontal.circle.fill")
                    .foregroundStyle(engine.modelLabel == nil ? Color.secondary : NutriGrade.a.color)
                Text(engine.modelLabel ?? "Simulator: start mobile/app/Tools/woof-bridge.sh on this Mac.")
                    .font(.subheadline)
                Spacer()
                Button("Check") { Task { await engine.refreshModel() } }.buttonStyle(.bordered)
            }
            #else
            switch downloader.state {
            case .done:
                Label("Woof 2B is on this iPhone", systemImage: "checkmark.circle.fill").foregroundStyle(NutriGrade.a.color)
                    .task { await engine.refreshModel() }
                TimelineView(.periodic(from: .now, by: 2)) { _ in
                    if let stats = ModelLog.last {
                        Text("Last answer: \(stats.summary)" + (ModelLog.asked > 0 ? " · sorted \(ModelLog.parsed) of \(ModelLog.asked)" : ""))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            case .downloading, .verifying:
                DietProgressBar(fraction: downloader.progress, height: 12)
                HStack {
                    Text(downloader.state == .verifying ? "Checking the file…"
                         : "\(ByteCountFormatter.string(fromByteCount: downloader.received, countStyle: .file)) of 1.56 GB")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    if downloader.state == .downloading { Button("Pause") { downloader.cancel() }.font(.caption) }
                }
            case .idle, .failed:
                if case .failed(let why) = downloader.state { Text(why).font(.caption).foregroundStyle(.red) }
                Text("Sorts sites the rules don't know and answers your questions. Without it, rules and quick answers still work.")
                    .font(.caption).foregroundStyle(.secondary)
                Button { downloader.start() } label: {
                    Label("Download Woof 2B (1.56 GB)", systemImage: "arrow.down.circle.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .task { if UserDefaults.standard.bool(forKey: "dietDownload") { downloader.start() } }
            }
            #endif
        }
    }

    private var footer: some View {
        Text("Analysis stays local. Pages opened here are recorded and classified automatically; private tabs are excluded. Separate apps and Home Screen web apps cannot be monitored. Open their links here with the Open in Uranus Browser Shortcuts action to include them. Video topics come from available page text, not hidden video content.")
            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            .padding(.top, Layout.gap)
    }
}

/// The run in progress: phase, animated bar, the item just sorted, and the A-E counters.
struct DietRunCard: View {
    var run: DietEngine.Run
    var stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.phase).font(.headline).contentTransition(.opacity)
                    Text(run.detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary).contentTransition(.numericText())
                }
                Spacer()
                Text("\(Int((run.fraction * 100).rounded()))%")
                    .font(.system(size: 28, weight: .heavy, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText(value: run.fraction))
            }
            DietProgressBar(fraction: run.fraction)
            ZStack {
                if let t = run.tick {
                    HStack(spacing: 10) {
                        GradeChip(grade: t.grade, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(t.title).font(.subheadline.weight(.medium)).lineLimit(1)
                            HStack(spacing: 4) {
                                Text(t.host).lineLimit(1)
                                Image(systemName: "arrow.right")
                                Image(systemName: t.category.symbol).foregroundStyle(t.category.color)
                                Text(t.category.title).foregroundStyle(t.category.color)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .id(t.id)
                    .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity),
                                            removal: .move(edge: .top).combined(with: .opacity)))
                }
            }
            .frame(height: 42)
            .clipped()
            .animation(.smooth(duration: 0.28), value: run.tick?.id)
            GradeBuckets(counts: run.counts)
            HStack {
                if run.usedModel {
                    Label("Woof 2B is thinking locally", systemImage: "cpu").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Stop", action: stop).font(.subheadline.weight(.medium))
            }
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 30))
        .shadow(color: .black.opacity(0.25), radius: 30, y: 12)
        .animation(.smooth(duration: 0.3), value: run.phase)
    }
}

/// A nutrition-label card: the period's average nutrients per hour of browsing.
struct NutritionFacts: View {
    var stats: DietStats
    var range: DietRange
    @State private var shown = false

    var body: some View {
        let n = stats.nutrients
        let rows: [(String, String, Double, Bool)] = [
            ("Protein", "learning", n.protein, true), ("Fiber", "depth & focus", n.fiber, true),
            ("Vitamins", "culture & people", n.vitamins, true), ("Sugar", "quick hits", n.sugar, false),
            ("Salt", "outrage & anxiety", n.salt, false), ("Fat", "endless feeds", n.fat, false),
        ]
        VStack(alignment: .leading, spacing: 0) {
            Text("Nutrition Facts").font(.system(size: 28, weight: .black))
            Text("Time-weighted points, 0–10 · \(range.title.lowercased())").font(.caption.weight(.semibold))
            Rectangle().frame(height: 8).padding(.vertical, 6)
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                HStack(spacing: 10) {
                    Text(r.0).font(.subheadline.weight(.bold)).frame(width: 74, alignment: .leading)
                    Text(r.1).font(.caption).foregroundStyle(.secondary).frame(width: 104, alignment: .leading)
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.primary.opacity(0.07))
                            Capsule().fill((r.3 ? NutriGrade.a.color : NutriGrade.e.color).gradient)
                                .frame(width: shown ? g.size.width * r.2 / 10 : 0)
                        }
                    }
                    .frame(height: 8)
                    Text(String(format: "%.1f", r.2)).font(.caption.weight(.semibold).monospacedDigit()).frame(width: 38, alignment: .trailing)
                }
                .padding(.vertical, 7)
                if i == 2 { Rectangle().frame(height: 4).padding(.vertical, 2) } else if i < 5 { Divider() }
            }
            Rectangle().frame(height: 8).padding(.top, 6)
            Text("Score = sugar + salt + fat − protein − fiber − vitamins = \(String(format: "%+.1f", n.points)) → \(stats.grade.rawValue)")
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary).padding(.top, 6)
            Text("A ≤ −12 · B ≤ −4 · C ≤ 4 · D ≤ 12 · E > 12. Category, title and session length affect the points. This is a browsing reflection score, inspired by food labels; it is not the official food Nutri-Score.")
                .font(.caption2).foregroundStyle(.secondary).padding(.top, 6)
        }
        .padding(Layout.sheetInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: .rect(cornerRadius: Layout.cardRadius))
        .onAppear { withAnimation(.spring(response: 0.8, dampingFraction: 0.8).delay(0.15)) { shown = true } }
        .animation(.smooth(duration: 0.6), value: n)
    }
}
