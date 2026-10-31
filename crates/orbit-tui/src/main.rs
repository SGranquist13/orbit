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
