use orbit_proto::{read_local_config, Client, ConfigError, ConnectError};
use orbit_tui::app::App;
use orbit_tui::backend::{Backend, LiveBackend};
use orbit_tui::demo::DemoBackend;
use orbit_tui::{cli, runtime};
use std::process::ExitCode;
use std::sync::Arc;

const NOT_RUNNING: &str = "Orbit isn't running. Start the desktop app, then run orb again.\n(Or try `orb --demo`.)";

#[tokio::main]
async fn main() -> ExitCode {
    let args = match cli::parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("orb: {e}\n\n{}", cli::HELP);
            return ExitCode::from(2);
        }
    };
    if args.help {
        println!("{}", cli::HELP);
        return ExitCode::SUCCESS;
    }
    if args.version {
        println!("orb {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let now = runtime::now_ms();
    if args.doctor && !args.demo {
        return doctor_live().await;
    }
    let backend: Arc<dyn Backend> = if args.demo {
        Arc::new(DemoBackend::new(now, !args.ls))
    } else {
        let cfg = match read_local_config() {
            Ok(c) => c,
            Err(ConfigError::Missing(_)) => {
                eprintln!("{NOT_RUNNING}");
                return ExitCode::FAILURE;
            }
            Err(e) => {
                eprintln!("orb: {e}");
                return ExitCode::FAILURE;
            }
        };
        match Client::connect_local(cfg).await {
            Ok((client, pushes)) => Arc::new(LiveBackend::new(client, pushes)),
            Err(ConnectError::NotRunning) => {
                eprintln!("{NOT_RUNNING}");
                return ExitCode::FAILURE;
            }
            Err(e) => {
                eprintln!("orb: {e}");
                return ExitCode::FAILURE;
            }
        }
    };
    if args.doctor {
        let (report, ok) = cli::doctor(backend.as_ref()).await;
        println!("{}\n{report}", cli::check_line(true, "backend", "built-in demo data"));
        return if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    if args.ls {
        return match cli::ls(backend.as_ref(), args.json, now).await {
            Ok(out) => {
                print!("{out}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("orb: {e}");
                ExitCode::FAILURE
            }
        };
    }
    let (cfg, theme) = cli::config(&args, &cli::load_settings());
    let mut app = App::new(cfg, theme, now);
    app.open_target = args.workspace.clone();
    match runtime::run(backend, app).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("orb: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `orb doctor` against the app: the connection steps first, each with what to do if it fails.
async fn doctor_live() -> ExitCode {
    let line = |ok, what, detail: &str| println!("{}", cli::check_line(ok, what, detail));
    let path = orbit_proto::client::orbit_home().map(|h| h.join("local.json"));
    let shown = path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "~/.orbit/local.json".into());
    let cfg = match read_local_config() {
        Ok(c) => {
            let from_env = std::env::var("ORBIT_LOCAL_PORT").is_ok();
            let src = if from_env { "ORBIT_LOCAL_PORT / ORBIT_LOCAL_TOKEN".to_string() } else { shown.clone() };
            let app = c.version.clone().map(|v| format!(", app {v}")).unwrap_or_default();
            let pid = c.pid.map(|p| format!(", pid {p}")).unwrap_or_default();
            line(true, "local.json", &format!("{src} (port {}{app}{pid})", c.port));
            c
        }
        Err(ConfigError::Missing(_)) => {
            line(false, "local.json", &format!("{shown} not found"));
            println!("\n  Start the desktop app (built from a version with the local listener: 0.5+ or this branch), then run orb doctor again.");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            line(false, "local.json", &e.to_string());
            return ExitCode::FAILURE;
        }
    };
    let port = cfg.port;
    match Client::connect_local(cfg).await {
        Ok((client, pushes)) => {
            line(
                true,
                "connect",
                &format!("ws://127.0.0.1:{port}/v1 · protocol 2 · {} {}", client.server_name, client.server_version),
            );
            let backend = LiveBackend::new(client, pushes);
            let (report, ok) = cli::doctor(&backend).await;
            println!("{report}");
            if ok {
                println!("\nAll good. Run orb to open the UI.");
                ExitCode::SUCCESS
            } else {
                println!("\nSomething above failed: send this output along with the app version.");
                ExitCode::FAILURE
            }
        }
        Err(ConnectError::NotRunning) => {
            line(false, "connect", &format!("nothing answers on 127.0.0.1:{port}"));
            println!(
                "\n  local.json is left over from an app that has quit. Start Orbit again (it writes a fresh one)."
            );
            ExitCode::FAILURE
        }
        Err(ConnectError::BadToken) => {
            line(false, "connect", "the app refused the token in local.json");
            println!("\n  Two copies of Orbit may be running, or ORBIT_HOME differs between them and orb. Quit Orbit, start it again.");
            ExitCode::FAILURE
        }
        Err(e) => {
            line(false, "connect", &e.to_string());
            ExitCode::FAILURE
        }
    }
}
