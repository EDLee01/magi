use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const VERSION: &str = "0.1.0-alpha.0";

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(error) => {
                let _ = write_error(&mut stdout, "null", &format!("stdin read failed: {}", error));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_request(&line);
        let _ = writeln!(stdout, "{}", response);
        let _ = stdout.flush();
    }
}

fn handle_request(line: &str) -> String {
    let id = json_field(line, "id").unwrap_or_else(|| "null".to_string());
    let method = match json_string_field(line, "method") {
        Some(value) => value,
        None => return error_response(&id, "missing method"),
    };

    match method.as_str() {
        "initialize" => result_response(
            &id,
            &format!(
                "{{\"runner\":\"magi-runner\",\"version\":\"{}\",\"capabilities\":[\"ping\",\"echo\",\"process.run\",\"pty.smoke\",\"file.applyPatch\"]}}",
                VERSION
            ),
        ),
        "ping" => result_response(&id, "{\"ok\":true}"),
        "echo" => {
            let text = json_string_field(line, "text")
                .or_else(|| json_nested_string_field(line, "params", "text"))
                .unwrap_or_default();
            result_response(&id, &format!("{{\"text\":\"{}\"}}", escape_json_string(&text)))
        }
        "process.run" => run_process(&id, line),
        "pty.smoke" => run_pty_smoke(&id),
        "file.applyPatch" => apply_file_patch(&id, line),
        _ => error_response(&id, &format!("unknown method: {}", method)),
    }
}

fn run_process(id: &str, line: &str) -> String {
    let command = match json_nested_string_field(line, "params", "command") {
        Some(value) if !value.trim().is_empty() => value,
        _ => return error_response(id, "process.run requires params.command"),
    };
    let cwd = json_nested_string_field(line, "params", "cwd").unwrap_or_else(|| ".".to_string());
    let timeout_ms = json_nested_u64_field(line, "params", "timeoutMs").unwrap_or(30_000);

    let mut child = match shell_command(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return error_response(id, &format!("spawn failed: {}", error)),
    };

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                sleep(Duration::from_millis(10));
            }
            Err(error) => return error_response(id, &format!("wait failed: {}", error)),
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => return error_response(id, &format!("output capture failed: {}", error)),
    };
    let exit_code = match output.status.code() {
        Some(code) => code.to_string(),
        None => "null".to_string(),
    };
    result_response(
        id,
        &format!(
            "{{\"command\":\"{}\",\"cwd\":\"{}\",\"exitCode\":{},\"stdout\":\"{}\",\"stderr\":\"{}\",\"timedOut\":{}}}",
            escape_json_string(&command),
            escape_json_string(&cwd),
            exit_code,
            escape_json_string(&String::from_utf8_lossy(&output.stdout)),
            escape_json_string(&String::from_utf8_lossy(&output.stderr)),
            if timed_out { "true" } else { "false" }
        ),
    )
}

fn run_pty_smoke(id: &str) -> String {
    let output = match pty_smoke_command().output() {
        Ok(output) => output,
        Err(error) => return error_response(id, &format!("pty smoke failed to start: {}", error)),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let ok = stdout.contains("magi-pty-ok");
    result_response(
        id,
        &format!(
            "{{\"ok\":{},\"stdout\":\"{}\",\"stderr\":\"{}\"}}",
            if ok { "true" } else { "false" },
            escape_json_string(&stdout),
            escape_json_string(&stderr)
        ),
    )
}

fn apply_file_patch(id: &str, line: &str) -> String {
    let cwd = json_nested_string_field(line, "params", "cwd").unwrap_or_else(|| ".".to_string());
    let file_path = match json_nested_string_field(line, "params", "filePath") {
        Some(value) if !value.trim().is_empty() => value,
        _ => return error_response(id, "file.applyPatch requires params.filePath"),
    };
    let content = json_nested_string_field(line, "params", "content").unwrap_or_default();
    let approved = json_nested_bool_field(line, "params", "approved").unwrap_or(false);
    if !approved {
        return error_response(id, "file.applyPatch requires approved=true");
    }

    let resolved = match resolve_workspace_path(&cwd, &file_path) {
        Ok(path) => path,
        Err(message) => return error_response(id, &message),
    };
    let before = fs::read_to_string(&resolved).unwrap_or_default();
    let relative = normalize_path_for_json(&file_path);
    let diff = create_unified_diff(&relative, &before, &content);
    if let Some(parent) = resolved.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return error_response(id, &format!("create parent directory failed: {}", error));
        }
    }
    if let Err(error) = fs::write(&resolved, content.as_bytes()) {
        return error_response(id, &format!("write failed: {}", error));
    }

    let audit_event = format!(
        "{{\"action\":\"runner.file.applyPatch\",\"target\":\"{}\",\"metadata\":{{\"path\":\"{}\",\"beforeBytes\":{},\"afterBytes\":{},\"approved\":true}}}}",
        escape_json_string(&relative),
        escape_json_string(&relative),
        before.as_bytes().len(),
        content.as_bytes().len()
    );
    result_response(
        id,
        &format!(
            "{{\"path\":\"{}\",\"diff\":\"{}\",\"approved\":true,\"auditEvent\":{}}}",
            escape_json_string(&relative),
            escape_json_string(&diff),
            audit_event
        ),
    )
}

fn resolve_workspace_path(cwd: &str, file_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(cwd).map_err(|error| format!("cwd cannot be resolved: {}", error))?;
    let candidate = Path::new(cwd).join(file_path);
    if file_path.contains('\0') {
        return Err("file path contains a null byte".to_string());
    }
    let normalized = normalize_path(&candidate);
    if !normalized.starts_with(&root) {
        return Err(format!("{} is outside the workspace", file_path));
    }
    Ok(normalized)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn normalize_path_for_json(file_path: &str) -> String {
    file_path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn create_unified_diff(file_path: &str, before: &str, after: &str) -> String {
    let before_lines = meaningful_lines(before);
    let after_lines = meaningful_lines(after);
    let mut output = vec![
        format!("--- a/{}", file_path),
        format!("+++ b/{}", file_path),
        "@@".to_string(),
    ];
    for line in before_lines {
        output.push(format!("-{}", line));
    }
    for line in after_lines {
        output.push(format!("+{}", line));
    }
    output.push(String::new());
    output.join("\n")
}

fn meaningful_lines(input: &str) -> Vec<&str> {
    let lines: Vec<&str> = input.split('\n').collect();
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            if index == lines.len() - 1 && line.is_empty() {
                None
            } else {
                Some(*line)
            }
        })
        .collect()
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut child = Command::new("cmd");
        child.args(["/C", command]);
        child
    }
    #[cfg(not(windows))]
    {
        let mut child = Command::new("sh");
        child.args(["-lc", command]);
        child
    }
}

fn pty_smoke_command() -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("script");
        command.args(["-q", "/dev/null", "sh", "-lc", "test -t 1 && printf magi-pty-ok"]);
        command
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("script");
        command.args(["-q", "-c", "test -t 1 && printf magi-pty-ok", "/dev/null"]);
        command
    }
    #[cfg(not(unix))]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "echo pty unsupported"]);
        command
    }
}

fn result_response(id: &str, result: &str) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}", id, result)
}

fn error_response(id: &str, message: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"message\":\"{}\"}}}}",
        id,
        escape_json_string(message)
    )
}

fn write_error(stdout: &mut io::Stdout, id: &str, message: &str) -> io::Result<()> {
    writeln!(stdout, "{}", error_response(id, message))?;
    stdout.flush()
}

fn json_string_field(input: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", key);
    let key_pos = input.find(&marker)?;
    let after_key = &input[key_pos + marker.len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = after_key[colon_pos + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    read_json_string(after_colon)
}

fn json_nested_string_field(input: &str, parent: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", parent);
    let parent_pos = input.find(&marker)?;
    let after_parent = &input[parent_pos + marker.len()..];
    json_string_field(after_parent, key)
}

fn json_nested_u64_field(input: &str, parent: &str, key: &str) -> Option<u64> {
    let marker = format!("\"{}\"", parent);
    let parent_pos = input.find(&marker)?;
    let after_parent = &input[parent_pos + marker.len()..];
    json_u64_field(after_parent, key)
}

fn json_nested_bool_field(input: &str, parent: &str, key: &str) -> Option<bool> {
    let marker = format!("\"{}\"", parent);
    let parent_pos = input.find(&marker)?;
    let after_parent = &input[parent_pos + marker.len()..];
    match json_field(after_parent, key)?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn json_field(input: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", key);
    let key_pos = input.find(&marker)?;
    let after_key = &input[key_pos + marker.len()..];
    let colon_pos = after_key.find(':')?;
    let mut value = String::new();
    for ch in after_key[colon_pos + 1..].trim_start().chars() {
        if ch == ',' || ch == '}' || ch.is_whitespace() {
            break;
        }
        value.push(ch);
    }
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn json_u64_field(input: &str, key: &str) -> Option<u64> {
    json_field(input, key)?.parse::<u64>().ok()
}

fn read_json_string(input: &str) -> Option<String> {
    let mut escaped = false;
    let mut value = String::new();
    for ch in input[1..].chars() {
        if escaped {
            value.push(match ch {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(value);
        }
        value.push(ch);
    }
    None
}

fn escape_json_string(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
