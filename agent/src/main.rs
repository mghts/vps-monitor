use std::{
    collections::HashMap,
    ffi::CString,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context};
use chrono::{DateTime, Utc};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, process::Command, time::timeout};
use tracing::{info, warn};

#[derive(Clone)]
struct AgentConfig {
    server_url: String,
    token: String,
    host_root: PathBuf,
    public_ip: Option<String>,
}

impl AgentConfig {
    fn from_env() -> anyhow::Result<Self> {
        let server_url = std::env::var("VPS_MONITOR_SERVER_URL")
            .context("VPS_MONITOR_SERVER_URL 未设置")?
            .trim_end_matches('/')
            .to_string();
        let token = std::env::var("VPS_MONITOR_AGENT_TOKEN").context("VPS_MONITOR_AGENT_TOKEN 未设置")?;
        let host_root = PathBuf::from(std::env::var("VPS_MONITOR_HOST_ROOT").unwrap_or_else(|_| "/host".to_string()));
        let public_ip = std::env::var("VPS_MONITOR_PUBLIC_IP").ok().filter(|v| !v.trim().is_empty());
        Ok(Self {
            server_url,
            token,
            host_root,
            public_ip,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteConfig {
    system_interval_seconds: u64,
    config_refresh_seconds: u64,
    ping_targets: Vec<PingTarget>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            system_interval_seconds: 2,
            config_refresh_seconds: 30,
            ping_targets: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PingTarget {
    id: String,
    name: String,
    host: String,
    mode: String,
    tcp_port: Option<u16>,
    interval_seconds: u64,
    timeout_ms: u64,
}

#[derive(Debug, Serialize)]
struct MetricPayload {
    captured_at: DateTime<Utc>,
    system: SystemMetric,
    system_info: SystemInfo,
    ping_results: Vec<PingResult>,
}

#[derive(Debug, Serialize)]
struct SystemMetric {
    cpu_usage: f64,
    memory_total_bytes: i64,
    memory_used_bytes: i64,
    disk_total_bytes: i64,
    disk_used_bytes: i64,
    net_rx_bytes: i64,
    net_tx_bytes: i64,
    uptime_seconds: i64,
    load1: f64,
    load5: f64,
    load15: f64,
    public_ip: Option<String>,
}

#[derive(Debug, Serialize)]
struct SystemInfo {
    hostname: Option<String>,
    os_name: Option<String>,
    kernel_version: Option<String>,
    arch: Option<String>,
}

#[derive(Debug, Serialize)]
struct PingResult {
    target_id: Option<String>,
    target_name: String,
    host: String,
    mode: String,
    checked_at: DateTime<Utc>,
    success: bool,
    latency_ms: Option<f64>,
    error: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let config = AgentConfig::from_env()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let mut remote = RemoteConfig::default();
    let mut last_config_pull = Instant::now() - Duration::from_secs(3600);
    let mut cpu_tracker = CpuTracker::new()?;
    let mut last_ping_at: HashMap<String, Instant> = HashMap::new();

    info!("VPS Monitor agent started, server={}", config.server_url);

    loop {
        if last_config_pull.elapsed() >= Duration::from_secs(remote.config_refresh_seconds.max(10)) {
            match fetch_config(&client, &config).await {
                Ok(next) => {
                    remote = next;
                    last_config_pull = Instant::now();
                }
                Err(err) => warn!(error = ?err, "拉取中心端配置失败"),
            }
        }

        let ping_results = run_due_pings(&remote.ping_targets, &mut last_ping_at).await;
        match collect_payload(&config, &mut cpu_tracker, ping_results).await {
            Ok(payload) => {
                if let Err(err) = push_metrics(&client, &config, &payload).await {
                    warn!(error = ?err, "推送指标失败");
                }
            }
            Err(err) => warn!(error = ?err, "采集指标失败"),
        }

        tokio::time::sleep(Duration::from_secs(remote.system_interval_seconds.max(1))).await;
    }
}

async fn fetch_config(client: &reqwest::Client, config: &AgentConfig) -> anyhow::Result<RemoteConfig> {
    let res = client
        .get(format!("{}/api/agent/config", config.server_url))
        .header(AUTHORIZATION, format!("Bearer {}", config.token))
        .send()
        .await?
        .error_for_status()?
        .json::<RemoteConfig>()
        .await?;
    Ok(res)
}

async fn push_metrics(client: &reqwest::Client, config: &AgentConfig, payload: &MetricPayload) -> anyhow::Result<()> {
    client
        .post(format!("{}/api/agent/metrics", config.server_url))
        .header(AUTHORIZATION, format!("Bearer {}", config.token))
        .header(CONTENT_TYPE, "application/json")
        .json(payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn collect_payload(
    config: &AgentConfig,
    cpu_tracker: &mut CpuTracker,
    ping_results: Vec<PingResult>,
) -> anyhow::Result<MetricPayload> {
    let mem = read_memory()?;
    let disk = read_disk(&config.host_root)?;
    let net = read_network()?;
    let load = read_load()?;
    Ok(MetricPayload {
        captured_at: Utc::now(),
        system: SystemMetric {
            cpu_usage: cpu_tracker.usage_percent()?,
            memory_total_bytes: mem.total_bytes,
            memory_used_bytes: mem.used_bytes,
            disk_total_bytes: disk.total_bytes,
            disk_used_bytes: disk.used_bytes,
            net_rx_bytes: net.rx_bytes,
            net_tx_bytes: net.tx_bytes,
            uptime_seconds: read_uptime().unwrap_or(0),
            load1: load.0,
            load5: load.1,
            load15: load.2,
            public_ip: config.public_ip.clone(),
        },
        system_info: read_system_info(&config.host_root),
        ping_results,
    })
}

async fn run_due_pings(targets: &[PingTarget], last_ping_at: &mut HashMap<String, Instant>) -> Vec<PingResult> {
    let mut results = Vec::new();
    for target in targets {
        let due = last_ping_at
            .get(&target.id)
            .map(|t| t.elapsed() >= Duration::from_secs(target.interval_seconds.max(5)))
            .unwrap_or(true);
        if !due {
            continue;
        }
        last_ping_at.insert(target.id.clone(), Instant::now());
        let result = match target.mode.as_str() {
            "tcp" => tcp_ping(target).await,
            "icmp" => icmp_ping(target).await,
            other => Err(anyhow!("未知 Ping 模式：{}", other)),
        };
        let checked_at = Utc::now();
        match result {
            Ok(latency_ms) => results.push(PingResult {
                target_id: Some(target.id.clone()),
                target_name: target.name.clone(),
                host: target.host.clone(),
                mode: target.mode.clone(),
                checked_at,
                success: true,
                latency_ms: Some(latency_ms),
                error: None,
            }),
            Err(err) => results.push(PingResult {
                target_id: Some(target.id.clone()),
                target_name: target.name.clone(),
                host: target.host.clone(),
                mode: target.mode.clone(),
                checked_at,
                success: false,
                latency_ms: None,
                error: Some(err.to_string()),
            }),
        }
    }
    results
}

async fn tcp_ping(target: &PingTarget) -> anyhow::Result<f64> {
    let port = target.tcp_port.ok_or_else(|| anyhow!("TCP Ping 缺少端口"))?;
    let addr = format!("{}:{}", target.host, port);
    let started = Instant::now();
    timeout(Duration::from_millis(target.timeout_ms.max(100)), TcpStream::connect(addr))
        .await
        .map_err(|_| anyhow!("TCP Ping 超时"))??;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

async fn icmp_ping(target: &PingTarget) -> anyhow::Result<f64> {
    let timeout_secs = ((target.timeout_ms.max(100) + 999) / 1000).max(1).to_string();
    let output = timeout(
        Duration::from_millis(target.timeout_ms.max(100) + 1000),
        Command::new("ping")
            .arg("-n")
            .arg("-c")
            .arg("1")
            .arg("-W")
            .arg(timeout_secs)
            .arg(&target.host)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("ICMP Ping 命令超时"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(anyhow!(
            "{}{}",
            stdout.trim(),
            if stderr.trim().is_empty() { "" } else { stderr.trim() }
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ping_latency(&stdout).ok_or_else(|| anyhow!("无法解析 ping 延迟"))
}

fn parse_ping_latency(output: &str) -> Option<f64> {
    let marker = "time=";
    let idx = output.find(marker)?;
    let rest = &output[idx + marker.len()..];
    let value = rest
        .split(|c: char| c.is_whitespace() || c == 'm')
        .next()?
        .trim();
    value.parse::<f64>().ok()
}

#[derive(Clone, Copy)]
struct CpuSnapshot {
    idle: u64,
    total: u64,
}

struct CpuTracker {
    previous: CpuSnapshot,
}

impl CpuTracker {
    fn new() -> anyhow::Result<Self> {
        Ok(Self {
            previous: read_cpu_snapshot()?,
        })
    }

    fn usage_percent(&mut self) -> anyhow::Result<f64> {
        let current = read_cpu_snapshot()?;
        let total_delta = current.total.saturating_sub(self.previous.total);
        let idle_delta = current.idle.saturating_sub(self.previous.idle);
        self.previous = current;
        if total_delta == 0 {
            return Ok(0.0);
        }
        Ok(((total_delta - idle_delta) as f64 * 100.0 / total_delta as f64).clamp(0.0, 100.0))
    }
}

fn read_cpu_snapshot() -> anyhow::Result<CpuSnapshot> {
    let content = std::fs::read_to_string("/proc/stat")?;
    let line = content.lines().next().ok_or_else(|| anyhow!("/proc/stat 为空"))?;
    let nums = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if nums.len() < 5 {
        return Err(anyhow!("/proc/stat CPU 字段不足"));
    }
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    let total = nums.iter().sum();
    Ok(CpuSnapshot { idle, total })
}

struct MemoryInfo {
    total_bytes: i64,
    used_bytes: i64,
}

fn read_memory() -> anyhow::Result<MemoryInfo> {
    let content = std::fs::read_to_string("/proc/meminfo")?;
    let mut total = 0_i64;
    let mut available = 0_i64;
    for line in content.lines() {
        if line.starts_with("MemTotal:") {
            total = parse_meminfo_kb(line) * 1024;
        } else if line.starts_with("MemAvailable:") {
            available = parse_meminfo_kb(line) * 1024;
        }
    }
    if total <= 0 {
        return Err(anyhow!("无法读取内存总量"));
    }
    Ok(MemoryInfo {
        total_bytes: total,
        used_bytes: (total - available).max(0),
    })
}

fn parse_meminfo_kb(line: &str) -> i64 {
    line.split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

struct DiskInfo {
    total_bytes: i64,
    used_bytes: i64,
}

fn read_disk(host_root: &Path) -> anyhow::Result<DiskInfo> {
    let path = if host_root.exists() { host_root } else { Path::new("/") };
    let c_path = CString::new(path.to_string_lossy().as_bytes())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(anyhow!("statvfs 失败"));
    }
    let block = stat.f_frsize as u128;
    let total = stat.f_blocks as u128 * block;
    let available = stat.f_bavail as u128 * block;
    Ok(DiskInfo {
        total_bytes: total.min(i64::MAX as u128) as i64,
        used_bytes: total.saturating_sub(available).min(i64::MAX as u128) as i64,
    })
}

struct NetworkInfo {
    rx_bytes: i64,
    tx_bytes: i64,
}

fn read_network() -> anyhow::Result<NetworkInfo> {
    let content = std::fs::read_to_string("/proc/net/dev")?;
    let mut rx = 0_i64;
    let mut tx = 0_i64;
    for line in content.lines().skip(2) {
        let Some((iface, data)) = line.split_once(':') else { continue };
        if iface.trim() == "lo" {
            continue;
        }
        let fields = data.split_whitespace().collect::<Vec<_>>();
        if fields.len() >= 16 {
            rx += fields[0].parse::<i64>().unwrap_or(0);
            tx += fields[8].parse::<i64>().unwrap_or(0);
        }
    }
    Ok(NetworkInfo { rx_bytes: rx, tx_bytes: tx })
}

fn read_uptime() -> anyhow::Result<i64> {
    let content = std::fs::read_to_string("/proc/uptime")?;
    let first = content.split_whitespace().next().unwrap_or("0");
    Ok(first.parse::<f64>().unwrap_or(0.0) as i64)
}

fn read_load() -> anyhow::Result<(f64, f64, f64)> {
    let content = std::fs::read_to_string("/proc/loadavg")?;
    let parts = content.split_whitespace().collect::<Vec<_>>();
    Ok((
        parts.get(0).and_then(|v| v.parse().ok()).unwrap_or(0.0),
        parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0.0),
        parts.get(2).and_then(|v| v.parse().ok()).unwrap_or(0.0),
    ))
}

fn read_system_info(host_root: &Path) -> SystemInfo {
    SystemInfo {
        hostname: read_trimmed(host_root.join("etc/hostname")).or_else(|| read_trimmed("/etc/hostname")),
        os_name: read_os_name(host_root.join("etc/os-release")).or_else(|| read_os_name("/etc/os-release")),
        kernel_version: read_trimmed("/proc/sys/kernel/osrelease"),
        arch: Some(std::env::consts::ARCH.to_string()),
    }
}

fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_os_name(path: impl AsRef<Path>) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            return Some(value.trim_matches('"').to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ping_latency() {
        let out = "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.34 ms";
        assert_eq!(parse_ping_latency(out), Some(12.34));
    }
}

