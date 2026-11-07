import XCTest

/// The real "Save as Web App" flow, tapped like a person would: page menu › Share › Save as Web App › Add and Open,
/// then the web app's menu › Close, and the app on the new tab page. Runs on a device or a Simulator with network:
///   xcodebuild test -project Flecha.xcodeproj -scheme Flecha -destination "platform=iOS Simulator,name=iPhone 17 Pro" CODE_SIGNING_ALLOWED=NO
final class WebAppUITests: XCTestCase {
    func testSaveAsWebAppFromShareSheet() throws {
        let app = XCUIApplication()
        let site = ProcessInfo.processInfo.environment["WEBAPP_SITE"] ?? "https://squoosh.app"
        app.launchArguments = ["-webAppPage", site]
        app.launch()

        let menu = app.buttons["pageMenu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20))
        sleep(6)   // let the page load (the save sheet reads its manifest)
        menu.tap()

        let share = app.buttons["Share"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.tap()

        let save = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Save as Web App")).firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 10), "share sheet has no Save as Web App action")
        save.tap()

        let addOpen = app.buttons["Add and Open"]
        XCTAssertTrue(addOpen.waitForExistence(timeout: 20), "save sheet did not finish reading the site")
        let name = app.textFields["Name"].value as? String ?? ""
        XCTAssertFalse(name.isEmpty)
        attach(app, "save-sheet")
        addOpen.tap()

        let bubble = app.buttons["\(name) menu"]
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "web app did not open")
        sleep(12)   // two Diet samples
        attach(app, "web-app-running")
        bubble.tap()
        let close = app.buttons["Close \(name)"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(bubble.waitForNonExistence(timeout: 5))

        // Saved for good: after a relaunch the new tab page lists it, and tapping it opens it again.
        app.terminate()
        app.launchArguments = ["-webAppBlank", "1"]
        app.launch()
        let tile = app.buttons["Open web app \(name)"]
        XCTAssertTrue(tile.waitForExistence(timeout: 15), "new tab page does not list the saved web app")
        attach(app, "new-tab-grid")
        tile.tap()
        XCTAssertTrue(app.buttons["\(name) menu"].waitForExistence(timeout: 10))
    }

    /// YouTube and Instagram get native bars: the tabs exist, and tapping one moves the site there.
    func testNativeBarsForYouTubeAndInstagram() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-webAppTest", "https://m.youtube.com"]
        app.launch()
        let shorts = app.buttons["chrome-tab-shorts"]
        XCTAssertTrue(shorts.waitForExistence(timeout: 30), "YouTube tab bar missing")
        XCTAssertTrue(app.buttons["chrome-menu"].waitForExistence(timeout: 5), "menu button missing")
        sleep(4)
        attach(app, "youtube-home")
        shorts.tap()
        let selected = NSPredicate(format: "isSelected == true")
        expectation(for: selected, evaluatedWith: shorts)
        waitForExpectations(timeout: 5)
        sleep(6)
        attach(app, "youtube-shorts")

        app.terminate()
        app.launchArguments = ["-webAppTest", "https://www.instagram.com"]
        app.launch()
        XCTAssertTrue(app.buttons["chrome-tab-reels"].waitForExistence(timeout: 30), "Instagram tab bar missing")
        sleep(6)
        attach(app, "instagram")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
