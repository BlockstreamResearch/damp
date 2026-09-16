use crate::{
    config::{self, Config},
    report::{self, Credentials},
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::any,
};
use damp_indexer::Cancellation;
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const JOB_TTL: Duration = Duration::from_secs(120);
struct Job {
    id: String,
    cancel: Cancellation,
    done: AtomicBool,
    data: Mutex<JobData>,
}
struct JobData {
    last_access: Instant,
    valid: bool,
    progress: Value,
    result: Option<Result<Zeroizing<String>, String>>,
}
struct Inner {
    discard_pin: bool,
    token: Option<Zeroizing<String>>,
    job: Option<Arc<Job>>,
}
pub struct Service {
    config: Config,
    credentials: Arc<Credentials>,
    inner: Mutex<Inner>,
    requests: Semaphore,
}
impl Service {
    pub fn new(config: Config) -> anyhow::Result<Arc<Self>> {
        config.validate()?;
        let token = config::token(&config.token)?;
        let credentials = Arc::new(Credentials::load(&config)?);
        Ok(Arc::new(Self {
            config,
            credentials,
            inner: Mutex::new(Inner {
                discard_pin: false,
                token: Some(token),
                job: None,
            }),
            requests: Semaphore::new(16),
        }))
    }
    fn invalidate(job: &Job) {
        job.cancel.cancel();
        let mut data = job.data.lock().unwrap_or_else(|e| e.into_inner());
        data.valid = false;
        data.result = None;
        data.progress = Value::Null;
    }
    fn refresh(&self, inner: &mut Inner) {
        let token = config::token(&self.config.token).ok();
        if inner.token.as_deref() != token.as_deref() {
            inner.discard_pin = true;
            if let Some(job) = &inner.job {
                Self::invalidate(job);
            }
            inner.token = token;
        }
        if let Some(job) = &inner.job {
            let expired = job
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .last_access
                .elapsed()
                >= JOB_TTL;
            if expired {
                inner.discard_pin = true;
                Self::invalidate(job);
            }
        }
        if inner.discard_pin
            && inner
                .job
                .as_ref()
                .is_none_or(|job| job.done.load(Ordering::Acquire))
            && damp_indexer::HistoryIndex::discard_pending(&self.config.index_dir).is_ok()
        {
            inner.discard_pin = false;
        }
        if !inner.discard_pin
            && inner.job.as_ref().is_some_and(|job| {
                job.done.load(Ordering::Acquire)
                    && !job.data.lock().unwrap_or_else(|e| e.into_inner()).valid
            })
        {
            inner.job = None;
        }
    }
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/report", any(handle))
            .route("/health", any(handle))
            .fallback(handle)
            .with_state(self.clone())
    }
    /// Also expire abandoned work when no further HTTP requests arrive.
    pub async fn maintain(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            self.refresh(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()));
        }
    }
    pub fn shutdown(&self) {
        if let Some(job) = &self.inner.lock().unwrap_or_else(|e| e.into_inner()).job {
            Self::invalidate(job);
        }
    }
    fn reply(&self, status: StatusCode, value: Value, origin: bool) -> Response {
        self.bytes(status, value.to_string(), origin)
    }
    fn bytes(&self, status: StatusCode, value: String, origin: bool) -> Response {
        let mut r = Response::builder()
            .status(status)
            .header("Content-Type", "application/json")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("Vary", "Origin");
        if origin {
            r = r.header("Access-Control-Allow-Origin", &self.config.origin);
        }
        r.body(Body::from(value)).unwrap()
    }
    fn start(self: &Arc<Self>, request: Value) -> Result<Value, (StatusCode, &'static str)> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.refresh(&mut inner);
        if inner.discard_pin
            && inner
                .job
                .as_ref()
                .is_none_or(|j| j.done.load(Ordering::Acquire))
        {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "cannot release cancelled snapshot; check index permissions and lock, or use a new indexDir for an unsupported schema",
            ));
        }
        if inner
            .job
            .as_ref()
            .is_some_and(|j| !j.done.load(Ordering::Acquire))
        {
            return Err((
                StatusCode::CONFLICT,
                "report worker is busy or cancelling; poll or retry shortly",
            ));
        }
        // Do not replace an uncollected report with an unrelated request.
        if inner
            .job
            .as_ref()
            .is_some_and(|j| j.data.lock().unwrap_or_else(|e| e.into_inner()).valid)
        {
            return Err((
                StatusCode::CONFLICT,
                "collect or cancel the existing report before starting another",
            ));
        }
        let mut random = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut random);
        let job = Arc::new(Job {
            id: hex::encode(random),
            cancel: Cancellation::default(),
            done: AtomicBool::new(false),
            data: Mutex::new(JobData {
                last_access: Instant::now(),
                valid: true,
                progress: json!({"phase":"starting"}),
                result: None,
            }),
        });
        let start = json!({"jobId":job.id,"phase":"starting"});
        inner.job = Some(job.clone());
        let service = self.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                report::build(
                    &service.config,
                    &service.credentials,
                    request,
                    &job.cancel,
                    |p| {
                        job.cancel.check()?;
                        let mut data = job.data.lock().unwrap_or_else(|e| e.into_inner());
                        if data.last_access.elapsed() >= JOB_TTL {
                            job.cancel.cancel();
                        }
                        job.cancel.check()?;
                        data.progress = p;
                        Ok(())
                    },
                )
            }));
            let result = match result {
                Ok(Ok(value)) => serde_json::to_string(&value)
                    .map(Zeroizing::new)
                    .map_err(|_| "report encoding failed".into()),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err("report worker failed; committed public history retained".into()),
            };
            let mut data = job.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.valid && !job.cancel.is_cancelled() {
                data.result = Some(result);
            }
            job.done.store(true, Ordering::Release);
        });
        Ok(start)
    }
}
fn one<'a>(h: &'a HeaderMap, key: &str) -> Option<&'a str> {
    if h.get_all(key).iter().count() != 1 {
        return None;
    }
    h.get(key)?.to_str().ok()
}
fn equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}
async fn handle(State(s): State<Arc<Service>>, req: Request) -> Response {
    let Ok(_permit) = s.requests.try_acquire() else {
        return s.reply(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error":"too many concurrent requests"}),
            false,
        );
    };
    let headers = req.headers();
    let has_origin = headers.contains_key("origin");
    let allowed_origin = one(headers, "origin") == Some(s.config.origin.as_str());
    let host = format!("127.0.0.1:{}", s.config.port);
    if one(headers, "host") != Some(host.as_str())
        || (has_origin && !allowed_origin)
        || req.uri().query().is_some()
    {
        return s.reply(StatusCode::FORBIDDEN,json!({"error":"Host or Origin rejected; use the configured loopback address and exact browser origin"}),false);
    }
    if req.method() == Method::OPTIONS {
        if !allowed_origin
            || !matches!(
                one(headers, "access-control-request-method"),
                Some("POST" | "GET")
            )
        {
            return s.reply(
                StatusCode::FORBIDDEN,
                json!({"error":"preflight rejected"}),
                false,
            );
        }
        let mut r = s.reply(StatusCode::NO_CONTENT, Value::Null, true);
        r.headers_mut().insert(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS".parse().unwrap(),
        );
        r.headers_mut().insert(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type".parse().unwrap(),
        );
        r.headers_mut().insert(
            "Access-Control-Allow-Private-Network",
            "true".parse().unwrap(),
        );
        return r;
    }
    let authorized_token;
    {
        let mut inner = s.inner.lock().unwrap_or_else(|e| e.into_inner());
        s.refresh(&mut inner);
        let supplied = one(headers, "authorization").and_then(|h| h.strip_prefix("Bearer "));
        let authorized = supplied
            .zip(inner.token.as_ref())
            .is_some_and(|(a, b)| equal(a.as_bytes(), b.as_bytes()));
        if !authorized {
            return s.reply(StatusCode::UNAUTHORIZED,json!({"error":"access token rejected; read the current local token file or run damp-indexer token-reset"}),allowed_origin);
        }
        authorized_token = Zeroizing::new(supplied.unwrap().to_owned());
    }
    if req.uri().path() == "/health" && req.method() == Method::GET {
        let inner = s.inner.lock().unwrap_or_else(|e| e.into_inner());
        let progress = inner.job.as_ref().map(|j| {
            j.data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .progress
                .clone()
        });
        return s.reply(StatusCode::OK,json!({"service":"damp-report","authenticated":true,"credentialsValidated":true,"deploymentId":s.credentials.deployment.deployment_id(),"network":s.credentials.deployment.network().as_str(),"reportReady":false,"progress":progress,"next":"Start a report to check provider sync, index history and verify the confirmed snapshot. Only its signed result establishes report completeness."}),allowed_origin);
    }
    if req.uri().path() != "/report" {
        return s.reply(
            StatusCode::NOT_FOUND,
            json!({"error":"use POST /report or GET /health"}),
            allowed_origin,
        );
    }
    if req.method() != Method::POST {
        return s.reply(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"use POST /report"}),
            allowed_origin,
        );
    }
    if one(headers, "content-type").is_none_or(|v| v.split(';').next() != Some("application/json"))
    {
        return s.reply(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"error":"Content-Type must be application/json"}),
            allowed_origin,
        );
    }
    let bytes = match tokio::time::timeout(
        Duration::from_secs(5),
        to_bytes(req.into_body(), 2 * 1024 * 1024),
    )
    .await
    {
        Ok(Ok(b)) => b,
        _ => {
            return s.reply(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"request exceeds 2 MiB or five-second body allowance"}),
                allowed_origin,
            );
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return s.reply(
                StatusCode::BAD_REQUEST,
                json!({"error":"invalid request JSON"}),
                allowed_origin,
            );
        }
    };
    {
        let mut inner = s.inner.lock().unwrap_or_else(|e| e.into_inner());
        s.refresh(&mut inner);
        if inner
            .token
            .as_ref()
            .is_none_or(|t| !equal(t.as_bytes(), authorized_token.as_bytes()))
        {
            return s.reply(
                StatusCode::UNAUTHORIZED,
                json!({"error":"access token changed; retry with the current local token"}),
                allowed_origin,
            );
        }
    }
    match value["action"].as_str() {
        Some("start") => match s.start(value["request"].clone()) {
            Ok(v) => s.reply(StatusCode::ACCEPTED, v, allowed_origin),
            Err((c, e)) => s.reply(c, json!({"error":e}), allowed_origin),
        },
        Some(action @ ("advance" | "cancel")) => {
            let mut inner = s.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.refresh(&mut inner);
            let Some(job) = inner.job.clone() else {
                return s.reply(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error":"job unavailable; start again to resume committed history"}),
                    allowed_origin,
                );
            };
            if value["jobId"] != job.id || !job.data.lock().unwrap_or_else(|e| e.into_inner()).valid
            {
                return s.reply(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error":"job unavailable; start again to resume committed history"}),
                    allowed_origin,
                );
            }
            if action == "cancel" {
                inner.discard_pin = true;
                Service::invalidate(&job);
                return s.reply(
                    StatusCode::OK,
                    json!({"cancelled":true,"historyRetained":true}),
                    allowed_origin,
                );
            }
            let mut data = job.data.lock().unwrap_or_else(|e| e.into_inner());
            data.last_access = Instant::now();
            if let Some(result) = data.result.take() {
                data.valid = false;
                match result {
                    Ok(v) => s.bytes(StatusCode::OK, v.to_string(), allowed_origin),
                    Err(e) => s.reply(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        json!({"error":e}),
                        allowed_origin,
                    ),
                }
            } else {
                let mut p = data.progress.clone();
                p["jobId"] = json!(job.id);
                s.reply(StatusCode::ACCEPTED, p, allowed_origin)
            }
        }
        _ => s.reply(
            StatusCode::BAD_REQUEST,
            json!({"error":"action must be start, advance or cancel"}),
            allowed_origin,
        ),
    }
}
