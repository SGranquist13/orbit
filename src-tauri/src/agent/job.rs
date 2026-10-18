//! Keep agent and command trees tied to Orbit, including after a forced exit.

#[cfg(windows)]
mod windows {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    fn create() -> std::io::Result<OwnedHandle> {
        // Null security attributes make the handle non-inheritable: only Orbit owns it.
        // SAFETY: null attributes and name create an unnamed job with default security.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a new, valid handle owned by this function.
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the buffer has the layout and size required by this information class.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(super) fn job() -> Option<&'static OwnedHandle> {
        // Statics are never dropped. Windows closes this handle when Orbit exits (even
        // taskkill /F), killing all assigned children and their descendants.
        static JOB: OnceLock<Option<OwnedHandle>> = OnceLock::new();
        JOB.get_or_init(|| create().map_err(|e| eprintln!("could not create Orbit child job: {e}")).ok()).as_ref()
    }

    pub(super) fn assign(process: RawHandle) {
        if let Some(job) = job() {
            // Orbit itself stays outside the job so ShellExecute/opener-launched browsers,
            // Explorer and editors survive it. Only agents/git/check commands are assigned;
            // their descendants inherit membership. The small spawn-to-assignment race is
            // accepted rather than creating suspended processes and managing their threads.
            // SAFETY: both handles are live for this call; assignment does not take ownership.
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
                eprintln!("could not assign child to Orbit job: {}", std::io::Error::last_os_error());
            }
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn creates_kill_on_close_job() {
            super::create().expect("Windows child job can be created and configured");
        }
    }
}

pub fn init() {
    #[cfg(windows)]
    let _ = windows::job();
}

pub fn track(child: &tokio::process::Child) {
    #[cfg(windows)]
    if let Some(handle) = child.raw_handle() {
        windows::assign(handle);
    }
    #[cfg(not(windows))]
    let _ = child;
}

pub fn track_std(child: &std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        windows::assign(child.as_raw_handle());
    }
    #[cfg(not(windows))]
    let _ = child;
}
