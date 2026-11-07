import Foundation

/// The hand-written knowledge the classifier starts from. Unknown sites go to the on-device model.
enum DietRules {
    // MARK: domains (host without www./m.; a parent domain matches its subdomains)

    static let domains: [String: DietCategory] = {
        var d: [String: DietCategory] = [:]
        func add(_ c: DietCategory, _ hosts: [String]) { for h in hosts { d[h] = c } }

        add(.learning, [
            "wikipedia.org", "wikibooks.org", "wikihow.com", "britannica.com", "khanacademy.org", "coursera.org",
            "edx.org", "udemy.com", "udacity.com", "brilliant.org", "duolingo.com", "codecademy.com", "freecodecamp.org",
            "w3schools.com", "developer.mozilla.org", "mdn.io", "geeksforgeeks.org", "tutorialspoint.com", "realpython.com",
            "docs.python.org", "developer.apple.com", "swift.org", "learn.microsoft.com", "docs.microsoft.com",
            "react.dev", "nextjs.org", "vuejs.org", "svelte.dev", "tailwindcss.com", "kotlinlang.org", "rust-lang.org",
            "doc.rust-lang.org", "go.dev", "typescriptlang.org", "nodejs.org", "pytorch.org", "tensorflow.org",
            "scikit-learn.org", "numpy.org", "pandas.pydata.org", "huggingface.co", "kaggle.com", "deepwiki.com",
            "readthedocs.io", "readthedocs.org", "docs.github.com", "stackoverflow.com", "stackexchange.com",
            "superuser.com", "serverfault.com", "askubuntu.com", "mathworld.wolfram.com", "wolframalpha.com",
            "ted.com", "masterclass.com", "skillshare.com", "nptel.ac.in", "ocw.mit.edu", "3blue1brown.com",
            "betterexplained.com", "quizlet.com", "anki.net", "ankiweb.net", "docs.anthropic.com", "docs.claude.com",
            "platform.openai.com", "cookbook.openai.com", "supabase.com/docs", "docs.supabase.com", "vercel.com/docs",
            "langchain.com", "python.langchain.com", "docs.expo.dev", "reactnative.dev", "docs.docker.com",
            "kubernetes.io", "learngitbranching.js.org", "git-scm.com", "regex101.com", "leetcode.com",
            "hackerrank.com", "exercism.org", "chessable.com", "lichess.org/study", "vvz.ethz.ch", "moodle.ethz.ch",
            "lehrbetrieb.ethz.ch", "ethz.ch", "epfl.ch", "uzh.ch", "mit.edu", "stanford.edu", "harvard.edu",
            "berkeley.edu", "ox.ac.uk", "cam.ac.uk", "distill.pub", "colah.github.io", "karpathy.ai", "fast.ai",
        ])
        add(.research, [
            "arxiv.org", "alphaxiv.org", "openreview.net", "scholar.google.com", "semanticscholar.org", "pubmed.ncbi.nlm.nih.gov",
            "ncbi.nlm.nih.gov", "nature.com", "science.org", "sciencedirect.com", "springer.com", "link.springer.com",
            "wiley.com", "onlinelibrary.wiley.com", "ieee.org", "ieeexplore.ieee.org", "acm.org", "dl.acm.org",
            "jstor.org", "researchgate.net", "biorxiv.org", "medrxiv.org", "ssrn.com", "paperswithcode.com",
            "neurips.cc", "icml.cc", "iclr.cc", "aclanthology.org", "aclweb.org", "cvpr.thecvf.com", "openaccess.thecvf.com",
            "proceedings.mlr.press", "papers.nips.cc", "connectedpapers.com", "elicit.com", "consensus.app",
            "zotero.org", "overleaf.com", "pnas.org", "cell.com", "thelancet.com", "nejm.org", "plos.org", "frontiersin.org",
            "mdpi.com", "tandfonline.com", "sagepub.com", "academic.oup.com", "cambridge.org", "doi.org", "lesswrong.com",
            "alignmentforum.org", "transformer-circuits.pub", "epochai.org",
        ])
        add(.building, [
            "github.com", "gist.github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org", "github.io",
            "vercel.com", "vercel.app", "netlify.com", "netlify.app", "render.com", "onrender.com", "heroku.com",
            "herokuapp.com", "fly.io", "railway.app", "supabase.com", "supabase.co", "firebase.google.com",
            "console.firebase.google.com", "console.cloud.google.com", "cloud.google.com", "aws.amazon.com",
            "console.aws.amazon.com", "portal.azure.com", "azure.microsoft.com", "cloud.mongodb.com", "mongodb.com",
            "weaviate.cloud", "console.weaviate.cloud", "pinecone.io", "cloudflare.com", "dash.cloudflare.com",
            "digitalocean.com", "hostinger.com", "hpanel.hostinger.com", "godaddy.com", "namecheap.com", "porkbun.com",
            "npmjs.com", "pypi.org", "crates.io", "pkg.go.dev", "hub.docker.com", "docker.com", "codepen.io",
            "codesandbox.io", "replit.com", "stackblitz.com", "jsfiddle.net", "lovable.dev", "bolt.new", "v0.dev",
            "cursor.com", "cursor.sh", "appstoreconnect.apple.com", "developer.android.com", "play.google.com/console",
            "testflight.apple.com", "expo.dev", "sentry.io", "posthog.com", "app.posthog.com", "datadoghq.com",
            "grafana.com", "postman.com", "swagger.io", "figma.com", "framer.com", "webflow.com", "dribbble.com",
            "behance.net", "canva.com", "freepik.com", "unsplash.com", "fonts.google.com", "lucide.dev", "shadcn.com",
            "ui.shadcn.com", "elevenlabs.io", "replicate.com", "together.ai", "groq.com", "console.groq.com",
            "console.anthropic.com", "platform.claude.com", "openrouter.ai", "modal.com", "runpod.io", "lambdalabs.com",
            "wandb.ai", "colab.research.google.com", "stripe.com", "dashboard.stripe.com", "auth0.com", "clerk.com",
            "twilio.com", "sendgrid.com", "resend.com", "mailgun.com", "linear.app", "jira.atlassian.com", "localhost",
            "127.0.0.1", "0.0.0.0", "ngrok.io", "ngrok-free.app", "ngrok.app", "openscreen.io", "typeform.com",
            "admin.typeform.com", "charts.mongodb.com", "searchconsole.google.com", "search.google.com", "analytics.google.com",
            "tagmanager.google.com", "dashboard.render.com", "app.netlify.com", "smithery.ai", "mcp.so",
            "dev.azure.com", "d3js.org", "mermaid.js.org", "observablehq.com", "ollama.com", "warp.dev", "jupyter.org",
            "tinker-console.thinkingmachines.ai", "thinkingmachines.ai", "beta.hume.ai", "hume.ai", "omi.me", "app.omi.me",
            "portal.startups.microsoft.com", "labs.google", "excalidraw.com", "tldraw.com", "draw.io", "app.diagrams.net",
        ])
        add(.work, [
            "docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com", "calendar.google.com",
            "mail.google.com", "gmail.com", "keep.google.com", "forms.google.com", "sites.google.com", "notion.so",
            "notion.site", "app.notion.com", "notion.com", "office.com", "office365.com", "outlook.live.com",
            "outlook.office.com", "outlook.office365.com", "sharepoint.com", "onedrive.live.com", "teams.microsoft.com",
            "teams.cloud.microsoft", "microsoft365.com", "dropbox.com", "box.com", "airtable.com", "asana.com",
            "trello.com", "monday.com", "clickup.com", "atlassian.net", "confluence.atlassian.com", "miro.com",
            "calendly.com", "cal.com", "docusign.com", "docusign.net", "lumin.com", "luminpdf.com", "smallpdf.com",
            "ilovepdf.com", "zoho.com", "hubspot.com", "salesforce.com", "pipedrive.com", "intercom.com", "zendesk.com",
            "webprint.ethz.ch", "webprint-staff.ethz.ch", "mytum.de", "applicants.cordademocracy.org", "swapcard.com",
            "app.swapcard.com", "wetransfer.com", "kahoot.it", "create.kahoot.it", "eventbrite.com", "luma.com", "lu.ma", "doodle.com", "deepl.com/write", "grammarly.com",
            "1password.com", "bitwarden.com", "icloud.com", "apple.com/account", "fastmail.com", "proton.me", "mail.proton.me",
        ])
        add(.ai, [
            "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "bard.google.com", "perplexity.ai",
            "copilot.microsoft.com", "poe.com", "character.ai", "chat.mistral.ai", "chat.deepseek.com", "deepseek.com",
            "grok.com", "x.ai", "you.com", "phind.com", "huggingface.co/chat", "notebooklm.google.com", "aistudio.google.com",
            "chat.qwen.ai", "kimi.com", "meta.ai", "pi.ai", "suno.com", "udio.com", "midjourney.com", "ideogram.ai",
            "runwayml.com", "pika.art", "leonardo.ai", "krea.ai", "app.klingai.com", "klingai.com", "sora.com",
        ])
        add(.communication, [
            "web.whatsapp.com", "whatsapp.com", "web.telegram.org", "telegram.org", "messenger.com", "discord.com",
            "slack.com", "app.slack.com", "meet.google.com", "zoom.us", "signal.org", "teams.live.com", "skype.com",
            "chat.google.com", "beeper.com", "facetime.apple.com", "webex.com", "whereby.com",
        ])
        add(.reference, [
            "google.com", "google.ch", "google.de", "google.co.uk", "bing.com", "duckduckgo.com", "search.brave.com",
            "ecosia.org", "startpage.com", "kagi.com", "yahoo.com", "maps.google.com", "maps.apple.com",
            "openstreetmap.org", "translate.google.com", "deepl.com", "dict.cc", "leo.org", "linguee.com",
            "merriam-webster.com", "dictionary.com", "thesaurus.com", "cambridge.org/dictionary", "oxforddictionaries.com",
            "timeanddate.com", "weather.com", "meteoswiss.admin.ch", "accuweather.com", "speedtest.net", "archive.org",
            "web.archive.org", "sbb.ch", "google.com/maps",
        ])
        add(.news, [
            "nytimes.com", "washingtonpost.com", "theguardian.com", "bbc.com", "bbc.co.uk", "cnn.com", "foxnews.com",
            "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com", "economist.com", "politico.com",
            "axios.com", "theverge.com", "techcrunch.com", "wired.com", "arstechnica.com", "engadget.com", "theinformation.com",
            "news.ycombinator.com", "nzz.ch", "20min.ch", "blick.ch", "srf.ch", "tagesanzeiger.ch", "watson.ch",
            "spiegel.de", "zeit.de", "faz.net", "sueddeutsche.de", "tagesschau.de", "welt.de", "bild.de", "handelsblatt.com",
            "lemonde.fr", "elpais.com", "aljazeera.com", "npr.org", "nbcnews.com", "cbsnews.com", "abcnews.go.com",
            "usatoday.com", "latimes.com", "time.com", "newsweek.com", "businessinsider.com", "cnbc.com", "forbes.com",
            "fortune.com", "vox.com", "semafor.com", "news.google.com", "heise.de", "golem.de", "9to5mac.com", "macrumors.com",
            "theatlantic.com", "newyorker.com", "telex.hu", "index.hu", "444.hu", "hvg.hu", "24.hu", "origo.hu",
        ])
        add(.culture, [
            "medium.com", "substack.com", "paulgraham.com", "stratechery.com", "aeon.co", "longreads.com",
            "goodreads.com", "gutenberg.org", "audible.com", "kindle.amazon.com", "read.amazon.com", "blinkist.com",
            "wattpad.com", "ao3.org", "archiveofourown.org", "poetryfoundation.org", "moma.org", "artsy.net",
            "letterboxd.com", "imdb.com", "rottentomatoes.com", "podcasts.apple.com", "pocketcasts.com", "overcast.fm",
            "lexfridman.com", "dwarkesh.com", "marginalrevolution.com", "astralcodexten.com", "slatestarcodex.com",
            "gwern.net", "waitbutwhy.com", "every.to", "lennysnewsletter.com", "readwise.io", "pocket.com", "instapaper.com",
            "openculture.com", "brainpickings.org", "themarginalian.org", "quantamagazine.org", "nautil.us",
            "scientificamerican.com", "newscientist.com", "smithsonianmag.com", "nationalgeographic.com",
        ])
        add(.music, [
            "open.spotify.com", "spotify.com", "music.apple.com", "music.youtube.com", "soundcloud.com", "bandcamp.com",
            "tidal.com", "deezer.com", "last.fm", "genius.com", "shazam.com", "radio.garden", "mixcloud.com",
        ])
        add(.video, [
            "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "kick.com", "rumble.com", "loom.com",
            "bilibili.com", "nebula.tv", "curiositystream.com",
        ])
        add(.streaming, [
            "netflix.com", "disneyplus.com", "primevideo.com", "hbomax.com", "max.com", "hulu.com", "tv.apple.com",
            "paramountplus.com", "peacocktv.com", "crunchyroll.com", "zattoo.com", "wilmaa.com", "joyn.de",
            "playsuisse.ch", "play.srf.ch", "plex.tv", "pluto.tv", "mubi.com",
        ])
        add(.social, [
            "x.com", "twitter.com", "facebook.com", "instagram.com", "linkedin.com", "reddit.com", "old.reddit.com",
            "threads.net", "threads.com", "bsky.app", "mastodon.social", "tumblr.com", "pinterest.com", "pinterest.ch",
            "snapchat.com", "quora.com", "9gag.com", "imgur.com", "vk.com", "weibo.com", "nextdoor.com", "producthunt.com",
            "indiehackers.com", "couchsurfing.com", "meetup.com", "tinder.com", "bumble.com", "hinge.co",
        ])
        add(.shortVideo, ["tiktok.com", "vm.tiktok.com", "triller.co", "likee.video"])
        add(.shopping, [
            "amazon.com", "amazon.de", "amazon.co.uk", "amazon.fr", "amazon.it", "amazon.es", "ebay.com", "ebay.de",
            "aliexpress.com", "temu.com", "shein.com", "etsy.com", "zalando.ch", "zalando.de", "galaxus.ch", "digitec.ch",
            "ricardo.ch", "tutti.ch", "brack.ch", "manor.ch", "migros.ch", "coop.ch", "ikea.com", "apple.com/shop",
            "store.apple.com", "bestbuy.com", "walmart.com", "target.com", "otto.de", "mediamarkt.ch", "mediamarkt.de",
            "decathlon.ch", "hm.com", "uniqlo.com", "zara.com", "nike.com", "adidas.com", "asos.com", "wish.com",
            "booking.com/deals", "locanto.ch", "anibis.ch", "kleinanzeigen.de", "vinted.com", "idealo.de", "toppreise.ch",
        ])
        add(.games, [
            "store.steampowered.com", "steamcommunity.com", "steampowered.com", "epicgames.com", "chess.com", "lichess.org",
            "roblox.com", "minecraft.net", "ign.com", "gamespot.com", "polygon.com", "itch.io", "poki.com", "crazygames.com",
            "nytimes.com/games", "wordle", "playstation.com", "xbox.com", "nintendo.com", "gog.com", "op.gg", "fandom.com",
        ])
        add(.finance, [
            "paypal.com", "revolut.com", "wise.com", "ubs.com", "credit-suisse.com", "postfinance.ch", "raiffeisen.ch",
            "zkb.ch", "neon-free.ch", "yuh.com", "n26.com", "chase.com", "bankofamerica.com", "coinbase.com", "binance.com",
            "kraken.com", "tradingview.com", "finance.yahoo.com", "investing.com", "robinhood.com", "interactivebrokers.com",
            "degiro.com", "swissquote.ch", "etoro.com", "morningstar.com", "seekingalpha.com", "coinmarketcap.com",
            "coingecko.com", "estv.admin.ch", "zh.ch/steuern", "stripe.com/pricing", "twint.ch", "otpbank.hu",
        ])
        add(.lifestyle, [
            "booking.com", "airbnb.com", "airbnb.ch", "expedia.com", "skyscanner.net", "skyscanner.ch", "kayak.com",
            "google.com/travel", "tripadvisor.com", "hostelworld.com", "swiss.com", "easyjet.com", "ryanair.com",
            "lufthansa.com", "uber.com", "lime.bike", "ubereats.com", "doordash.com", "deliveroo.com", "just-eat.ch",
            "eat.ch", "smood.ch", "wolt.com", "allrecipes.com", "bonappetit.com", "fooby.ch", "bettybossi.ch",
            "chefkoch.de", "myfitnesspal.com", "strava.com", "garmin.com", "connect.garmin.com", "fitbit.com",
            "headspace.com", "calm.com", "webmd.com", "mayoclinic.org", "healthline.com", "nhs.uk", "doctolib.ch",
            "homegate.ch", "immoscout24.ch", "flatfox.ch", "comparis.ch", "wg-gesucht.de", "jobs.ch", "indeed.com",
            "glassdoor.com", "jobup.ch", "wellfound.com", "ycombinator.com/jobs", "admin.ch", "ch.ch", "post.ch",
            "fifa.com", "uefa.com", "espn.com", "skysports.com", "nba.com", "formula1.com", "transfermarkt.com",
        ])
        add(.adult, [
            "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "onlyfans.com", "chaturbate.com", "stripchat.com",
            "redtube.com", "youporn.com", "bet365.com", "pokerstars.com", "stake.com", "betway.com", "williamhill.com",
            "draftkings.com", "fanduel.com", "casino.com", "unibet.com", "bwin.com", "tipico.de",
        ])
        add(.plumbing, [
            "accounts.google.com", "myaccount.google.com", "login.microsoftonline.com", "login.live.com", "login.microsoft.com",
            "mysignins.microsoft.com", "account.microsoft.com", "auth.openai.com", "auth0.openai.com", "appleid.apple.com",
            "idmsa.apple.com", "account.apple.com", "consent.google.com", "consent.youtube.com", "accounts.youtube.com",
            "oauth.telegram.org", "id.atlassian.com", "github.com/login", "auth.supabase.io", "clerk.accounts.dev",
            "accounts.spotify.com", "login.yahoo.com", "secure.login.gov", "aai-logon.ethz.ch", "idp.ethz.ch",
            "wayf.switch.ch", "login.eduid.ch", "eduid.ch", "t.co", "bit.ly", "lnkd.in", "l.facebook.com", "l.instagram.com",
            "out.reddit.com", "google.com/url", "steamcommunity.com/linkfilter", "safelinks.protection.outlook.com",
            "nam12.safelinks.protection.outlook.com", "eur01.safelinks.protection.outlook.com", "click.convertkit-mail.com",
            "mandrillapp.com", "sendgrid.net", "list-manage.com", "awstrack.me", "email.mg.", "checkout.stripe.com",
        ])
        return d
    }()

    /// Host fragments that are logins/redirects wherever they appear.
    static let plumbingHostPrefixes = ["accounts.", "login.", "auth.", "auth0.", "sso.", "signin.", "id.", "oauth.", "idp.", "secure.login."]
    static let plumbingPathFragments = ["/oauth", "/login", "/signin", "/sign-in", "/signup", "/sign-up", "/sso", "/callback",
                                        "/auth/", "/authorize", "/consent", "/logout", "/verify-email", "/2fa", "/mfa"]
    /// Host prefixes that say what a site is (docs.foo.dev, console.foo.com).
    static let hostPrefixes: [(String, DietCategory)] = [
        ("docs.", .learning), ("developer.", .learning), ("developers.", .learning), ("learn.", .learning),
        ("wiki.", .learning), ("api.", .building), ("console.", .building), ("dashboard.", .building),
        ("status.", .building), ("admin.", .work), ("myaccount.", .plumbing), ("account.", .plumbing),
        ("mail.", .work), ("calendar.", .work), ("shop.", .shopping), ("store.", .shopping), ("news.", .news),
        ("blog.", .culture), ("music.", .music), ("play.", .games),
    ]
    /// Host suffixes that say what a site is even when the exact host is unknown.
    static let suffixes: [(String, DietCategory)] = [
        (".edu", .learning), (".ac.uk", .learning), (".ac.at", .learning), (".edu.au", .learning), (".ethz.ch", .learning),
        (".uzh.ch", .learning), (".epfl.ch", .learning), (".supabase.co", .building), (".vercel.app", .building),
        (".netlify.app", .building), (".onrender.com", .building), (".herokuapp.com", .building), (".fly.dev", .building),
        (".pages.dev", .building), (".workers.dev", .building), (".github.io", .building), (".ngrok-free.app", .building),
        (".local", .building), (".localhost", .building), (".test", .building), (".substack.com", .culture),
        (".medium.com", .culture), (".wordpress.com", .culture), (".blogspot.com", .culture), (".gov", .lifestyle),
        (".admin.ch", .lifestyle), (".slack.com", .communication), (".atlassian.net", .work), (".sharepoint.com", .work),
        (".myshopify.com", .shopping), (".readthedocs.io", .learning), (".gitbook.io", .learning), (".mintlify.app", .learning),
    ]

    // MARK: title lexicons (lowercased; multi-word cues match as phrases)

    static let titleCues: [DietCategory: [String]] = [
        .learning: ["tutorial", "lecture", "course", "lesson", "explained", "explainer", "how to", "how does", "guide to",
                    "introduction to", "intro to", "beginner", "crash course", "masterclass", "documentation", "docs",
                    "reference", "learn", "learning", "study", "exam", "homework", "theorem", "proof", "calculus",
                    "algebra", "physics", "chemistry", "biology", "history of", "math", "mathematics", "statistics",
                    "programming", "algorithm", "data structure", "machine learning", "deep learning", "neural network",
                    "transformer", "llm", "fine-tuning", "fine tuning", "reinforcement learning", "linear algebra",
                    "lecture notes", "walkthrough", "deep dive", "cheat sheet", "for beginners", "step by step",
                    "workshop", "seminar", "mit ", "stanford", "cs50", "khan academy", "3blue1brown", "wiki"],
        .research: ["paper", "arxiv", "preprint", "proceedings", "journal", "study finds", "et al", "neurips", "icml",
                    "iclr", "acl ", "cvpr", "openreview", "abstract", "thesis", "dissertation", "literature review",
                    "benchmark", "ablation", "dataset", "survey of"],
        .building: ["github", "pull request", "issue #", "commit", "repository", "api", "sdk", "deploy", "deployment",
                    "dashboard", "localhost", "console", "xcode", "swiftui", "react", "next.js", "typescript", "python",
                    "rust", "docker", "kubernetes", "supabase", "firebase", "vercel", "build", "bug", "error", "debug",
                    "npm", "pip install", "cli", "terminal", "server", "database", "schema", "migration", "coding",
                    "code review", "vibe coding", "cursor", "claude code", "codex", "mcp"],
        .news: ["breaking", "live updates", "election", "president", "minister", "government", "parliament", "war",
                "ukraine", "gaza", "israel", "russia", "trump", "biden", "orbán", "orban", "tariff", "economy",
                "inflation", "stock market", "crash", "crisis", "scandal", "protest", "verdict", "court", "police",
                "killed", "dies", "dead", "attack", "news", "report:", "exclusive:", "update:"],
        .culture: ["essay", "book", "novel", "poem", "poetry", "philosophy", "podcast", "interview", "conversation with",
                   "documentary", "history", "art", "museum", "film review", "review:", "letters", "on writing",
                   "biography", "memoir", "lex fridman", "dwarkesh", "huberman", "longform", "newsletter"],
        .music: ["official video", "official music video", "official audio", "lyrics", "lyric video", "remix", "live at",
                 "full album", "playlist", "mix", "dj set", "concert", "feat.", "ft.", "cover", "acoustic", "spotify"],
        .games: ["gameplay", "let's play", "lets play", "speedrun", "walkthrough part", "minecraft", "fortnite",
                 "league of legends", "valorant", "gta", "elden ring", "zelda", "pokemon", "pokémon", "chess", "esports",
                 "twitch", "steam", "playthrough", "boss fight"],
        .shortVideo: ["#shorts", "shorts", "#short", "tiktok", "reels", "#fyp", "#viral"],
        .streaming: ["episode", "season", "s01", "s02", "trailer", "full movie", "series", "netflix"],
        .shopping: ["buy", "price", "deal", "deals", "sale", "discount", "% off", "coupon", "order", "cart", "checkout",
                    "shipping", "unboxing", "review: best", "best budget", "vs ", "which should you buy"],
        .finance: ["stock", "stocks", "bitcoin", "crypto", "ethereum", "etf", "invest", "investing", "portfolio",
                   "dividend", "trading", "tax", "taxes", "budget", "salary", "mortgage", "bank"],
        .lifestyle: ["recipe", "workout", "fitness", "diet", "sleep", "travel", "flight", "hotel", "apartment", "vlog",
                     "day in my life", "morning routine", "skincare", "fashion", "football", "soccer", "match highlights",
                     "highlights", "formula 1", "f1 ", "nba", "goal"],
        .ai: ["chatgpt", "claude", "gemini", "gpt-", "openai", "anthropic", "prompt", "ai agent", "agents"],
    ]

    /// Title words that add sugar (clickbait) or salt (outrage) whatever the category.
    static let clickbaitCues = ["you won't believe", "you wont believe", "shocking", "insane", "crazy", "gone wrong",
                                "prank", "exposed", "destroys", "destroyed", "reaction", "reacts", "omg", "unbelievable",
                                "mind blowing", "mind-blowing", "!!!", "?!", "😱", "🔥", "😂", "top 10", "top 5",
                                "ranking every", "tier list", "i tried", "24 hours", "challenge", "satisfying", "asmr",
                                "drama", "tea", "caught on camera", "fails", "compilation", "funniest", "memes"]
    static let outrageCues = ["slams", "outrage", "furious", "rage", "war", "crisis", "scandal", "disaster", "attack",
                              "killed", "dead", "collapse", "chaos", "panic", "warning", "threat", "terror", "fear",
                              "controversy", "backlash", "humiliates", "meltdown", "doom", "worst"]

    /// Words that are never topics.
    static let stopwords: Set<String> = [
        "the", "and", "for", "with", "you", "your", "are", "was", "were", "this", "that", "from", "into", "about",
        "what", "when", "where", "which", "who", "why", "how", "can", "will", "not", "but", "all", "any", "our", "out",
        "new", "now", "get", "got", "use", "using", "used", "via", "its", "it's", "his", "her", "their", "they", "them",
        "has", "have", "had", "one", "two", "more", "most", "best", "top", "just", "like", "make", "made", "over",
        "than", "then", "also", "only", "very", "much", "many", "some", "such", "each", "other", "here", "there",
        "home", "page", "login", "sign", "log", "account", "dashboard", "settings", "search", "results", "untitled",
        "youtube", "google", "github", "twitter", "reddit", "linkedin", "facebook", "instagram", "medium", "wikipedia",
        "official", "video", "videos", "watch", "live", "full", "part", "episode", "der", "die", "das", "und", "mit",
        "für", "von", "ein", "eine", "les", "des", "une", "pour", "con", "por", "para", "los", "las", "inbox",
        "chatgpt", "claude", "new chat", "chat", "loading", "error", "localhost", "document", "documents", "sheet",
        "drive", "docs", "mail", "gmail", "calendar", "notion", "welcome", "index", "main", "app", "web", "com",
        "www", "http", "https", "html", "php", "org", "net", "pdf", "edit", "view", "share", "file", "files",
        "open", "free", "online", "help", "support", "news", "blog", "post", "posts", "feed", "profile", "user",
        "users", "tab", "untitled document", "copy", "draft", "i'm", "don't", "isn't", "can't", "won't", "what's",
        "vs", "via", "per", "ago", "day", "days", "week", "year", "years", "today", "2023", "2024", "2025", "2026",
        "pro", "project", "projects", "app", "apps", "repository", "repositories", "code", "api", "microsoft", "apple",
        "overview", "details", "detail", "list", "lists", "my", "data", "info", "issues", "issue", "pull", "requests",
        "actions", "commits", "branches", "releases", "console", "admin", "portal", "manage", "team", "teams",
        "workspace", "organization", "billing", "usage", "keys", "version", "academic", "ai-powered", "powered",
        "based", "first", "last", "next", "back", "show", "shows",
    ]
}
