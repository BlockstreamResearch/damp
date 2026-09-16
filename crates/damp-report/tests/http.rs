mod support;
use damp_report::config::{Config, ProviderConfig};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use support::*;

struct Server {
    child: Child,
    url: String,
    client: Client,
    token: String,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Server {
    fn start(path: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_damp-report"))
            .args(["serve", path.to_str().unwrap()])
            .env("PATH", "")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let url = line
            .split_whitespace()
            .find(|w| w.starts_with("http:"))
            .expect(&line)
            .trim_end_matches(';')
            .to_string();
        Self {
            child,
            url,
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            token: std::fs::read_to_string(path.parent().unwrap().join("access-token")).unwrap(),
        }
    }
    fn post(&self, body: Value) -> (u16, Value) {
        let r = self
            .client
            .post(&self.url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .unwrap();
        (r.status().as_u16(), r.json().unwrap())
    }
    fn start_job(&self, request: Value) -> String {
        let started = Instant::now();
        loop {
            let (status, v) = self.post(json!({"action":"start","request":request}));
            if status == 409 && started.elapsed() < Duration::from_secs(20) {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            assert_eq!(status, 202, "{v}");
            return v["jobId"].as_str().unwrap().into();
        }
    }
    fn finish(&self, id: &str) -> (u16, Value) {
        let start = Instant::now();
        loop {
            assert!(start.elapsed() < Duration::from_secs(120));
            let (s, v) = self.post(json!({"action":"advance","jobId":id}));
            if s != 202 {
                return (s, v);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
fn setup(path: &Path, f: &Fixture, rpc: &Rpc) -> std::path::PathBuf {
    private(
        &path.join("audit-credentials.json"),
        f.credentials.as_bytes(),
    );
    private(&path.join("cookie"), b"fixture:cookie");
    damp_indexer::token::generate(
        &path.join("access-token"),
        damp_indexer::token::TokenAction::Create,
    )
    .unwrap();
    let c = Config {
        credentials: "audit-credentials.json".into(),
        token: "access-token".into(),
        index_dir: "history".into(),
        port: 0,
        origin: "http://127.0.0.1:5173".into(),
        provider: ProviderConfig::Rpc {
            port: rpc.port,
            cookie: "cookie".into(),
        },
        index_max_mib: 32,
    };
    let p = path.join("config.json");
    private(&p, &serde_json::to_vec(&c).unwrap());
    p
}
#[test]
fn rust_http_recovery_security_restart_and_credentials_without_python() -> anyhow::Result<()> {
    let f = fixture()?;
    let rpc = Rpc::start(f.clone());
    let dir = tempfile::tempdir()?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let config = setup(dir.path(), &f, &rpc);
    // Fail startup on a valid scalar that is not the manifest's audit key.
    let mut mismatched: Value = serde_json::from_str(&f.credentials)?;
    mismatched["auditSecret"] = json!("01".repeat(32));
    let credentials = dir.path().join("audit-credentials.json");
    std::fs::write(&credentials, serde_json::to_vec(&mismatched)?)?;
    let rejected = Command::new(env!("CARGO_BIN_EXE_damp-report"))
        .args(["serve", config.to_str().unwrap()])
        .env("PATH", "")
        .output()?;
    assert!(!rejected.status.success());
    assert!(!String::from_utf8_lossy(&rejected.stderr).contains(&"01".repeat(32)));
    std::fs::write(&credentials, &f.credentials)?;
    let mut server = Server::start(&config);
    let unauth = server
        .client
        .post(&server.url)
        .json(&json!({"action":"start"}))
        .send()?;
    assert_eq!(unauth.status(), 401);
    for (h, v) in [("Origin", "https://evil.invalid"), ("Host", "evil.invalid")] {
        assert_eq!(
            server
                .client
                .post(&server.url)
                .header(h, v)
                .bearer_auth(&server.token)
                .json(&json!({}))
                .send()?
                .status(),
            403
        );
    }
    let preflight = server
        .client
        .request(reqwest::Method::OPTIONS, &server.url)
        .header("Origin", "http://127.0.0.1:5173")
        .header("Access-Control-Request-Method", "POST")
        .send()?;
    assert_eq!(preflight.status(), 204);
    assert_eq!(
        preflight.headers()["access-control-allow-origin"],
        "http://127.0.0.1:5173"
    );
    assert_eq!(
        server
            .client
            .get(server.url.replace("/report", "/health"))
            .bearer_auth(&server.token)
            .send()?
            .json::<Value>()?["reportReady"],
        false
    );
    let id = server.start_job(f.request.clone());
    let (status, result) = server.finish(&id);
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["report"]["complete"], true, "{result}");
    assert_eq!(result["report"]["supply"]["issued"], "3000000000000000");
    assert_eq!(
        result["report"]["supply"]["knownUnspent"],
        "3000000000000000"
    );
    assert_eq!(result["report"]["events"][0]["covenantVerified"], true);
    let deployment = dir.path().join("deployment.json");
    private(&deployment, &serde_json::to_vec(&f.request["deployment"])?);
    let signed = dir.path().join("report.json");
    private(&signed, &serde_json::to_vec(&result)?);
    assert!(
        Command::new(env!("CARGO_BIN_EXE_damp-report"))
            .args([
                "verify",
                deployment.to_str().unwrap(),
                signed.to_str().unwrap()
            ])
            .env("PATH", "")
            .output()?
            .status
            .success()
    );
    let mut tampered = result.clone();
    tampered["reportJson"] = json!(format!("{} ", result["reportJson"].as_str().unwrap()));
    std::fs::write(&signed, serde_json::to_vec(&tampered)?)?;
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_damp-report"))
            .args([
                "verify",
                deployment.to_str().unwrap(),
                signed.to_str().unwrap()
            ])
            .env("PATH", "")
            .output()?
            .status
            .success()
    );
    drop(server);
    server = Server::start(&config);
    let id = server.start_job(f.request.clone());
    assert_eq!(server.finish(&id).1["report"]["complete"], true);
    rpc.state.fail.store(true, Ordering::Relaxed);
    let id = server.start_job(f.request.clone());
    let (status, v) = server.finish(&id);
    assert_eq!(status, 422);
    assert!(!v.to_string().contains("SECRET"));
    rpc.state.fail.store(false, Ordering::Relaxed);
    rpc.state.catching_up.store(true, Ordering::Relaxed);
    let id = server.start_job(f.request.clone());
    assert_eq!(
        server.post(json!({"action":"start","request":f.request})).0,
        409
    );
    assert_eq!(
        server.post(json!({"action":"cancel","jobId":id})).1["cancelled"],
        true
    );
    assert_eq!(server.post(json!({"action":"advance","jobId":id})).0, 422);
    std::thread::sleep(Duration::from_millis(250));
    let id = server.start_job(f.request.clone());
    let old = server.token.clone();
    damp_indexer::token::generate(
        &dir.path().join("access-token"),
        damp_indexer::token::TokenAction::Reset,
    )?;
    server.token = std::fs::read_to_string(dir.path().join("access-token"))?;
    assert_eq!(server.post(json!({"action":"advance","jobId":id})).0, 422);
    assert_eq!(
        server
            .client
            .post(&server.url)
            .bearer_auth(old)
            .json(&json!({"action":"advance","jobId":id}))
            .send()?
            .status(),
        401
    );
    rpc.state.catching_up.store(false, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(250));
    let mut bad = f.request.clone();
    bad["confirmations"] = json!(0);
    let id = server.start_job(bad);
    assert_eq!(server.finish(&id).0, 422);
    let id = server.start_job(f.request.clone());
    assert_eq!(server.finish(&id).1["report"]["complete"], true);
    drop(server);
    // A valid credential certificate does not fabricate omitted issuer openings.
    let mut incomplete: Value = serde_json::from_str(&f.credentials)?;
    incomplete["issuerOpenings"] = json!([]);
    std::fs::write(
        dir.path().join("audit-credentials.json"),
        serde_json::to_vec(&incomplete)?,
    )?;
    let server = Server::start(&config);
    let id = server.start_job(f.request.clone());
    let (status, v) = server.finish(&id);
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["report"]["complete"], false);
    assert!(
        v["report"]["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["type"] == "issuer-opening-unavailable")
    );
    Ok(())
}

#[test]
fn interrupted_http_job_resumes_commits_and_reconciles_a_reorg() -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture()?;
    let rpc = Rpc::start(f.clone());
    rpc.state.delay_ms.store(50, Ordering::Relaxed);
    let dir = tempfile::tempdir()?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    let config = setup(dir.path(), &f, &rpc);
    let server = Server::start(&config);
    let _id = server.start_job(f.request.clone());
    let database = dir.path().join("history/history.sqlite3");
    let start = Instant::now();
    // Observe a durable public row, then kill the actual HTTP process during the scan.
    loop {
        assert!(start.elapsed() < Duration::from_secs(30));
        if let Ok(db) = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) && db
            .query_row::<u32, _, _>("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
            .unwrap_or(0)
            > 0
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(server);
    let db = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    assert_eq!(
        db.query_row::<u32, _, _>(
            "SELECT COUNT(*) FROM metadata WHERE key='pending'",
            [],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    rpc.state.delay_ms.store(0, Ordering::Relaxed);
    let server = Server::start(&config);
    let id = server.start_job(f.request.clone());
    let (status, v) = server.finish(&id);
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["report"]["complete"], true);
    rpc.state.replace.store(true, Ordering::Relaxed);
    let id = server.start_job(f.request.clone());
    let (status, v) = server.finish(&id);
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["report"]["complete"], true);
    let db = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    assert_eq!(
        db.query_row::<String, _, _>("SELECT hash FROM blocks WHERE height=1", [], |r| r.get(0))?,
        format!("{:064x}", 101)
    );
    assert_eq!(
        db.query_row::<u32, _, _>(
            "SELECT COUNT(*) FROM metadata WHERE key='pending'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    drop(db);
    rpc.state.delay_ms.store(100, Ordering::Relaxed);
    let mut fresh = f.request.clone();
    fresh["confirmations"] = json!(1);
    let id = server.start_job(fresh);
    let deadline = Instant::now();
    loop {
        assert!(deadline.elapsed() < Duration::from_secs(30));
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if db.query_row::<u32, _, _>(
            "SELECT COUNT(*) FROM metadata WHERE key='pending'",
            [],
            |r| r.get(0),
        )? == 1
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        server.post(json!({"action":"cancel","jobId":id})).1["cancelled"],
        true
    );
    let deadline = Instant::now();
    loop {
        assert!(deadline.elapsed() < Duration::from_secs(30));
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        if db.query_row::<u32, _, _>(
            "SELECT COUNT(*) FROM metadata WHERE key='pending'",
            [],
            |r| r.get(0),
        )? == 0
        {
            assert!(
                db.query_row::<u32, _, _>("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))?
                    >= 2
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
