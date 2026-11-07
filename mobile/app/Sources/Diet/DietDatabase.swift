import Foundation
import SQLite3

/// The Algorithm Diet's own store: `Application Support/diet/diet.sqlite`, never synced and never sent anywhere.
/// Visits (live and imported) plus what the on-device model said about sites and titles the rules couldn't place.
/// Private tabs are never written here.
final class DietDatabase: @unchecked Sendable {
    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "dev.oprimo.flecha.diet.db")

    static var directory: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("diet")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    init(url: URL = DietDatabase.directory.appendingPathComponent("diet.sqlite")) {
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            db = nil
            return
        }
        exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        exec("""
        CREATE TABLE IF NOT EXISTS visits(
          id INTEGER PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, title TEXT NOT NULL, at REAL NOT NULL,
          seconds REAL NOT NULL DEFAULT 0, watch REAL NOT NULL DEFAULT 0, description TEXT, channel TEXT, excerpt TEXT,
          source TEXT NOT NULL, UNIQUE(url, at, source));
        CREATE INDEX IF NOT EXISTS visits_at ON visits(at);
        CREATE TABLE IF NOT EXISTS host_hints(host TEXT PRIMARY KEY, category TEXT NOT NULL, method TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS title_hints(key TEXT PRIMARY KEY, category TEXT NOT NULL, method TEXT NOT NULL);
        """)
        // Existing installations keep their history when gaining bounded content excerpts.
        var hasExcerpt = false
        query("PRAGMA table_info(visits)") { s in if Self.text(s, 1) == "excerpt" { hasExcerpt = true } }
        if !hasExcerpt { exec("ALTER TABLE visits ADD COLUMN excerpt TEXT") }
        var directory = url.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
    }

    deinit { sqlite3_close(db) }

    // MARK: visits

    func allVisits() -> [DietVisit] {
        queue.sync {
            var out: [DietVisit] = []
            query("SELECT id,url,host,title,at,seconds,watch,description,channel,source,excerpt FROM visits ORDER BY at") { s in
                out.append(DietVisit(id: sqlite3_column_int64(s, 0), url: Self.text(s, 1), host: Self.text(s, 2), title: Self.text(s, 3),
                                     at: Date(timeIntervalSince1970: sqlite3_column_double(s, 4)), seconds: sqlite3_column_double(s, 5),
                                     watchSeconds: sqlite3_column_double(s, 6), description: Self.optText(s, 7),
                                     channel: Self.optText(s, 8), excerpt: Self.optText(s, 10), source: Self.text(s, 9)))
            }
            return out
        }
    }

    /// Inserts visits (duplicates by url + time + source are skipped). Returns them with their new ids.
    @discardableResult
    func insert(_ visits: [DietVisit]) -> [DietVisit] {
        queue.sync {
            var out: [DietVisit] = []
            exec("BEGIN")
            let sql = "INSERT OR IGNORE INTO visits(url,host,title,at,seconds,watch,description,channel,source,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?)"
            var stmt: OpaquePointer?
            sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
            for var v in visits {
                sqlite3_reset(stmt)
                bind(stmt, 1, v.url); bind(stmt, 2, v.host); bind(stmt, 3, v.title)
                sqlite3_bind_double(stmt, 4, v.at.timeIntervalSince1970)
                sqlite3_bind_double(stmt, 5, v.seconds); sqlite3_bind_double(stmt, 6, v.watchSeconds)
                bind(stmt, 7, v.description); bind(stmt, 8, v.channel); bind(stmt, 9, v.source)
                bind(stmt, 10, v.excerpt)
                if sqlite3_step(stmt) == SQLITE_DONE, sqlite3_changes(db) > 0 {
                    v.id = sqlite3_last_insert_rowid(db)
                    out.append(v)
                }
            }
            sqlite3_finalize(stmt)
            exec("COMMIT")
            return out
        }
    }

    /// Live visits grow while you stay on the page; the title and page details arrive a moment after the load.
    func update(_ v: DietVisit) {
        queue.sync {
            var stmt: OpaquePointer?
            sqlite3_prepare_v2(db, "UPDATE visits SET title=?, seconds=?, watch=?, description=?, channel=?, excerpt=? WHERE id=?", -1, &stmt, nil)
            bind(stmt, 1, v.title); sqlite3_bind_double(stmt, 2, v.seconds); sqlite3_bind_double(stmt, 3, v.watchSeconds)
            bind(stmt, 4, v.description); bind(stmt, 5, v.channel); bind(stmt, 6, v.excerpt); sqlite3_bind_int64(stmt, 7, v.id)
            sqlite3_step(stmt)
            sqlite3_finalize(stmt)
        }
    }

    func deleteAll() {
        queue.sync { exec("DELETE FROM visits; DELETE FROM host_hints; DELETE FROM title_hints;") }
    }

    // MARK: model hints

    func hints() -> (hosts: [String: DietCategory], titles: [String: DietCategory]) {
        queue.sync {
            var hosts: [String: DietCategory] = [:], titles: [String: DietCategory] = [:]
            query("SELECT host, category FROM host_hints") { s in hosts[Self.text(s, 0)] = DietCategory(rawValue: Self.text(s, 1)) }
            query("SELECT key, category FROM title_hints") { s in titles[Self.text(s, 0)] = DietCategory(rawValue: Self.text(s, 1)) }
            return (hosts, titles)
        }
    }

    func saveHints(hosts: [String: DietCategory] = [:], titles: [String: DietCategory] = [:], method: String = "woof") {
        queue.sync {
            exec("BEGIN")
            for (table, rows) in [("host_hints(host", hosts), ("title_hints(key", titles)] {
                var stmt: OpaquePointer?
                sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO \(table),category,method) VALUES(?,?,?)", -1, &stmt, nil)
                for (k, c) in rows {
                    sqlite3_reset(stmt)
                    bind(stmt, 1, k); bind(stmt, 2, c.rawValue); bind(stmt, 3, method)
                    sqlite3_step(stmt)
                }
                sqlite3_finalize(stmt)
            }
            exec("COMMIT")
        }
    }

    // MARK: sqlite plumbing

    private func exec(_ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }

    private func query(_ sql: String, _ row: (OpaquePointer) -> Void) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { return }
        while sqlite3_step(stmt) == SQLITE_ROW { row(stmt) }
        sqlite3_finalize(stmt)
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func bind(_ stmt: OpaquePointer?, _ i: Int32, _ s: String?) {
        if let s { sqlite3_bind_text(stmt, i, s, -1, Self.transient) } else { sqlite3_bind_null(stmt, i) }
    }

    private static func text(_ s: OpaquePointer, _ i: Int32) -> String {
        sqlite3_column_text(s, i).map { String(cString: $0) } ?? ""
    }

    private static func optText(_ s: OpaquePointer, _ i: Int32) -> String? {
        sqlite3_column_type(s, i) == SQLITE_NULL ? nil : text(s, i)
    }
}
